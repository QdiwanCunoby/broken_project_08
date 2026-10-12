// Unit test AccountService: il repository è un mock iniettato nel costruttore (nessun DB, nessun jest.mock di moduli).
// Pattern AAA: Arrange (dati + mock) → Act (una chiamata al service) → Assert (risultato + interazioni col repo).
import { AccountService } from "./account.service";
import { IAccountRepository } from "./account.repository";
import { Account, AccountStatus, AccountType, CreateAccountDto } from "./account.types";
import { ConflictError, NotFoundError } from "../../utils/errors";

const ACCOUNT_ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const OWNER_ID = "0b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const buildAccount = (overrides: Partial<Account> = {}): Account => ({
  id: ACCOUNT_ID,
  ownerId: OWNER_ID,
  iban: "IT60X0542811101000000123456",
  type: AccountType.CHECKING,
  balance: "1000.00",
  status: AccountStatus.ACTIVE,
  createdAt: new Date("2026-01-15T10:00:00.000Z"),
  updatedAt: new Date("2026-01-15T10:00:00.000Z"),
  ...overrides,
});

// jest.Mocked<IAccountRepository>: ogni metodo è un jest.Mock tipizzato con la firma originale
const createMockRepo = (): jest.Mocked<IAccountRepository> => ({
  findAll: jest.fn(),
  findPaginated: jest.fn(),
  findById: jest.fn(),
  findByIban: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
});

describe("AccountService", () => {
  let mockRepo: jest.Mocked<IAccountRepository>;
  let service: AccountService;

  beforeEach(() => {
    mockRepo = createMockRepo();
    service = new AccountService(mockRepo);
  });

  describe("getAccountById", () => {
    it("con ID esistente ritorna l'Account del repository", async () => {
      // Arrange
      const account = buildAccount();
      mockRepo.findById.mockResolvedValue(account);

      // Act
      const result = await service.getAccountById(ACCOUNT_ID);

      // Assert
      expect(result).toEqual(account);
      expect(mockRepo.findById).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    it("con ID inesistente lancia NotFoundError", async () => {
      // Arrange
      mockRepo.findById.mockResolvedValue(null);

      // Act
      const act = service.getAccountById("id-che-non-esiste");

      // Assert
      await expect(act).rejects.toBeInstanceOf(NotFoundError);
      await expect(act).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    });
  });

  describe("createAccount", () => {
    it("il repository riceve l'account con tutti i campi corretti", async () => {
      // Arrange
      const dto: CreateAccountDto = {
        ownerId: OWNER_ID,
        iban: "IT28W8000000292100645211208",
        type: AccountType.SAVINGS,
        initialBalance: 250,
      };
      mockRepo.findByIban.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(buildAccount({ iban: dto.iban, type: dto.type, balance: "250.00" }));

      // Act
      const result = await service.createAccount(dto);

      // Assert: il "save" del nostro repository è create(dto)
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      expect(mockRepo.create).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        iban: "IT28W8000000292100645211208",
        type: AccountType.SAVINGS,
        initialBalance: 250,
      });
      expect(result.balance).toBe("250.00");
    });

    it("IBAN già registrato → ConflictError e nessun salvataggio", async () => {
      // Arrange
      mockRepo.findByIban.mockResolvedValue(buildAccount());

      // Act
      const act = service.createAccount({
        ownerId: OWNER_ID, iban: "IT60X0542811101000000123456", type: AccountType.CHECKING, initialBalance: 0,
      });

      // Assert
      await expect(act).rejects.toBeInstanceOf(ConflictError);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });

  describe("deleteAccount", () => {
    it("chiama il repository una volta con l'id giusto", async () => {
      // Arrange
      mockRepo.delete.mockResolvedValue(true);

      // Act
      await service.deleteAccount(ACCOUNT_ID);

      // Assert
      expect(mockRepo.delete).toHaveBeenCalledTimes(1);
      expect(mockRepo.delete).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    it("id inesistente → NotFoundError", async () => {
      mockRepo.delete.mockResolvedValue(false);
      await expect(service.deleteAccount(ACCOUNT_ID)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("listAccounts — meta di paginazione (Bug 2 G8)", () => {
    const page = (n: number, limit: number) => ({ page: n, limit });

    it("25 righe, limit 10, pagina 3 → totalPages 3 (Math.ceil), hasNext false, hasPrev true", async () => {
      // Arrange: il repo restituisce le 5 righe dell'ultima pagina e il totale dell'intero dataset
      mockRepo.findPaginated.mockResolvedValue({ items: Array.from({ length: 5 }, () => buildAccount()), total: 25 });

      // Act
      const result = await service.listAccounts(page(3, 10));

      // Assert
      expect(result.meta).toEqual({ page: 3, limit: 10, total: 25, totalPages: 3, hasNext: false, hasPrev: true });
      expect(result.data).toHaveLength(5);
      expect(mockRepo.findPaginated).toHaveBeenCalledWith({ page: 3, limit: 10 });
    });

    it("pagina 1 di 3 → hasNext true, hasPrev false; total è quello del repo, non data.length", async () => {
      mockRepo.findPaginated.mockResolvedValue({ items: Array.from({ length: 10 }, () => buildAccount()), total: 25 });

      const { meta } = await service.listAccounts(page(1, 10));

      expect(meta).toMatchObject({ total: 25, totalPages: 3, hasNext: true, hasPrev: false });
    });

    it("dataset vuoto → totalPages 0, nessuna pagina successiva", async () => {
      mockRepo.findPaginated.mockResolvedValue({ items: [], total: 0 });

      const { meta } = await service.listAccounts(page(1, 20));

      expect(meta).toMatchObject({ total: 0, totalPages: 0, hasNext: false, hasPrev: false });
    });
  });

  describe("updateAccount", () => {
    it("updateAccount passa id e dto al repository; se non trova → NotFoundError", async () => {
      const blocked = buildAccount({ status: AccountStatus.BLOCKED });
      mockRepo.update.mockResolvedValueOnce(blocked).mockResolvedValueOnce(null);

      await expect(service.updateAccount(ACCOUNT_ID, { status: AccountStatus.BLOCKED })).resolves.toEqual(blocked);
      expect(mockRepo.update).toHaveBeenCalledWith(ACCOUNT_ID, { status: AccountStatus.BLOCKED });
      await expect(service.updateAccount(ACCOUNT_ID, { status: AccountStatus.BLOCKED })).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

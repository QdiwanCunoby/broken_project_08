// Repository: unico punto che sa DOVE stanno i dati. Due implementazioni della stessa interfaccia:
// InMemoryAccountRepository (G2-G4) e PrismaAccountRepository (G5): si scambiano nel composition root.
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, Account as AccountRow } from "@prisma/client";
import { ConflictError } from "../../utils/errors";
import { isPrismaError } from "../../utils/prismaErrors";
import { Account, AccountFilter, AccountStatus, CreateAccountDto, UpdateAccountDto } from "./account.types";

// Una pagina di risultati + il totale delle righe che rispettano il filtro (sull'intero dataset)
export interface AccountPage { items: Account[]; total: number }

export interface IAccountRepository {
  findAll(): Promise<Account[]>;
  findPaginated(filter: AccountFilter): Promise<AccountPage>;
  findById(id: string): Promise<Account | null>;
  findByIban(iban: string): Promise<Account | null>;
  create(dto: CreateAccountDto): Promise<Account>;
  update(id: string, dto: UpdateAccountDto): Promise<Account | null>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryAccountRepository implements IAccountRepository {
  private accounts: Account[] = [];

  async findAll(): Promise<Account[]> { return [...this.accounts]; }

  async findPaginated(filter: AccountFilter): Promise<AccountPage> {
    const matching = this.accounts.filter(a =>
      (!filter.status || a.status === filter.status) &&
      (!filter.type || a.type === filter.type) &&
      (!filter.ownerId || a.ownerId === filter.ownerId));
    const start = (filter.page - 1) * filter.limit;
    return { items: matching.slice(start, start + filter.limit), total: matching.length };
  }

  async findById(id: string): Promise<Account | null> {
    return this.accounts.find(a => a.id === id) ?? null;
  }

  async findByIban(iban: string): Promise<Account | null> {
    return this.accounts.find(a => a.iban === iban) ?? null;
  }

  async create(dto: CreateAccountDto): Promise<Account> {
    const { initialBalance, ...data } = dto;
    const account: Account = {
      id: randomUUID(), ...data,
      balance: initialBalance.toFixed(2),
      status: AccountStatus.ACTIVE, createdAt: new Date(), updatedAt: new Date(),
    };
    this.accounts.push(account);
    return account;
  }

  async update(id: string, dto: UpdateAccountDto): Promise<Account | null> {
    const index = this.accounts.findIndex(a => a.id === id);
    if (index === -1) return null;
    // Scarta i campi undefined: altrimenti lo spread cancellerebbe i valori esistenti
    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    this.accounts[index] = { ...this.accounts[index], ...changes };
    return this.accounts[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.accounts.findIndex(a => a.id === id);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    return true;
  }
}

// Riga Prisma → tipo di dominio: il Decimal esce come stringa ("1000.00"), l'enum Prisma ha gli stessi valori
const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  ownerId: row.ownerId,
  iban: row.iban,
  type: row.type as Account["type"],
  balance: row.balance.toFixed(2),
  status: row.status as AccountStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Filtri opzionali → where Prisma (i campi assenti non filtrano)
const buildAccountWhere = (filter: AccountFilter): Prisma.AccountWhereInput => ({
  ...(filter.status ? { status: filter.status } : {}),
  ...(filter.type ? { type: filter.type } : {}),
  ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
});

export class PrismaAccountRepository implements IAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toAccount);
  }

  async findPaginated(filter: AccountFilter): Promise<AccountPage> {
    const where = buildAccountWhere(filter);
    // Pagina e totale nella STESSA transazione e con lo STESSO where: il total è il conteggio dell'intero dataset
    // filtrato (non data.length, che è al massimo `limit`) e non può "slittare" per un insert concorrente tra le due query.
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.account.findMany({
        where,
        // Ordine TOTALE: createdAt da solo ha duplicati (createMany inserisce N righe con lo stesso now()),
        // e con un ordine non deterministico Postgres può ripetere/saltare righe tra una pagina e l'altra.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
      this.prisma.account.count({ where }),
    ]);
    return { items: rows.map(toAccount), total };
  }

  async findById(id: string): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({ where: { id } });
    return row && toAccount(row);
  }

  async findByIban(iban: string): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({ where: { iban } });
    return row && toAccount(row);
  }

  async create(dto: CreateAccountDto): Promise<Account> {
    const { initialBalance, ...data } = dto;
    try {
      const row = await this.prisma.account.create({
        data: { ...data, balance: new Prisma.Decimal(initialBalance) },
      });
      return toAccount(row);
    } catch (e) {
      // ownerId che non esiste: la FK lo rifiuta
      if (isPrismaError(e, "P2003")) throw new ConflictError("ownerId non corrisponde a nessun cliente");
      if (isPrismaError(e, "P2002")) throw new ConflictError("IBAN già registrato");   // race tra check e insert
      throw e;
    }
  }

  async update(id: string, dto: UpdateAccountDto): Promise<Account | null> {
    try {
      // I campi undefined sono ignorati da Prisma: non serve filtrarli
      const row = await this.prisma.account.update({ where: { id }, data: dto });
      return toAccount(row);
    } catch (e) {
      if (isPrismaError(e, "P2025")) return null;   // record non trovato
      if (isPrismaError(e, "P2003")) throw new ConflictError("ownerId non corrisponde a nessun cliente");
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.account.delete({ where: { id } });
      return true;
    } catch (e) {
      if (isPrismaError(e, "P2025")) return false;
      // onDelete: Restrict — un conto con bonifici registrati non si cancella (si chiude: status CLOSED)
      if (isPrismaError(e, "P2003")) throw new ConflictError("Il conto ha bonifici registrati: chiudilo invece di eliminarlo");
      throw e;
    }
  }
}

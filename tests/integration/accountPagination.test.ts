// Bug 2 G8 — paginazione offset-based di GET /api/accounts su Postgres reale
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, prisma } from "../../src/app";
import { authCookie } from "../helpers/auth";
import { migrateTestDatabase, truncateAll } from "../helpers/db";

const COOKIE = authCookie(randomUUID());
// IBAN italiano valido per lo schema: IT + 2 cifre + lettera + 22 cifre
const ibanFor = (n: number) => `IT00X${String(n).padStart(22, "0")}`;

describe("GET /api/accounts — paginazione (integration)", () => {
  let ownerId: string;

  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    const owner = await prisma.customer.create({
      data: { fiscalCode: "RSSMRA80A01H501U", firstName: "Mario", lastName: "Rossi", email: "mario.rossi@example.com", phone: "+39 333 1234567" },
    });
    ownerId = owner.id;
    // 25 righe con UN solo insert: hanno tutte lo stesso created_at → serve l'id come secondo criterio di ordinamento
    await prisma.account.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        ownerId, iban: ibanFor(i + 1), type: i % 5 === 0 ? "SAVINGS" as const : "CHECKING" as const, balance: "100.00",
      })),
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const list = (query: string) => request(app).get(`/api/accounts?${query}`).set("Cookie", COOKIE);

  it("pagina 3 con limit 10 → 5 righe, total 25, totalPages 3, hasNext false, hasPrev true", async () => {
    const res = await list("page=3&limit=10").expect(200);

    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta).toEqual({ page: 3, limit: 10, total: 25, totalPages: 3, hasNext: false, hasPrev: true });
  });

  it("pagina 1 → hasNext true, hasPrev false; total è l'intero dataset (non la lunghezza della pagina)", async () => {
    const res = await list("page=1&limit=10").expect(200);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.meta).toMatchObject({ total: 25, totalPages: 3, hasNext: true, hasPrev: false });
  });

  it("scorrendo tutte le pagine si vedono le 25 righe una sola volta (ordine deterministico)", async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await list(`page=${page}&limit=10`).expect(200);
      ids.push(...res.body.data.map((a: { id: string }) => a.id));
    }

    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it("il filtro vale sia per la pagina sia per il total (stesso where)", async () => {
    const res = await list("type=SAVINGS&limit=2").expect(200);

    // i = 0, 5, 10, 15, 20 → 5 conti SAVINGS
    expect(res.body.meta).toMatchObject({ total: 5, totalPages: 3, hasNext: true });
    expect(res.body.data.every((a: { type: string }) => a.type === "SAVINGS")).toBe(true);
  });

  it("default page=1, limit=20; pagina oltre la fine → data vuoto, hasNext false", async () => {
    expect((await list("").expect(200)).body.meta).toMatchObject({ page: 1, limit: 20, totalPages: 2 });

    const beyond = await list("page=9&limit=10").expect(200);
    expect(beyond.body.data).toHaveLength(0);
    expect(beyond.body.meta).toMatchObject({ hasNext: false, hasPrev: true });
  });

  it("query non valida → 422 (page 0, limit oltre 100, status sconosciuto)", async () => {
    for (const q of ["page=0", "limit=101", "status=FROZEN", "page=abc"]) {
      const res = await list(q);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

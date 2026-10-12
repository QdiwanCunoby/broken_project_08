// Feature G8 — GET /api/transactions con cursor-based pagination, su Postgres reale
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, prisma } from "../../src/app";
import { authCookie } from "../helpers/auth";
import { migrateTestDatabase, truncateAll } from "../helpers/db";

const COOKIE = authCookie(randomUUID());
const BASE = new Date("2026-10-01T10:00:00.000Z").getTime();

interface Page { data: Array<{ id: string; createdAt: string; amount: string }>; nextCursor: string | null; hasNext: boolean }

describe("GET /api/transactions — cursor pagination (integration)", () => {
  let fromId: string;
  let toId: string;

  // n movimenti, il più recente per primo; `sameInstant` = tutti con lo stesso createdAt (test dello spareggio su id)
  const seedTransfers = async (n: number, { offsetSec = 0, sameInstant = false } = {}) => {
    await prisma.transfer.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        fromAccountId: fromId,
        toAccountId: toId,
        amount: `${i + 1}.00`,
        status: "COMPLETED" as const,
        createdAt: new Date(BASE + (sameInstant ? 0 : (offsetSec + i) * 1000)),
      })),
    });
  };

  const page = async (query: string): Promise<Page> =>
    (await request(app).get(`/api/transactions?${query}`).set("Cookie", COOKIE).expect(200)).body;

  // Scorre tutte le pagine come farebbe useInfiniteQuery con getNextPageParam: last => last.nextCursor
  const readAll = async (take: number, extra = "") => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Page = await page(`take=${take}${cursor ? `&cursor=${cursor}` : ""}${extra}`);
      ids.push(...p.data.map(t => t.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    return { ids, pages };
  };

  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    const owner = await prisma.customer.create({
      data: { fiscalCode: "RSSMRA80A01H501U", firstName: "Mario", lastName: "Rossi", email: "mario.rossi@example.com", phone: "+39 333 1234567" },
    });
    const [a, b] = await Promise.all([
      prisma.account.create({ data: { ownerId: owner.id, iban: "IT60X0542811101000000123456", type: "CHECKING", balance: "1000.00" } }),
      prisma.account.create({ data: { ownerId: owner.id, iban: "IT28W8000000292100645211208", type: "SAVINGS" } }),
    ]);
    fromId = a.id;
    toId = b.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prima pagina senza cursor → i 20 più recenti, ordinati per createdAt desc, nextCursor = ultimo id", async () => {
    await seedTransfers(45);

    const p = await page("take=20");

    expect(p.data).toHaveLength(20);
    expect(p.hasNext).toBe(true);
    expect(p.nextCursor).toBe(p.data[19].id);
    const times = p.data.map(t => Date.parse(t.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(p.data[0].amount).toBe("45.00");   // il più recente; Decimal serializzato come stringa
  });

  it("seguendo nextCursor si leggono tutti i 45 movimenti una sola volta: 20 + 20 + 5, poi nextCursor null", async () => {
    await seedTransfers(45);

    const { ids, pages } = await readAll(20);

    expect(pages).toBe(3);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
  });

  it("movimenti nuovi arrivati tra pagina 1 e 2: con il cursor nessun duplicato, con l'offset sì", async () => {
    await seedTransfers(30);
    const first = await page("take=10");

    // Nel frattempo arrivano 5 bonifici nuovi (più recenti di tutto)
    await seedTransfers(5, { offsetSec: 1000 });

    const byCursor = await page(`take=10&cursor=${first.nextCursor}`);
    const offsetPage2 = await prisma.transfer.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: 10, take: 10,
    });

    const seen = new Set(first.data.map(t => t.id));
    expect(byCursor.data.filter(t => seen.has(t.id))).toHaveLength(0);       // cursor: 0 righe ripetute
    expect(offsetPage2.filter(t => seen.has(t.id))).toHaveLength(5);          // offset: le 5 righe "scalate" si ripetono
  });

  it("molti movimenti nello stesso istante: lo spareggio su id non salta né ripete righe", async () => {
    await seedTransfers(12, { sameInstant: true });

    const { ids } = await readAll(5);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("esattamente `take` movimenti → hasNext false al primo colpo (niente richiesta di una pagina vuota)", async () => {
    await seedTransfers(20);

    const p = await page("take=20");

    expect(p.data).toHaveLength(20);
    expect(p).toMatchObject({ hasNext: false, nextCursor: null });
  });

  it("nessun movimento → data vuoto, nextCursor null", async () => {
    expect(await page("")).toEqual({ data: [], nextCursor: null, hasNext: false });
  });

  it("accountId filtra i movimenti in entrata e in uscita di quel conto", async () => {
    await seedTransfers(3);
    const other = await prisma.account.create({ data: { ownerId: (await prisma.customer.findFirstOrThrow()).id, iban: "IT02A0300203280000400162854", type: "CHECKING" } });
    await prisma.transfer.create({ data: { fromAccountId: other.id, toAccountId: fromId, amount: "9.00", status: "COMPLETED" } });

    expect((await page(`accountId=${toId}`)).data).toHaveLength(3);      // solo in entrata
    expect((await page(`accountId=${fromId}`)).data).toHaveLength(4);    // 3 in uscita + 1 in entrata
    expect((await page(`accountId=${other.id}`)).data).toHaveLength(1);
  });

  it("query non valida → 422: take 0, take 51, cursor non UUID; senza login → 401", async () => {
    for (const q of ["take=0", "take=51", "cursor=abc", "take=dieci"]) {
      const res = await request(app).get(`/api/transactions?${q}`).set("Cookie", COOKIE);
      expect(res.status).toBe(422);
    }
    await request(app).get("/api/transactions").expect(401);
  });
});

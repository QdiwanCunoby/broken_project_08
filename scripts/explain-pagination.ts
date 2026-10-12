// Confronto dei piani di esecuzione: OFFSET 50000 vs cursor (keyset) sulla tabella transfers.
// Gira sul Postgres di TEST (.env.test), in uno schema dedicato "explain" che viene ricreato a ogni esecuzione.
//   npm run db:test:up && npm run explain:pagination
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ROWS = 100_000;
const OFFSET = 50_000;
const TAKE = 20;

const vars = parseEnv(fs.readFileSync(path.resolve(__dirname, "../.env.test"), "utf8")) as Record<string, string | undefined>;
const url = new URL(process.env.DATABASE_URL ?? vars.DATABASE_URL!);
url.searchParams.set("schema", "explain");
if (!/test/i.test(url.pathname)) throw new Error(`Rifiuto di girare su ${url.pathname}: solo database di test`);
const DATABASE_URL = url.toString();

const plan = async (prisma: PrismaClient, title: string, sql: string) => {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  console.log(`\n━━━ ${title} ━━━\n${sql}\n`);
  for (const r of rows) console.log(r["QUERY PLAN"]);
};

async function main() {
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL }, stdio: "inherit" });
  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "transfers", "refresh_tokens", "users", "accounts", "customers" CASCADE');
    const owner = await prisma.customer.create({
      data: { fiscalCode: "RSSMRA80A01H501U", firstName: "Mario", lastName: "Rossi", email: "mario@example.com", phone: "+39 333 1234567" },
    });
    const from = await prisma.account.create({ data: { ownerId: owner.id, iban: "IT60X0542811101000000123456", type: "CHECKING" } });
    const to = await prisma.account.create({ data: { ownerId: owner.id, iban: "IT28W8000000292100645211208", type: "SAVINGS" } });

    console.log(`Inserimento di ${ROWS} movimenti...`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "transfers" (id, from_account_id, to_account_id, amount, status, executed_at, created_at)
      SELECT gen_random_uuid(), '${from.id}', '${to.id}', 1.00, 'COMPLETED'::"transfer_status", now(),
             now() - (g || ' seconds')::interval
      FROM generate_series(1, ${ROWS}) AS g`);
    await prisma.$executeRawUnsafe('ANALYZE "transfers"');

    // Il cursore = l'ultima riga di "pagina 2500": la stessa posizione dell'OFFSET
    const [cursor] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "transfers" ORDER BY created_at DESC, id DESC OFFSET ${OFFSET - 1} LIMIT 1`);

    await plan(prisma, `OFFSET ${OFFSET} (paginazione offset)`,
      `SELECT * FROM "transfers" ORDER BY created_at DESC, id DESC OFFSET ${OFFSET} LIMIT ${TAKE}`);

    // Forma "keyset" equivalente a ciò che fa Prisma con cursor + orderBy [createdAt desc, id desc]
    await plan(prisma, "CURSOR (paginazione keyset)",
      `SELECT * FROM "transfers"
       WHERE (created_at, id) < (SELECT created_at, id FROM "transfers" WHERE id = '${cursor.id}')
       ORDER BY created_at DESC, id DESC LIMIT ${TAKE + 1}`);

    // Senza indice adatto all'ordinamento l'offset diventa Seq Scan + Sort su tutta la tabella
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "transfers_created_at_id_idx"');
    await plan(prisma, `OFFSET ${OFFSET} SENZA indice (created_at, id)`,
      `SELECT * FROM "transfers" ORDER BY created_at DESC, id DESC OFFSET ${OFFSET} LIMIT ${TAKE}`);
    await prisma.$executeRawUnsafe('CREATE INDEX "transfers_created_at_id_idx" ON "transfers"("created_at" DESC, "id" DESC)');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });

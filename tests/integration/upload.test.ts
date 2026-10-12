// Bug 3 G8 — upload sicuro: POST /api/documents (multipart, campo "file")
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, prisma } from "../../src/app";
import { MAX_FILE_SIZE, UPLOAD_DIR } from "../../src/middleware/upload";
import { authCookie } from "../helpers/auth";

const COOKIE = authCookie(randomUUID());
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$/;

// Contenuti minimi con i magic bytes giusti
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("1 0 obj << >> endobj\n%%EOF\n")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);   // header PE/DOS

const uploadedFiles = () => (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []);

const send = (content: Buffer, filename: string, contentType: string) =>
  request(app).post("/api/documents").set("Cookie", COOKIE).attach("file", content, { filename, contentType });

describe("POST /api/documents — upload sicuro (integration)", () => {
  beforeEach(() => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  afterAll(async () => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("filename con path traversal → 201, salvato DENTRO UPLOAD_DIR con nome UUID.pdf", async () => {
    const res = await send(PDF, "../../../etc/passwd.pdf", "application/pdf");

    expect(res.status).toBe(201);
    expect(res.body.data.fileName).toMatch(UUID_FILE);
    expect(res.body.data).toMatchObject({ mimeType: "application/pdf", size: PDF.length });
    expect(uploadedFiles()).toEqual([res.body.data.fileName]);
    // Nulla è finito fuori dalla cartella prevista
    expect(fs.existsSync(path.resolve(UPLOAD_DIR, "../../../etc/passwd.pdf"))).toBe(false);
    expect(fs.existsSync(path.resolve(UPLOAD_DIR, "..", "passwd.pdf"))).toBe(false);
  });

  it("due clienti caricano 'estratto.pdf' → due file distinti, nessuna sovrascrittura", async () => {
    const a = await send(PDF, "estratto.pdf", "application/pdf").expect(201);
    const b = await send(PDF, "estratto.pdf", "application/pdf").expect(201);

    expect(a.body.data.fileName).not.toBe(b.body.data.fileName);
    expect(uploadedFiles().sort()).toEqual([a.body.data.fileName, b.body.data.fileName].sort());
  });

  it("l'estensione viene dal MIME in whitelist, non dal nome: 'foto.exe' dichiarato image/png → .png", async () => {
    const res = await send(PNG, "foto.exe", "image/png").expect(201);
    expect(res.body.data.fileName).toMatch(/\.png$/);
  });

  it("MIME non in whitelist (application/x-msdownload) → 415, nessun file su disco", async () => {
    const res = await send(EXE, "setup.exe", "application/x-msdownload");

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(uploadedFiles()).toEqual([]);
  });

  it(".exe mascherato da PDF (nome .pdf + MIME application/pdf, contenuto MZ) → 415 e file cancellato", async () => {
    const res = await send(EXE, "estratto-conto.pdf", "application/pdf");

    expect(res.status).toBe(415);
    expect(res.body.error.message).toMatch(/contenuto/);
    expect(uploadedFiles()).toEqual([]);
  });

  it("file oltre 5 MB → 413 PAYLOAD_TOO_LARGE, nessun file parziale su disco", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_SIZE)]);

    const res = await send(big, "grande.pdf", "application/pdf");

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(uploadedFiles()).toEqual([]);
  });

  it("nessun file → 422; senza login → 401", async () => {
    const empty = await request(app).post("/api/documents").set("Cookie", COOKIE).field("note", "niente");
    expect(empty.status).toBe(422);

    await request(app).post("/api/documents").attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" }).expect(401);
  });

  it("due file nello stesso campo → 400 UPLOAD_ERROR (limits.files = 1)", async () => {
    const res = await request(app)
      .post("/api/documents")
      .set("Cookie", COOKIE)
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" })
      .attach("file", PDF, { filename: "b.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UPLOAD_ERROR");
  });
});

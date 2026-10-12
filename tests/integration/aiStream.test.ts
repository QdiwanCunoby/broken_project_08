// Bug 1 G8 — proxy SSE: quando il client si disconnette, la connessione verso il servizio AI deve chiudersi subito.
// È la versione automatica del controllo con `lsof -p <pid>`: un finto FastAPI conta i socket aperti verso di lui.
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createApp, prisma } from "../../src/app";
import { generateTestToken } from "../helpers/auth";

const COOKIE = `access_token=${generateTestToken(randomUUID())}`;

// ─── Finto servizio AI: risponde in SSE con un token ogni 50ms per ~10s (un LLM "lento") ───
interface FakeAi {
  url: string;
  openSockets: () => number;
  upstreamClosedAt: () => number | undefined;   // istante in cui lo stream si è chiuso PRIMA della fine
  close: () => Promise<void>;
}

const startFakeAi = (mode: "slow" | "short" | "error" = "slow"): Promise<FakeAi> =>
  new Promise(resolve => {
    let open = 0;
    let closedAt: number | undefined;
    const sockets = new Set<import("node:net").Socket>();

    const server = http.createServer((req, res) => {
      if (mode === "error") {
        res.writeHead(500).end("LLM esploso");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const total = mode === "short" ? 3 : 200;
      const timer = setInterval(() => {
        res.write(`data: token${i++}\n\n`);
        if (i === total) { clearInterval(timer); res.end(); }
      }, mode === "short" ? 5 : 50);
      res.on("close", () => {
        clearInterval(timer);
        if (!res.writableFinished) closedAt = Date.now();   // chiusa PRIMA della fine dello stream
      });
    });

    server.on("connection", socket => {
      open++;
      sockets.add(socket);
      socket.on("close", () => { open--; sockets.delete(socket); });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        openSockets: () => open,
        upstreamClosedAt: () => closedAt,
        close: () => new Promise(done => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
      });
    });
  });

// L'app deve ascoltare su una porta vera: serve una connessione TCP che il "browser" possa troncare
const listen = (app: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise(resolve => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });

const postStream = (url: string, body: object, headers: Record<string, string> = { Cookie: COOKIE }) =>
  fetch(`${url}/api/ai/stream`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /api/ai/stream — proxy SSE", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const setup = async (mode: "slow" | "short" | "error" = "slow") => {
    const ai = await startFakeAi(mode);
    const api = await listen(createApp({ aiServiceUrl: ai.url }));
    cleanups.push(ai.close, api.close);
    return { ai, api };
  };

  it("client che chiude dopo il primo token → la connessione verso il servizio AI si chiude entro 1s", async () => {
    const { ai, api } = await setup("slow");

    // "Browser": apre lo stream, riceve il primo token, poi chiude il tab (socket distrutto)
    const { statusCode, contentType, destroyedAt } = await new Promise<{ statusCode?: number; contentType?: string; destroyedAt: number }>(
      (resolve, reject) => {
        const req = http.request(`${api.url}/api/ai/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: COOKIE },
        }, res => {
          res.once("data", () => {
            req.destroy();
            resolve({ statusCode: res.statusCode, contentType: res.headers["content-type"], destroyedAt: Date.now() });
          });
        });
        req.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
        req.end(JSON.stringify({ message: "Qual è il mio saldo?" }));
      },
    );
    expect(statusCode).toBe(200);
    expect(contentType).toMatch(/text\/event-stream/);

    // Senza AbortController l'upstream resterebbe aperto ~10s (finché l'LLM finisce) → waitFor scade e il test fallisce
    await waitFor(() => ai.upstreamClosedAt() !== undefined, 1000);
    expect(ai.upstreamClosedAt()! - destroyedAt).toBeLessThan(1000);
    // Nessun socket "ESTABLISHED" residuo verso il servizio AI (il controllo di lsof)
    await waitFor(() => ai.openSockets() === 0, 1000);
  });

  it("stream completo → tutti i token inoltrati in ordine, Content-Type text/event-stream", async () => {
    const { api } = await setup("short");

    const res = await postStream(api.url, { message: "Ciao" });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(text).toBe("data: token0\n\ndata: token1\n\ndata: token2\n\n");
  });

  it("servizio AI che risponde 500 → 502 AI_UPSTREAM_ERROR in JSON (header SSE non ancora inviati)", async () => {
    const { api } = await setup("error");

    const res = await postStream(api.url, { message: "Ciao" });

    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("AI_UPSTREAM_ERROR");
  });

  it("servizio AI irraggiungibile → 502", async () => {
    const api = await listen(createApp({ aiServiceUrl: "http://127.0.0.1:1" }));
    cleanups.push(api.close);

    const res = await postStream(api.url, { message: "Ciao" });

    expect(res.status).toBe(502);
  });

  it("senza login → 401; messaggio vuoto → 422", async () => {
    const { api } = await setup("short");

    expect((await postStream(api.url, { message: "x" }, {})).status).toBe(401);
    expect((await postStream(api.url, { message: "   " })).status).toBe(422);
  });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condizione non verificata entro ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 20));
  }
}

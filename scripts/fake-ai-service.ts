// Finto servizio AI (al posto di FastAPI) per riprodurre a mano il Bug 1:
//   terminale 1: npm run ai:fake          (ascolta su :8000, un token ogni 200ms per ~60s, come un LLM lento)
//   terminale 2: npm run dev              (AI_SERVICE_URL=http://localhost:8000)
//   terminale 3: login, poi curl -N -X POST http://localhost:3000/api/ai/stream -b cookie.txt \
//                  -H "Content-Type: application/json" -d '{"message":"ciao"}'   → Ctrl+C dopo qualche token
// Ogni secondo lo script stampa quante connessioni dal proxy sono ancora aperte: con il fix torna a 0 entro 1s
// dal Ctrl+C; con la versione rotta resta a 1 per ogni client "sparito" finché lo stream non finisce.
// Equivalenti di lsof: Linux/macOS `lsof -iTCP:8000 -sTCP:ESTABLISHED`, Windows `netstat -ano | findstr :8000`.
import http from "node:http";

const PORT = Number(process.env.FAKE_AI_PORT ?? 8000);
const TOKENS = 300;
let open = 0;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ token: `parola${i}` })}\n\n`);
    if (++i === TOKENS) {
      clearInterval(timer);
      res.end("data: [DONE]\n\n");
    }
  }, 200);
  res.on("close", () => {
    clearInterval(timer);
    console.log(res.writableFinished ? "stream completato" : `stream interrotto dal proxy dopo ${i} token`);
  });
});

server.on("connection", socket => {
  open++;
  socket.on("close", () => open--);
});

setInterval(() => console.log(`connessioni aperte dal proxy: ${open}`), 1000).unref();

server.listen(PORT, () => console.log(`Finto servizio AI su http://localhost:${PORT}/api/chat`));

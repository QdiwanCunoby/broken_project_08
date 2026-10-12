// Proxy SSE verso il servizio AI (FastAPI): il client riceve i token dell'LLM man mano che arrivano.
//
// Regola d'oro di un proxy di streaming: quando il client se ne va, si chiude SUBITO anche l'upstream.
// Altrimenti ogni utente che cambia tab lascia una connessione TCP verso FastAPI aperta finché l'LLM
// non ha finito (30-60s): con N utenti i file descriptor finiscono → "EMFILE: too many open files".
import { once } from "node:events";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { validate } from "../../middleware/validate";
import { AppError } from "../../utils/errors";
import { logger } from "../../utils/logger";

export const chatSchema = z.object({
  message: z.string({ message: "message obbligatorio" }).trim().min(1).max(4000),
});

export const createAiRoutes = (aiServiceUrl: string): Router => {
  const router = Router();

  router.post("/stream", validate(chatSchema), asyncHandler(async (req, res) => {
    const abort = new AbortController();

    // ⚠️ res.on("close"), NON req.on("close"): da Node 16 `req` emette "close" appena il BODY è stato letto
    // (express.json l'ha già consumato prima di arrivare qui), non quando il client si disconnette.
    // `res` emette "close" quando la connessione sottostante si chiude: se la risposta non era finita,
    // è il client che se n'è andato → abort dell'upstream.
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${aiServiceUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: req.body.message }),
        signal: abort.signal,   // fetch sa quando il client è andato via: abort chiude il socket verso FastAPI
      });
    } catch (e) {
      if (abort.signal.aborted) return;   // client già andato: nessuno a cui rispondere
      logger.error({ reqId: req.id, err: e }, "Servizio AI non raggiungibile");
      throw new AppError(502, "AI_UPSTREAM_ERROR", "Servizio AI non disponibile");
    }

    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();   // libera la connessione anche sulla risposta d'errore
      throw new AppError(502, "AI_UPSTREAM_ERROR", `Servizio AI ha risposto ${upstream.status}`);
    }

    // Header SSE solo DOPO che l'upstream ha risposto: fino a qui gli errori escono come JSON standard
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",   // nginx: niente buffering, i token devono arrivare subito
    });
    res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();   // con abort() rifiuta con AbortError → finally
        if (done) break;
        // Backpressure: se il client legge lento non si accumula tutto in RAM, si aspetta "drain"
        if (!res.write(value)) await once(res, "drain", { signal: abort.signal });
      }
    } catch (e) {
      // Abort = client disconnesso: è il caso normale, non un errore
      if (!abort.signal.aborted) {
        logger.error({ reqId: req.id, err: e }, "Stream AI interrotto dall'upstream");
        // Header già inviati: non si può più cambiare status, si segnala l'errore come evento SSE
        res.write(`event: error\ndata: ${JSON.stringify({ code: "AI_STREAM_INTERRUPTED" })}\n\n`);
      }
    } finally {
      // Rilascia lo stream upstream in ogni caso (fine normale, errore, client andato via).
      // cancel() su uno stream già chiuso/abortito è innocuo; l'eventuale rifiuto non interessa.
      await reader.cancel().catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
  }));

  return router;
};

# broken_project_08

LipariBank — **Broken Project Giorno 8**: proxy SSE verso il servizio AI, paginazione offset, upload sicuro con multer, cursor pagination dei movimenti.
Base: il Project Work del G7 (Jest + Supertest + Postgres di test isolato).

> **Stato**: codice e test scritti, **non ancora eseguiti**. Il progetto è consegnato senza `node_modules` (`npm install` aggiunge multer e aggiorna `package-lock.json`).

## Avvio

```bash
npm install
npx prisma generate
cp .env.example .env              # JWT_ACCESS_SECRET / JWT_REFRESH_SECRET, AI_SERVICE_URL, UPLOAD_DIR
npx prisma migrate deploy         # include la nuova migration *_transfers_cursor_index
npx tsx src/index.ts              # oppure npm run dev

# Test (Postgres usa-e-getta su :5434)
npm run db:test:up
npm test
npm run test:coverage
```

Richieste di prova: sezione "BROKEN PROJECT G8" in [requests/liparibank.http](requests/liparibank.http).

## Dove sono le correzioni

Il PDF cita `src/routes/aiRoutes.ts`, `src/services/accountService.ts`, `src/middleware/upload.ts`. Questo progetto è organizzato per moduli, quindi:

| Traccia | Qui |
|---|---|
| Bug 1 `aiRoutes.ts` | `src/modules/ai/ai.routes.ts`, montato su `POST /api/ai/stream` (autenticato) |
| Bug 2 `accountService.findPaginated` | `src/modules/account/account.repository.ts` (`findPaginated`) + `account.service.ts` (`listAccounts`, calcolo `meta`) |
| Bug 3 `upload.ts` | `src/middleware/upload.ts` + `src/modules/document/document.routes.ts` (`POST /api/documents`) + `src/middleware/errorHandler.ts` |
| Feature `/api/transactions` | `src/modules/transaction/` sulla tabella `transfers` (lo schema non ha un modello `Transaction`: i movimenti sono i bonifici) |

---

## Bug 1 🔴 — Il proxy SSE non chiude l'upstream (fd leak → EMFILE)

**Fix** (`ai.routes.ts`):
- `AbortController` e `signal: abort.signal` passato a `fetch`: quando il client se ne va, `abort()` chiude il socket verso FastAPI e il `reader.read()` in attesa rifiuta subito.
- `finally { await reader.cancel() }`: lo stream upstream viene rilasciato in **ogni** caso (fine normale, errore, client sparito).
- Backpressure: se `res.write()` restituisce `false` si aspetta `drain` (anche questo interrompibile dall'abort), invece di accumulare in RAM i token di un client lento.
- Gli header SSE si inviano solo dopo la risposta dell'upstream: se FastAPI è giù o risponde 5xx il client riceve un normale `502 AI_UPSTREAM_ERROR` in JSON. Se lo stream si interrompe a metà, quando lo status non si può più cambiare, il client riceve un evento SSE `event: error`.

**⚠️ `res.on("close")`, non `req.on("close")` come nella traccia.** Da Node 16 `IncomingMessage` (`req`) emette `close` quando il **body della richiesta è stato letto tutto**, non quando il client si disconnette. `express.json()` ha già letto il body prima di arrivare all'handler, quindi un listener su `req` partirebbe subito oppure mai, e il leak resterebbe. `res` invece emette `close` quando la connessione sottostante si chiude. Se in quel momento la risposta non era finita (`!res.writableFinished`), è il client che se n'è andato.

**Verifica** (al posto di `lsof`): `tests/integration/aiStream.test.ts` avvia un finto servizio AI che manda un token ogni 50 ms per circa 10 s e conta i socket aperti verso di lui. Il "browser" riceve il primo token e distrugge la connessione. Il test controlla che lo stream verso l'upstream si chiuda **entro 1 s** e che i socket aperti tornino a 0. Senza il fix resterebbero aperti finché l'LLM non finisce.
Verifica manuale: `npm run ai:fake` (stampa ogni secondo le connessioni aperte dal proxy) + `npm run dev` + `curl -N` interrotto con Ctrl+C. Con `lsof -iTCP:8000 -sTCP:ESTABLISHED` (Linux/macOS) o `netstat -ano | findstr :8000` (Windows) le connessioni devono sparire entro 1 s.

**`reader.cancel()` vs `upstream.body.destroy()`**
- `upstream.body` di `fetch` (undici) è un **WHATWG `ReadableStream`**. `reader.cancel()` è il suo modo standard di dire "non mi interessa più": l'operazione è asincrona, propaga la cancellazione alla sorgente (undici chiude la connessione invece di rimetterla nel pool con un body non letto), risolve quando la sorgente ha liberato le risorse e rilascia il lock del reader.
- `.destroy()` è l'API dei **Node.js `Readable`** (stream di `http.request`, `node-fetch` v2, `Readable.fromWeb(...)`): distrugge lo stream in modo sincrono e immediato, emette `close` (ed `error` se gli passi un errore) e chiude il socket. Su un `ReadableStream` di undici **non esiste**: `upstream.body.destroy` è `undefined`.
- In pratica: con `fetch` nativo si usa `abort()` (chiude subito la connessione e sblocca la `read()` in attesa) più `reader.cancel()` nel `finally` (rilascio pulito e idempotente). `destroy()` serve solo se lo stream è stato convertito in un Node `Readable`.

## Bug 2 🟡 — Paginazione con `totalPages` sbagliato

**Fix**: `prisma.$transaction([findMany, count])` con lo **stesso `where`**. `total` diventa il conteggio dell'intero dataset filtrato (non `data.length`, che vale al massimo `limit`), e le due query girano nella stessa transazione. `totalPages = Math.ceil(total / limit)`, `hasNext = page < totalPages`, `hasPrev = page > 1`.

In più:
- **Ordine totale** `[createdAt asc, id asc]`: le righe inserite insieme (`createMany`) hanno lo stesso `created_at`. Con un ordine non deterministico Postgres può restituire righe ripetute o saltate tra una pagina e l'altra.
- Query validata con Zod (`page ≥ 1`, `1 ≤ limit ≤ 100`, filtri `status`/`type`/`ownerId`) → 422 se non valida.
- Risposta: `{ data, meta: { page, limit, total, totalPages, hasNext, hasPrev } }`.

**Test richiesto** (`tests/integration/accountPagination.test.ts`): 25 conti nel DB, `page=3&limit=10` → 5 righe, `total: 25, totalPages: 3, hasNext: false, hasPrev: true`. Altri test: le 25 righe si vedono una sola volta scorrendo le pagine, il filtro vale anche per il totale, query non valide → 422. Unit test del calcolo di `meta` in `account.service.test.ts`.

## Bug 3 🟢 — Multer salva con `originalname` (path traversal)

**Fix** (`upload.ts`):
1. **Nome generato dal server**: `randomUUID()` + estensione presa da una **whitelist indicizzata per MIME** (`application/pdf → .pdf`, `image/jpeg → .jpg`, `image/png → .png`). Del nome inviato dal client non si usa nulla, nemmeno l'estensione.
2. **`fileFilter`**: MIME fuori whitelist → `415 UNSUPPORTED_MEDIA_TYPE`, il file non viene scritto.
3. **Magic bytes** (`verifyFileSignature`): dopo il salvataggio si leggono i primi byte (`%PDF-`, `\x89PNG\r\n\x1a\n`, `FF D8 FF`). Se non corrispondono al MIME dichiarato il file viene **cancellato** → 415.
4. **`errorHandler`**: `MulterError` con `code === "LIMIT_FILE_SIZE"` → `413 PAYLOAD_TOO_LARGE`; gli altri codici di multer (es. due file con `limits.files: 1`) → `400 UPLOAD_ERROR`.

Nota: con le impostazioni di default (`preservePath: false`) busboy, il parser usato da multer, toglie già le directory dal filename. `"../../../etc/passwd.pdf"` arriva quindi come `"passwd.pdf"`, e il traversal vero si ha solo con `preservePath: true`. Usare `originalname` resta comunque un finding critico: due clienti che caricano `estratto.pdf` si **sovrascrivono** i documenti a vicenda, e il client sceglie liberamente estensione e nome (`.html` servito come pagina, nomi riservati Windows come `CON`, caratteri di controllo). Il test copre entrambi i casi.

**Perché controllare l'estensione (`.pdf`) non basta.** Il nome, e quindi l'estensione, li sceglie chi carica il file: rinominare `malware.exe` in `estratto.pdf` costa zero. Neanche il MIME è affidabile, perché è un header `Content-Type` scritto dal client. Il sistema operativo e i programmi non guardano l'estensione per decidere cosa è il file: guardano il **contenuto**. Un `.pdf` con dentro un eseguibile PE (`MZ…`), un HTML con JavaScript o un polyglot (file valido in due formati) supera qualunque controllo sul nome. Per questo i controlli sono a strati: whitelist MIME, firma dei magic bytes sul contenuto reale, nome e estensione decisi dal server. In un contesto bancario si aggiungono la scansione antivirus (es. ClamAV) prima di rendere il file disponibile, il salvataggio fuori dalla web root (mai servito come statico) e l'invio con `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff`. Anche i magic bytes dicono solo come *inizia* il file: un PDF valido può contenere JavaScript, quindi la scansione serve comunque.

**Test** (`tests/integration/upload.test.ts`): `filename="../../../etc/passwd.pdf"` → 201, file `UUID.pdf` dentro `UPLOAD_DIR` e niente fuori. Due upload di `estratto.pdf` → due file distinti. `foto.exe` dichiarato `image/png` → salvato `.png`. `application/x-msdownload` → 415 senza file su disco. `.exe` mascherato da PDF → 415 e file cancellato. Oltre 5 MB → 413 senza file parziali. Nessun file → 422. Senza login → 401.

## Feature opzionale — Cursor pagination `GET /api/transactions`

- Schema Zod: `cursor` UUID opzionale, `take` coerced 1–50 (default 20), più un filtro opzionale `accountId` (movimenti in entrata e in uscita di un conto).
- `TransactionService.findByCursor(cursor, take)`: senza cursor parte dall'inizio. Con cursor usa `cursor: { id }, skip: 1`, perché Prisma include la riga del cursore e va saltata.
- Risposta: `{ data, nextCursor, hasNext }`. Sul frontend: `getNextPageParam: last => last.nextCursor`.

Due scelte diverse dalla traccia:
- **`take + 1`**: si chiede una riga in più per sapere se esiste una pagina successiva. Con `hasNext: data.length === take`, un dataset di esattamente `take` righe direbbe `hasNext: true` e il frontend chiederebbe una pagina vuota in più.
- **Ordine `[createdAt desc, id desc]`** con indice composto `(created_at DESC, id DESC)` (migration `20261013090000_transfers_cursor_index`). È il "cursor composto" del suggerimento: `created_at` da solo ha duplicati, l'id fa da spareggio. Non serve un `@@unique` con cursor composito, perché `id` è già unico e Prisma posiziona il cursore usando i valori di ordinamento di quella riga.

**Test** (`tests/integration/transactions.test.ts`): 45 movimenti letti in 20+20+5 senza duplicati. **Movimenti nuovi inseriti tra pagina 1 e 2**: con il cursor 0 righe ripetute, con l'offset sugli stessi dati 5 righe ripetute. 12 movimenti nello stesso istante letti a pagine di 5 senza perdite. Esattamente `take` righe → `hasNext: false`. Filtro `accountId`. Query non valide → 422.

**EXPLAIN ANALYZE**: `npm run db:test:up && npm run explain:pagination` inserisce 100.000 movimenti in uno schema `explain` del DB di test e stampa i piani di `OFFSET 50000 LIMIT 20`, della query keyset equivalente al cursor e dell'offset **senza** l'indice composto.
Cosa aspettarsi (non ancora misurato):
- **Offset senza indice adatto**: `Seq Scan` + `Sort` su tutta la tabella, quindi O(n log n).
- **Offset con indice**: `Index Scan` che però deve leggere e scartare 50.020 voci, quindi O(offset). Peggiora a ogni pagina.
- **Cursor**: un lookup sulla PK per trovare la riga del cursore (O(log n)), poi un range scan sull'indice composto che legge solo `take + 1` voci, quindi O(log n + take) a qualunque profondità.

La traccia dice che "il cursor usa l'indice sulla PK": vale solo per trovare la riga del cursore. Per l'ordinamento per `created_at` serve l'indice composto. Senza, anche il cursor dovrebbe ordinare l'intera tabella.

## Altre modifiche

- `createApp(overrides: Partial<AppDeps>)`: i test sostituiscono solo le dipendenze che servono (es. `aiServiceUrl` di un finto upstream).
- `env.ts`: `AI_SERVICE_URL` (default `http://localhost:8000`) e `UPLOAD_DIR` (default `uploads`). `.env.test` usa `.tmp/test-uploads`. `uploads/` e `.tmp/` sono nel `.gitignore`.
- `tsconfig.json` include anche `scripts/`, così `npm run typecheck` controlla gli script.

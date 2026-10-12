// Upload multipart con multer. Tre difese, dalla più esterna alla più interna:
//  1. fileFilter: solo MIME dichiarati in whitelist (pdf, jpeg, png) → 415
//  2. filename generato dal server: randomUUID() + estensione DERIVATA DAL MIME in whitelist.
//     file.originalname arriva dal client: può contenere "../", path assoluti, nomi riservati, estensioni
//     eseguibili, o semplicemente coincidere con il file di un altro cliente (sovrascrittura). Non si usa mai.
//  3. verifyFileSignature: il MIME è un header scelto dal client, quindi si controllano i magic bytes del
//     contenuto reale. Se non corrispondono al tipo dichiarato il file viene cancellato → 415.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError, ValidationError } from "../utils/errors";

// MIME ammesso → estensione con cui viene salvato. Unica fonte di verità per filtro, nome e firma.
export const ALLOWED_TYPES = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
} as const;

type AllowedMime = keyof typeof ALLOWED_TYPES;

const isAllowedMime = (mime: string): mime is AllowedMime => Object.hasOwn(ALLOWED_TYPES, mime);

// Primi byte di ogni formato ammesso
const SIGNATURES: Record<AllowedMime, readonly number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],                       // "%PDF-"
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],           // "\x89PNG\r\n\x1a\n"
  "image/jpeg": [0xff, 0xd8, 0xff],                                         // SOI + marker
};

export const MAX_FILE_SIZE = 5 * 1024 * 1024;   // 5 MB
// Path assoluto: multer.diskStorage con una stringa relativa dipenderebbe dalla cwd del processo
export const UPLOAD_DIR = path.resolve(env.uploadDir);

const unsupported = (message: string) => new AppError(415, "UNSUPPORTED_MEDIA_TYPE", message);

const storage = multer.diskStorage({
  // Funzione (non stringa): con una funzione multer non crea la cartella, la creiamo noi se manca
  destination: (_req, _file, cb) => {
    fs.mkdir(UPLOAD_DIR, { recursive: true }, err => cb(err ?? null, UPLOAD_DIR));
  },
  // Il nome NON contiene nulla di ciò che manda il client: UUID + estensione dalla whitelist
  filename: (_req, file, cb) => {
    cb(null, `${randomUUID()}${ALLOWED_TYPES[file.mimetype as AllowedMime]}`);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,   // oltre → MulterError LIMIT_FILE_SIZE → 413 (errorHandler)
    files: 1,
    fields: 5,
  },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMime(file.mimetype)) return cb(null, true);
    // Es. application/x-msdownload (.exe), text/html, image/svg+xml (può contenere script)
    cb(unsupported(`Tipo di file non ammesso (${file.mimetype}): solo PDF, JPEG, PNG`));
  },
});

// Dopo upload.single(): il file è su disco. Si leggono i primi byte e si confrontano con la firma del MIME dichiarato.
export const verifyFileSignature: RequestHandler = async (req, _res, next) => {
  const file = req.file;
  if (!file) return next(new ValidationError("File obbligatorio", [{ field: "file", message: "Allega un file nel campo 'file'" }]));

  try {
    const expected = SIGNATURES[file.mimetype as AllowedMime];
    const header = Buffer.alloc(expected.length);
    const handle = await fs.promises.open(file.path, "r");
    try {
      await handle.read(header, 0, expected.length, 0);
    } finally {
      await handle.close();
    }

    if (!expected.every((byte, i) => header[i] === byte)) {
      await fs.promises.rm(file.path, { force: true });   // mai lasciare su disco un file rifiutato
      return next(unsupported("Il contenuto del file non corrisponde al tipo dichiarato"));
    }
    next();
  } catch (e) {
    next(e);
  }
};

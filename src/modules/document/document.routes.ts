// Upload di documenti (es. documento d'identità, contratto firmato). Il file resta in UPLOAD_DIR con un nome
// generato dal server; al client si restituisce quel nome, mai il percorso su disco né l'originalname.
import { Router } from "express";
import { upload, verifyFileSignature } from "../../middleware/upload";
import { ok } from "../../utils/apiResponse";

export const createDocumentRoutes = (): Router => {
  const router = Router();

  // 201 | 401 | 413 file > 5MB | 415 tipo non ammesso o contenuto non coerente | 422 file mancante
  router.post("/", upload.single("file"), verifyFileSignature, (req, res) => {
    const { filename, mimetype, size } = req.file!;
    res.status(201).json(ok({ fileName: filename, mimeType: mimetype, size }));
  });

  return router;
};

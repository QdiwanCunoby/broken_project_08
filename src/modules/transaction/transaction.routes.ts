import { Router } from "express";
import { TransactionService } from "./transaction.service";
import { TransactionQuery, transactionQuerySchema } from "./transaction.types";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { serializeDecimals } from "../../utils/decimalSerializer";

export const createTransactionRoutes = (service: TransactionService): Router => {
  const router = Router();

  // 200 { data, nextCursor, hasNext } | 422 query non valida
  router.get("/", validate(transactionQuerySchema, "query"), asyncHandler(async (req, res) => {
    const { cursor, take, accountId } = req.query as unknown as TransactionQuery;
    const page = await service.findByCursor(cursor, take, accountId);
    res.status(200).json(serializeDecimals(page));   // amount Decimal → "100.00"
  }));

  return router;
};

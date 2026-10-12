import { z } from "zod";

// GET /api/transactions?cursor=<lastId>&take=20[&accountId=<uuid>]
export const transactionQuerySchema = z.object({
  cursor: z.uuid({ message: "cursor deve essere l'id (UUID) dell'ultimo movimento ricevuto" }).optional(),
  take: z.coerce.number().int().min(1).max(50, { message: "take massimo 50" }).default(20),
  accountId: z.uuid({ message: "accountId deve essere un UUID" }).optional(),   // movimenti di un solo conto
});

export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

// Envelope cursor-based: il frontend usa getNextPageParam: last => last.nextCursor (null = fine lista)
export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasNext: boolean;
}

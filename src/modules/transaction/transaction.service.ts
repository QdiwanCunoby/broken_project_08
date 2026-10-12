// Lista movimenti (tabella transfers) con cursor-based pagination.
//
// Offset (skip = page * take): se tra pagina 50 e 51 entrano 10 movimenti nuovi in cima, tutto scala di 10 righe
// e la pagina 51 ripete righe già viste. E per arrivare a OFFSET 50000 Postgres deve comunque leggere e scartare
// 50000 righe: O(n).
// Cursor: "dammi i `take` movimenti che vengono DOPO questo id nell'ordinamento". Le righe nuove finiscono prima
// del cursore e non spostano nulla; con l'indice (created_at DESC, id DESC) Postgres parte dal cursore: O(log n).
import { PrismaClient, Transfer } from "@prisma/client";
import { CursorPage } from "./transaction.types";

export class TransactionService {
  constructor(private readonly prisma: PrismaClient) {}

  async findByCursor(cursor: string | undefined, take: number, accountId?: string): Promise<CursorPage<Transfer>> {
    const rows = await this.prisma.transfer.findMany({
      where: accountId ? { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] } : undefined,
      // Ordine TOTALE: con il solo createdAt due movimenti nello stesso istante avrebbero posizione ambigua
      // e un cursore potrebbe saltarne uno. L'id fa da spareggio (stesso ordine dell'indice composto).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // Senza cursor si parte dall'inizio. Con cursor Prisma INCLUDE la riga del cursore: skip: 1 la salta.
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // Una riga in più del richiesto: se arriva, esiste una pagina successiva. Con `data.length === take`
      // un dataset di esattamente `take` righe direbbe hasNext: true e il frontend chiederebbe una pagina vuota.
      take: take + 1,
    });

    const hasNext = rows.length > take;
    const data = hasNext ? rows.slice(0, take) : rows;
    return { data, nextCursor: hasNext ? data.at(-1)!.id : null, hasNext };
  }
}

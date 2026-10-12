import { z } from "zod";

export type UUID = string;

export enum AccountType { CHECKING = "CHECKING", SAVINGS = "SAVINGS", BUSINESS = "BUSINESS" }
export enum AccountStatus { ACTIVE = "ACTIVE", BLOCKED = "BLOCKED", CLOSED = "CLOSED" }

export interface Account {
  id: UUID;
  ownerId: UUID;            // id del Customer intestatario
  iban: string;
  type: AccountType;
  balance: string;          // importo decimale come stringa ("1000.00"): mai number per i soldi
  status: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

// IBAN italiano: IT + 2 cifre di controllo + CIN + ABI(5) + CAB(5) + conto(12) = 27 caratteri
const IT_IBAN_REGEX = /^IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}$/;

// ─── Schemi Zod: unica fonte di verità per validazione (runtime) e DTO (compile time) ───
export const createAccountSchema = z.object({
  ownerId: z.uuid({ message: "ownerId deve essere un UUID" }),
  iban: z
    .string()
    .trim()
    .toUpperCase()
    .length(27, { message: "L'IBAN italiano è di 27 caratteri" })
    .regex(IT_IBAN_REGEX, { message: "IBAN italiano non valido (es. IT60X0542811101000000123456)" }),
  type: z.enum(AccountType),
  initialBalance: z.number().nonnegative({ message: "Il saldo iniziale non può essere negativo" }).default(0),
});

// Tutti i campi opzionali. IBAN e saldo non si modificano via PUT: l'IBAN identifica il conto,
// il saldo cambia solo tramite movimenti.
export const updateAccountSchema = z
  .object({
    ownerId: z.uuid({ message: "ownerId deve essere un UUID" }),
    type: z.enum(AccountType),
    status: z.enum(AccountStatus),
  })
  .partial()
  .refine(dto => Object.keys(dto).length > 0, { message: "Specifica almeno un campo da aggiornare" });

export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type UpdateAccountDto = z.infer<typeof updateAccountSchema>;

// ─── Paginazione offset-based: GET /api/accounts?page=3&limit=10&status=ACTIVE ───
// I query param arrivano come stringhe: z.coerce li converte in number prima dei controlli
export const accountQuerySchema = z.object({
  page: z.coerce.number().int().min(1, { message: "page parte da 1" }).default(1),
  limit: z.coerce.number().int().min(1).max(100, { message: "limit massimo 100" }).default(20),
  status: z.enum(AccountStatus).optional(),
  type: z.enum(AccountType).optional(),
  ownerId: z.uuid({ message: "ownerId deve essere un UUID" }).optional(),
});

export type AccountFilter = z.infer<typeof accountQuerySchema>;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;        // righe che rispettano il filtro in TUTTO il dataset, non nella pagina
  totalPages: number;   // sempre intero: Math.ceil(total / limit)
  hasNext: boolean;
  hasPrev: boolean;
}

export interface Paginated<T> { data: T[]; meta: PageMeta }

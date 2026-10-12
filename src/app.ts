// Configurazione Express app + composition root — separata da index.ts per i test
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { env } from "./config/env";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { notFoundHandler } from "./middleware/notFoundHandler";
import { errorHandler } from "./middleware/errorHandler";
import { createAuthenticate } from "./middleware/authenticate";
import { IUserRepository, PrismaUserRepository } from "./modules/auth/auth.repository";
import { AuthService } from "./modules/auth/auth.service";
import { AuthController } from "./modules/auth/auth.controller";
import { createAuthRoutes } from "./modules/auth/auth.routes";
import { IAccountRepository, PrismaAccountRepository } from "./modules/account/account.repository";
import { AccountService } from "./modules/account/account.service";
import { AccountController } from "./modules/account/account.controller";
import { createAccountRoutes } from "./modules/account/account.routes";
import { ICustomerRepository, PrismaCustomerRepository } from "./modules/customer/customer.repository";
import { CustomerService } from "./modules/customer/customer.service";
import { CustomerController } from "./modules/customer/customer.controller";
import { createCustomerRoutes } from "./modules/customer/customer.routes";
import { PrismaTransferRepository } from "./modules/transfer/transfer.repository";
import { TransferService } from "./modules/transfer/transfer.service";
import { TransferController } from "./modules/transfer/transfer.controller";
import { createTransferRoutes } from "./modules/transfer/transfer.routes";
import { TransactionService } from "./modules/transaction/transaction.service";
import { createTransactionRoutes } from "./modules/transaction/transaction.routes";
import { createDocumentRoutes } from "./modules/document/document.routes";
import { createAiRoutes } from "./modules/ai/ai.routes";

// UN SOLO PrismaClient (un pool di connessioni): si connette in modo lazy, alla prima query
const prisma = new PrismaClient();

export interface AppDeps {
  users: IUserRepository;
  accounts: IAccountRepository;
  customers: ICustomerRepository;
  aiServiceUrl: string;
}

// ─── Composition root: Repository → Service → Controller → Routes ───
// In produzione tutti i repository sono Prisma; i test sostituiscono solo ciò che serve (es. repository in memoria,
// URL di un finto servizio AI): le dipendenze non passate restano quelle di default.
export const createApp = (overrides: Partial<AppDeps> = {}) => {
  const deps: AppDeps = {
    users: overrides.users ?? new PrismaUserRepository(prisma),
    accounts: overrides.accounts ?? new PrismaAccountRepository(prisma),
    customers: overrides.customers ?? new PrismaCustomerRepository(prisma),
    aiServiceUrl: overrides.aiServiceUrl ?? env.aiServiceUrl,
  };

  const authService = new AuthService(deps.users);
  const authenticate = createAuthenticate(authService);
  const authRoutes = createAuthRoutes(new AuthController(authService), authenticate);
  const accountRoutes = createAccountRoutes(new AccountController(new AccountService(deps.accounts)));
  const customerRoutes = createCustomerRoutes(new CustomerController(new CustomerService(deps.customers)));
  const transferRoutes = createTransferRoutes(
    new TransferController(new TransferService(prisma, new PrismaTransferRepository(prisma))),   // apre lui la $transaction
  );
  const transactionRoutes = createTransactionRoutes(new TransactionService(prisma));
  const documentRoutes = createDocumentRoutes();
  const aiRoutes = createAiRoutes(deps.aiServiceUrl);

  const app = express();

  // ─── Pipeline middleware (l'ordine conta: ogni richiesta li attraversa dall'alto in basso) ───
  app.use(requestId);                                                        // 1. req.id + header X-Request-Id
  app.use(requestLogger);                                                    // 2. pino-http: log con reqId, status, ms
  app.use(helmet());                                                         // 3. Security headers
  app.use(cors({ origin: env.corsOrigin.split(","), credentials: true, exposedHeaders: ["X-Request-Id"] })); // 4. CORS
  app.use(express.json({ limit: "100kb" }));                                 // 5. Parse body JSON → req.body
  app.use(cookieParser());                                                   // 6. Parse cookie → req.cookies (PRIMA dei router)

  // ─── Routes: authenticate PRIMA delle route che protegge (Express applica i middleware in ordine) ───
  app.use("/api/auth", authRoutes);                                          // pubbliche (me si protegge da sola)
  app.use("/api/accounts", authenticate, accountRoutes);                     // 401 senza login; DELETE solo ADMIN (403)
  app.use("/api/customers", authenticate, customerRoutes);                   // 401 senza login; DELETE solo ADMIN (403)
  app.use("/api/transfers", authenticate, transferRoutes);                   // 401 senza login
  app.use("/api/transactions", authenticate, transactionRoutes);             // lista movimenti, cursor pagination
  app.use("/api/documents", authenticate, documentRoutes);                   // upload multipart (multer)
  app.use("/api/ai", authenticate, aiRoutes);                                // proxy SSE verso il servizio AI

  // ─── Health check ───
  app.get("/health", (req, res) => {
    res.json({ data: { status: "ok", timestamp: new Date().toISOString() } });
  });

  // ─── 404 catch-all + error handler (sempre per ultimi: errorHandler è l'ULTIMO app.use) ───
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

const app = createApp();

export { app, prisma };

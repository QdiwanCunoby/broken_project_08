// Route: connette URL → Controller. Le dipendenze arrivano dal composition root (app.ts).
import { Router } from "express";
import { AccountController } from "./account.controller";
import { accountQuerySchema, createAccountSchema, updateAccountSchema } from "./account.types";
import { validate } from "../../middleware/validate";
import { authorize } from "../../middleware/authorize";

export const createAccountRoutes = (controller: AccountController): Router => {
  const router = Router();

  router.get("/",       validate(accountQuerySchema, "query"), controller.getAll);   // 200 { data, meta } | 422
  router.get("/:id",    controller.getById);                                   // 200 | 404
  router.post("/",      validate(createAccountSchema), controller.create);     // 201 | 422 | 409
  router.put("/:id",    validate(updateAccountSchema), controller.update);     // 200 | 422 | 404
  router.delete("/:id", authorize("ADMIN"), controller.delete);  // 204 | 403 | 404

  return router;
};

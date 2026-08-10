import express from "express";
import type PgBoss from "pg-boss";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import { makeBillWebhookHandler } from "./webhooks/bill.js";

export function createServer(db: Db, boss: PgBoss, cfg: Config): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", async (_req, res) => {
    await db.query("select 1");
    res.json({ ok: true });
  });

  app.post("/webhooks/bill", makeBillWebhookHandler(db, boss, cfg));

  return app;
}

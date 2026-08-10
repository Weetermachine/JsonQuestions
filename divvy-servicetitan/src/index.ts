import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createServer } from "./server.js";
import { BillClient } from "./clients/bill.js";
import { ServiceTitanClient } from "./clients/servicetitan.js";
import { PROCESS_TX_QUEUE, processTransaction } from "./webhooks/bill.js";
import { reconcile } from "./core/reconcile.js";
import { configureSlack, notifyException } from "./notify/slack.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
const bill = new BillClient(cfg);
const st = new ServiceTitanClient(cfg);
configureSlack(cfg.SLACK_WEBHOOK_URL);

const boss = new PgBoss(cfg.DATABASE_URL);
await boss.start();

// Worker: fetch-and-diff each transaction. pg-boss retries with backoff.
await boss.createQueue(PROCESS_TX_QUEUE);
await boss.work<{ uuid: string }>(
  PROCESS_TX_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (job) await processTransaction(db, bill, st, cfg, job.data.uuid);
  },
);

// Nightly reconciliation sweep at 02:15 (server tz).
const RECONCILE_QUEUE = "reconcile";
await boss.createQueue(RECONCILE_QUEUE);
await boss.schedule(RECONCILE_QUEUE, "15 2 * * *");
await boss.work(RECONCILE_QUEUE, async () => {
  const { swept, reprocessed } = await reconcile(db, bill, st, cfg);
  console.log(`reconcile: swept=${swept} reprocessed=${reprocessed}`);
});

// Dead-man's switch: alert if no webhook has arrived in 24h. A silent stop
// (expired subscription, broken tunnel) must not look like a quiet day.
const HEARTBEAT_QUEUE = "webhook-heartbeat";
await boss.createQueue(HEARTBEAT_QUEUE);
await boss.schedule(HEARTBEAT_QUEUE, "0 * * * *");
await boss.work(HEARTBEAT_QUEUE, async () => {
  const { rows } = await db.query(
    `select max(received_at) as last from webhook_events`,
  );
  const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
  if (last && Date.now() - last > 24 * 60 * 60 * 1000) {
    await notifyException("No BILL webhooks received in 24h — check the subscription and endpoint.");
  }
});

const app = createServer(db, boss, cfg);
app.listen(cfg.PORT, () => console.log(`listening on :${cfg.PORT}`));

// Webhook handler + the fetch-and-diff processing it triggers.
// The HTTP handler does the minimum (record + enqueue) so BILL always gets a
// fast 200; real work happens in the pg-boss worker via processTransaction.
import type { Request, Response } from "express";
import type PgBoss from "pg-boss";
import type { Db } from "../db.js";
import type { BillClient } from "../clients/bill.js";
import type { ServiceTitanClient } from "../clients/servicetitan.js";
import type { Config } from "../config.js";
import { decide, type TxSnapshot } from "../core/stateMachine.js";
import { applyDecision } from "../core/proposals.js";

export const PROCESS_TX_QUEUE = "process-transaction";

export function makeBillWebhookHandler(db: Db, boss: PgBoss, cfg: Config) {
  return async (req: Request, res: Response): Promise<void> => {
    // TODO: verify signature with cfg.BILL_WEBHOOK_SECRET once the
    // subscription exists (reject on mismatch). Until then, treat the payload
    // as untrusted: we only ever act on state re-fetched from BILL's API.
    void cfg;
    const body = req.body ?? {};
    const uuid: string | undefined = body?.data?.uuid ?? body?.uuid;

    await db.query(`insert into webhook_events (event_type, bill_uuid, body) values ($1, $2, $3)`, [
      body?.eventType ?? "unknown",
      uuid ?? null,
      body,
    ]);

    if (uuid) {
      // singletonKey collapses bursts of events for the same tx into one job.
      await boss.send(PROCESS_TX_QUEUE, { uuid }, { singletonKey: uuid, singletonSeconds: 10 });
    }
    res.status(200).json({ ok: true });
  };
}

/** Fetch-and-diff: pull current state from BILL, decide, act, persist. */
export async function processTransaction(
  db: Db,
  bill: BillClient,
  st: ServiceTitanClient,
  cfg: Config,
  uuid: string,
): Promise<void> {
  const tx = await bill.getTransaction(uuid);
  const jobNumber = bill.jobNumberFrom(tx);

  const fresh: TxSnapshot = {
    status: tx.status.toLowerCase(),
    amountCents: Math.round(tx.amount * 100),
    jobNumber,
  };

  const { rows } = await db.query(
    `select t.status, t.amount_cents as "amountCents", t.job_number as "jobNumber",
            exists(select 1 from proposals p
                   where p.bill_uuid = t.bill_uuid and p.action = 'create_po' and p.status = 'executed')
              as "postedPo"
     from transactions t where t.bill_uuid = $1`,
    [uuid],
  );
  const stored = rows[0] ?? null;

  const decision = decide(stored, fresh, { postOn: cfg.POST_ON });
  await applyDecision(db, st, tx, jobNumber, decision);

  await db.query(
    `insert into transactions (bill_uuid, bill_user_uuid, status, amount_cents, currency, merchant_name, occurred_at, job_number, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (bill_uuid) do update set
       status = excluded.status, amount_cents = excluded.amount_cents,
       merchant_name = excluded.merchant_name, job_number = excluded.job_number,
       raw = excluded.raw, updated_at = now()`,
    [
      tx.uuid,
      tx.userUuid ?? null,
      fresh.status,
      fresh.amountCents,
      tx.currencyData?.code ?? "USD",
      tx.merchantName ?? null,
      tx.occurredTime ?? null,
      jobNumber,
      tx,
    ],
  );
}

// Nightly safety net: pull the day's transactions from BILL and re-run any
// whose state differs from what we have stored (i.e. webhooks we missed).
import type { Db } from "../db.js";
import type { BillClient } from "../clients/bill.js";
import { processTransaction } from "../webhooks/bill.js";
import type { ServiceTitanClient } from "../clients/servicetitan.js";
import type { Config } from "../config.js";

export async function reconcile(
  db: Db,
  bill: BillClient,
  st: ServiceTitanClient,
  cfg: Config,
): Promise<{ swept: number; reprocessed: number }> {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000); // 36h overlap window
  const txs = await bill.listTransactionsSince(since);
  let reprocessed = 0;
  for (const tx of txs) {
    const { rows } = await db.query(`select raw from transactions where bill_uuid = $1`, [tx.uuid]);
    const stored = rows[0]?.raw;
    if (!stored || JSON.stringify(stored) !== JSON.stringify(tx)) {
      await processTransaction(db, bill, st, cfg, tx.uuid);
      reprocessed++;
    }
  }
  return { swept: txs.length, reprocessed };
}

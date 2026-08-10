// Proposal lifecycle: persist intent, validate against ServiceTitan, execute.
// Everything the service does to ServiceTitan flows through here.
import type { Db } from "../db.js";
import type { BillTransaction } from "../clients/bill.js";
import type { ServiceTitanClient } from "../clients/servicetitan.js";
import type { Decision } from "./stateMachine.js";
import { notifyException } from "../notify/slack.js";

// Actions safe to execute without human approval. Everything else waits in
// `pending` until approved (Slack action or manual SQL for now).
const AUTO_APPROVE = new Set(["create_po", "add_note"]);

export async function applyDecision(
  db: Db,
  st: ServiceTitanClient,
  tx: BillTransaction,
  jobNumber: string | null,
  decision: Decision,
): Promise<void> {
  switch (decision.kind) {
    case "noop":
      return;

    case "exception": {
      await db.query(
        `insert into exceptions (bill_uuid, reason, detail) values ($1, $2, $3)`,
        [tx.uuid, decision.reason, { merchant: tx.merchantName, amount: tx.amount }],
      );
      await notifyException(
        `Divvy transaction ${tx.uuid} (${tx.merchantName ?? "unknown merchant"}, $${tx.amount}) has no job number.`,
      );
      return;
    }

    case "propose_create_po": {
      // Validate before proposing: job must exist, be unambiguous, and be open.
      const job = jobNumber ? await st.findJobByNumber(jobNumber) : null;
      if (!job) {
        await db.query(`insert into exceptions (bill_uuid, reason, detail) values ($1, $2, $3)`, [
          tx.uuid,
          "job_not_found",
          { jobNumber },
        ]);
        await notifyException(`Job #${jobNumber} on Divvy tx ${tx.uuid} not found in ServiceTitan.`);
        return;
      }
      if (job.jobStatus === "Canceled") {
        await db.query(`insert into exceptions (bill_uuid, reason, detail) values ($1, $2, $3)`, [
          tx.uuid,
          "job_closed",
          { jobNumber, jobStatus: job.jobStatus },
        ]);
        await notifyException(`Job #${jobNumber} is ${job.jobStatus}; Divvy tx ${tx.uuid} needs a human.`);
        return;
      }

      const payload = {
        jobId: job.id,
        vendorName: tx.merchantName ?? "Unknown vendor",
        totalCents: Math.round(tx.amount * 100),
        memo: `Divvy card purchase ${tx.uuid}`,
      };
      const auto = AUTO_APPROVE.has("create_po");
      const { rows } = await db.query(
        `insert into proposals (bill_uuid, action, status, job_number, st_job_id, payload, auto_approved)
         values ($1, 'create_po', $2, $3, $4, $5, $6)
         on conflict (bill_uuid, action, status) do nothing
         returning id`,
        [tx.uuid, auto ? "approved" : "pending", jobNumber, job.id, payload, auto],
      );
      if (auto && rows.length) await executeProposal(db, st, rows[0].id);
      return;
    }

    case "propose_update_po":
    case "propose_reverse_po": {
      // Money-adjusting actions always wait for human approval initially.
      const action = decision.kind === "propose_update_po" ? "update_po" : "reverse_po";
      await db.query(
        `insert into proposals (bill_uuid, action, status, job_number, payload)
         values ($1, $2, 'pending', $3, $4)
         on conflict (bill_uuid, action, status) do nothing`,
        [tx.uuid, action, jobNumber, { newAmountCents: Math.round(tx.amount * 100) }],
      );
      await notifyException(`Divvy tx ${tx.uuid} needs a ${action} — approve in the queue.`);
      return;
    }
  }
}

export async function executeProposal(db: Db, st: ServiceTitanClient, proposalId: number): Promise<void> {
  const { rows } = await db.query(`select * from proposals where id = $1 and status = 'approved'`, [proposalId]);
  const p = rows[0];
  if (!p) return;

  try {
    let result: unknown;
    switch (p.action) {
      case "create_po":
        result = await st.createPurchaseOrder(p.payload);
        break;
      case "add_note":
        await st.addJobNote(p.st_job_id, p.payload.text);
        result = { ok: true };
        break;
      default:
        throw new Error(`no executor for action ${p.action}`);
    }
    await db.query(`update proposals set status = 'executed', result = $2, executed_at = now() where id = $1`, [
      proposalId,
      result,
    ]);
  } catch (err) {
    await db.query(`update proposals set status = 'failed', error = $2 where id = $1`, [
      proposalId,
      String(err),
    ]);
    throw err; // let pg-boss retry with backoff
  }
}

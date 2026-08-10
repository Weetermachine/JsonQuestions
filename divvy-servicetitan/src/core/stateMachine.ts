// The heart of the integration: a pure function from (what we knew, what BILL
// says now, policy) to a decision. No I/O — fully unit-testable.

export interface TxSnapshot {
  status: string; // normalized lowercase: pending | cleared | declined | ...
  amountCents: number;
  jobNumber: string | null;
}

export interface StoredState extends TxSnapshot {
  postedPo: boolean; // have we already executed a create_po for this tx?
}

export type Decision =
  | { kind: "noop"; reason: string }
  | { kind: "propose_create_po" }
  | { kind: "propose_update_po"; previousAmountCents: number }
  | { kind: "propose_reverse_po" }
  | { kind: "exception"; reason: "missing_job_number" };

export interface Policy {
  /** "cleared": wait for settlement (final amount). "complete": post as soon as a job number exists. */
  postOn: "cleared" | "complete";
}

export function decide(stored: StoredState | null, fresh: TxSnapshot, policy: Policy): Decision {
  const posted = stored?.postedPo ?? false;

  // Declines and reversals: undo if we posted, otherwise ignore.
  if (fresh.status === "declined") {
    return posted ? { kind: "propose_reverse_po" } : { kind: "noop", reason: "declined, never posted" };
  }

  if (posted) {
    if (fresh.amountCents !== stored!.amountCents) {
      return { kind: "propose_update_po", previousAmountCents: stored!.amountCents };
    }
    return { kind: "noop", reason: "already posted, nothing changed" };
  }

  // Not yet posted: is the transaction ripe under our policy?
  const ripe = policy.postOn === "complete" || fresh.status === "cleared";
  if (!ripe) return { kind: "noop", reason: `waiting for cleared (status=${fresh.status})` };

  // Ripe but no job number → a human needs to chase it.
  if (!fresh.jobNumber) return { kind: "exception", reason: "missing_job_number" };

  return { kind: "propose_create_po" };
}

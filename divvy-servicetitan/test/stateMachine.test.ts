import { describe, expect, it } from "vitest";
import { decide } from "../src/core/stateMachine.js";

const policy = { postOn: "cleared" as const };

describe("decide", () => {
  it("waits for cleared under the cleared policy", () => {
    const d = decide(null, { status: "pending", amountCents: 5000, jobNumber: "4521" }, policy);
    expect(d.kind).toBe("noop");
  });

  it("posts immediately under the complete policy", () => {
    const d = decide(
      null,
      { status: "pending", amountCents: 5000, jobNumber: "4521" },
      { postOn: "complete" },
    );
    expect(d.kind).toBe("propose_create_po");
  });

  it("raises an exception when cleared with no job number", () => {
    const d = decide(null, { status: "cleared", amountCents: 5000, jobNumber: null }, policy);
    expect(d).toEqual({ kind: "exception", reason: "missing_job_number" });
  });

  it("proposes a PO when cleared with a job number", () => {
    const d = decide(null, { status: "cleared", amountCents: 5000, jobNumber: "4521" }, policy);
    expect(d.kind).toBe("propose_create_po");
  });

  it("is a no-op when already posted and unchanged (duplicate webhook)", () => {
    const stored = { status: "cleared", amountCents: 5000, jobNumber: "4521", postedPo: true };
    const d = decide(stored, { status: "cleared", amountCents: 5000, jobNumber: "4521" }, policy);
    expect(d.kind).toBe("noop");
  });

  it("proposes an amount update when a posted transaction changes", () => {
    const stored = { status: "cleared", amountCents: 5000, jobNumber: "4521", postedPo: true };
    const d = decide(stored, { status: "cleared", amountCents: 5500, jobNumber: "4521" }, policy);
    expect(d).toEqual({ kind: "propose_update_po", previousAmountCents: 5000 });
  });

  it("proposes a reversal when a posted transaction is declined/refunded", () => {
    const stored = { status: "cleared", amountCents: 5000, jobNumber: "4521", postedPo: true };
    const d = decide(stored, { status: "declined", amountCents: 5000, jobNumber: "4521" }, policy);
    expect(d.kind).toBe("propose_reverse_po");
  });

  it("ignores declines that were never posted", () => {
    const d = decide(null, { status: "declined", amountCents: 5000, jobNumber: "4521" }, policy);
    expect(d.kind).toBe("noop");
  });
});

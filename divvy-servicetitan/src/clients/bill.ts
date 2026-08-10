// BILL Spend & Expense v3 API client. Auth is a static API token sent as the
// `apiToken` header. Rate limit is 60 calls/token/minute — fine at webhook
// volume, but the reconcile sweep should page politely.
import type { Config } from "../config.js";

export interface BillTransaction {
  uuid: string;
  userUuid?: string;
  status: string; // e.g. PENDING / CLEARED / DECLINED — confirm exact enum in sandbox
  amount: number; // dollars; convert to cents at the storage boundary
  currencyData?: { code?: string };
  merchantName?: string;
  occurredTime?: string;
  customFields?: Array<{
    customFieldUuid: string;
    selectedValues?: Array<{ value?: string }>;
    value?: string;
  }>;
  [key: string]: unknown;
}

export class BillClient {
  constructor(private cfg: Config) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.BILL_BASE_URL}${path}`, {
      ...init,
      headers: {
        apiToken: this.cfg.BILL_API_TOKEN,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`BILL ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  getTransaction(uuid: string): Promise<BillTransaction> {
    return this.request<BillTransaction>(`/v3/spend/transactions/${uuid}`);
  }

  /** Page through transactions occurring on/after `since` (reconcile sweep). */
  async listTransactionsSince(since: Date): Promise<BillTransaction[]> {
    // TODO: confirm filter param names against the v3 reference
    // (developer.bill.com → GET /v3/spend/transactions, `filters` syntax).
    const out: BillTransaction[] = [];
    let page: string | undefined;
    do {
      const qs = new URLSearchParams({ max: "100" });
      if (page) qs.set("page", page);
      const res = await this.request<{ results: BillTransaction[]; nextPage?: string }>(
        `/v3/spend/transactions?${qs}`,
      );
      out.push(...res.results.filter((t) => !t.occurredTime || new Date(t.occurredTime) >= since));
      page = res.nextPage;
    } while (page);
    return out;
  }

  /** Idempotently ensure our webhook subscription exists. Call at startup. */
  async ensureSubscription(notificationUrl: string): Promise<void> {
    // TODO: GET /v3/subscriptions, create if absent:
    // POST /v3/subscriptions { name, notificationUrl, events: ["spend.transactions.updated"] }
    // Store the returned securityKey as BILL_WEBHOOK_SECRET for signature checks.
    void notificationUrl;
    throw new Error("not implemented");
  }

  /** Extract the ServiceTitan job number from the configured custom field. */
  jobNumberFrom(tx: BillTransaction): string | null {
    const field = tx.customFields?.find((f) => f.customFieldUuid === this.cfg.BILL_JOB_FIELD_UUID);
    const raw = field?.value ?? field?.selectedValues?.[0]?.value ?? null;
    if (!raw) return null;
    const match = raw.match(/\d{3,}/); // tolerate "Job #4521", "#4521", "4521"
    return match ? match[0] : null;
  }
}

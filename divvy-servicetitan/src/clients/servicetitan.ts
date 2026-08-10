// ServiceTitan v2 API client. OAuth2 client-credentials (machine-to-machine);
// tokens are short-lived, so we cache and refresh centrally here. Every
// request also needs the ST-App-Key header from the dev portal.
import type { Config } from "../config.js";

export interface StJob {
  id: number;
  jobNumber: string;
  jobStatus: string; // e.g. Scheduled / InProgress / Completed / Canceled
  customerId: number;
  businessUnitId?: number;
  [key: string]: unknown;
}

export class ServiceTitanClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: Config) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(this.cfg.ST_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.ST_CLIENT_ID,
        client_secret: this.cfg.ST_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`ServiceTitan auth failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.ST_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.getToken()}`,
        "ST-App-Key": this.cfg.ST_APP_KEY,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`ServiceTitan ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private tenantPath(api: string, resource: string): string {
    return `/${api}/v2/tenant/${this.cfg.ST_TENANT_ID}/${resource}`;
  }

  /**
   * Resolve a human-facing job number to the job record. Note the id/number
   * distinction: the number printed on paperwork is NOT the API `id`; all
   * write operations take the id.
   */
  async findJobByNumber(jobNumber: string): Promise<StJob | null> {
    const qs = new URLSearchParams({ number: jobNumber, pageSize: "2" });
    const res = await this.request<{ data: StJob[] }>(this.tenantPath("jpm", `jobs?${qs}`));
    // Exactly-one guard: a number matching multiple jobs goes to a human.
    return res.data.length === 1 ? (res.data[0] ?? null) : null;
  }

  async addJobNote(jobId: number, text: string): Promise<void> {
    await this.request(this.tenantPath("jpm", `jobs/${jobId}/notes`), {
      method: "POST",
      body: JSON.stringify({ text, pinToTop: false }),
    });
  }

  /**
   * Create a purchase order associated with a job. Endpoint shape is the one
   * thing to verify against the tenant (Inventory API availability can depend
   * on configuration/edition). Fallback if unavailable: addJobNote with the
   * transaction details so the cost is at least visible on the job.
   */
  async createPurchaseOrder(po: {
    jobId: number;
    vendorName: string;
    totalCents: number;
    memo: string;
  }): Promise<{ id: number }> {
    // TODO: verify against dev portal — POST /inventory/v2/tenant/{tenant}/purchase-orders
    // requires vendorId (lookup/create vendor), typeId, businessUnitId, items[].
    void po;
    throw new Error("not implemented: verify PO endpoint shape against tenant");
  }
}

# divvy-servicetitan

Event-driven integration that posts Divvy (BILL Spend & Expense) card
transactions onto ServiceTitan jobs as purchase orders, keyed by job number.

```
BILL webhook (push) ─▶ fetch transaction ─▶ diff vs stored ─▶ state machine
                                                                  │
                              ┌───────────────────────────────────┤
                              ▼                                   ▼
                     proposal: create/update PO          exception queue (Slack)
                              │
                              ▼
                     ServiceTitan JPM/Inventory API
```

## Design principles

- **Push, not poll.** BILL `spend.transactions.updated` webhooks drive everything.
  A nightly reconciliation sweep is the only polling (safety net for missed
  deliveries).
- **Webhooks are signals, not commands.** On every event we `GET` the full
  transaction, diff it against our stored copy, and let the state machine
  decide. This makes duplicate deliveries free no-ops.
- **Proposals are first-class.** Every intended write to ServiceTitan is stored
  as a `proposals` row before execution — audit trail, idempotency, and a
  human-approval gate all come from this one table.
- **Deterministic core.** The happy path (job number present and valid) needs
  no AI. Receipt OCR / job inference for missing numbers is a later,
  human-confirmed enrichment layer.

## Getting started

```bash
cp .env.example .env      # fill in credentials (see below)
npm install
npm run migrate           # applies migrations/ to DATABASE_URL
npm run dev               # starts webhook server + workers
```

For local webhook delivery, run a tunnel (e.g. `cloudflared tunnel --url
http://localhost:3000`) and register the public URL with
`POST /v3/subscriptions` (see `src/clients/bill.ts#ensureSubscription`).

## Credentials

| Env var | Where it comes from |
|---|---|
| `BILL_API_TOKEN` | BILL sandbox/production web app → Spend & Expense API token |
| `BILL_BASE_URL` | `https://gateway.stage.bill.com/connect` (sandbox) or prod gateway |
| `ST_CLIENT_ID` / `ST_CLIENT_SECRET` | ServiceTitan dev portal app (Integration Environment for sandbox) |
| `ST_TENANT_ID` / `ST_APP_KEY` | ServiceTitan dev portal |
| `ST_BASE_URL` | `https://api-integration.servicetitan.io` (sandbox) or `https://api.servicetitan.io` |
| `DATABASE_URL` | Postgres connection string |
| `SLACK_WEBHOOK_URL` | Incoming webhook for the exception queue (optional in dev) |

## Repo layout

```
migrations/          SQL migrations (plain files, applied in order)
src/
  index.ts           entrypoint: HTTP server + pg-boss workers
  config.ts          env parsing/validation (fails fast on missing vars)
  db.ts              pg pool + tiny query helpers
  server.ts          express app and routes
  webhooks/bill.ts   POST /webhooks/bill — enqueue only, no work inline
  clients/
    bill.ts          BILL Spend & Expense v3 client (token auth)
    servicetitan.ts  ServiceTitan v2 client (OAuth2 M2M, token cache)
  core/
    stateMachine.ts  pure function: (stored, fresh) → decision
    proposals.ts     proposal creation + execution against ServiceTitan
    reconcile.ts     nightly sweep: diff BILL's day vs our records
  notify/slack.ts    exception-queue notifications
test/                unit tests for the pure core (state machine first)
```

## Status / TODO

- [ ] Verify PO-create endpoint shape against the company's ServiceTitan
      tenant (Inventory API; availability can depend on tenant configuration).
      Fallback: job note with transaction details.
- [ ] Confirm which BILL custom field UUID holds the job number
      (`BILL_JOB_FIELD_UUID` in `.env`).
- [ ] Confirm custom-field edits are in the `spend.transactions.updated`
      trigger field set (BILL changelog 2025-05-22).
- [ ] Decide post-on-cleared vs post-on-complete policy (`POST_ON` in config;
      default `cleared`).
- [ ] Webhook signature verification once BILL subscription is created
      (`BILL_WEBHOOK_SECRET`).

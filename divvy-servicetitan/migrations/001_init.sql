-- Core tables. Amounts are integer cents. All BILL identifiers are UUIDs.

-- Our stored copy of each BILL transaction, updated on every webhook fetch.
-- The diff between this row and a fresh GET drives the state machine.
create table transactions (
  bill_uuid        uuid primary key,
  bill_user_uuid   uuid,
  status           text not null,            -- BILL status: pending/cleared/declined/...
  amount_cents     integer not null,
  currency         text not null default 'USD',
  merchant_name    text,
  occurred_at      timestamptz,
  job_number       text,                     -- extracted from the BILL custom field
  raw              jsonb not null,           -- full BILL payload as last fetched
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Every intended write to ServiceTitan, recorded before execution.
-- Idempotency: one active proposal per (transaction, action).
create table proposals (
  id               bigint generated always as identity primary key,
  bill_uuid        uuid not null references transactions,
  action           text not null,            -- create_po / update_po / reverse_po / add_note
  status           text not null default 'pending',
                    -- pending -> approved -> executed
                    -- pending -> rejected
                    -- pending -> failed (execution error; retried by worker)
  job_number       text,
  st_job_id        bigint,                   -- resolved ServiceTitan job id
  payload          jsonb not null,           -- what we intend to send
  result           jsonb,                    -- ServiceTitan response after execution
  error            text,
  auto_approved    boolean not null default false,
  created_at       timestamptz not null default now(),
  executed_at      timestamptz,
  unique (bill_uuid, action, status)         -- guards duplicate pending work
);

-- Transactions we could not resolve to a job; surfaced to Slack for a human.
create table exceptions (
  id               bigint generated always as identity primary key,
  bill_uuid        uuid not null references transactions,
  reason           text not null,            -- missing_job_number / job_not_found / job_closed / customer_mismatch
  detail           jsonb,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);

-- Raw webhook deliveries, for replay and debugging. Cheap insurance.
create table webhook_events (
  id               bigint generated always as identity primary key,
  event_type       text not null,
  bill_uuid        uuid,
  body             jsonb not null,
  received_at      timestamptz not null default now()
);

create index on proposals (status);
create index on exceptions (resolved_at) where resolved_at is null;
create index on webhook_events (bill_uuid);

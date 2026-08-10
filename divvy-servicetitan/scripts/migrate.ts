// Dead-simple forward-only migration runner: applies migrations/*.sql in
// filename order, tracking applied files in schema_migrations.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(
  "create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())",
);

const dir = join(import.meta.dirname, "..", "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  const { rowCount } = await client.query("select 1 from schema_migrations where name = $1", [file]);
  if (rowCount) continue;
  console.log(`applying ${file}`);
  await client.query("begin");
  try {
    await client.query(await readFile(join(dir, file), "utf8"));
    await client.query("insert into schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}
console.log("migrations up to date");
await client.end();

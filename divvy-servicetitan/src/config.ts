import { z } from "zod";

const Env = z.object({
  BILL_API_TOKEN: z.string().min(1),
  BILL_BASE_URL: z.string().url().default("https://gateway.stage.bill.com/connect"),
  BILL_JOB_FIELD_UUID: z.string().min(1),
  BILL_WEBHOOK_SECRET: z.string().optional(),

  ST_BASE_URL: z.string().url().default("https://api-integration.servicetitan.io"),
  ST_AUTH_URL: z.string().url().default("https://auth-integration.servicetitan.io/connect/token"),
  ST_CLIENT_ID: z.string().min(1),
  ST_CLIENT_SECRET: z.string().min(1),
  ST_APP_KEY: z.string().min(1),
  ST_TENANT_ID: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  POST_ON: z.enum(["cleared", "complete"]).default("cleared"),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

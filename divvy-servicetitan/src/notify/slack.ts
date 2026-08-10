// Exception-queue notifications. Slack incoming webhook if configured,
// stdout otherwise (so dev works with no Slack setup).
let webhookUrl: string | undefined;

export function configureSlack(url: string | undefined): void {
  webhookUrl = url;
}

export async function notifyException(text: string): Promise<void> {
  if (!webhookUrl) {
    console.warn(`[exception] ${text}`);
    return;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `:rotating_light: ${text}` }),
  });
  if (!res.ok) console.error(`Slack notify failed: ${res.status}`);
}

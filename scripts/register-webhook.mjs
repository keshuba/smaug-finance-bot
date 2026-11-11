// Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL in your shell.
// This script never prints a token or the token-bearing Telegram endpoint.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const workerUrl = process.env.WORKER_URL;
if (!token || !secret || !workerUrl) {
  process.stderr.write('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL.\n');
  process.exit(1);
}
const parsed = new URL(workerUrl);
if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || parsed.username || parsed.password)
  throw new Error('WORKER_URL must be a plain HTTPS URL without credentials or query parameters.');
const result = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: parsed.toString(), secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  }),
});
const body = await result.json();
if (!result.ok || body.ok !== true) {
  process.stderr.write(`Telegram rejected webhook registration (HTTP ${result.status}).\n`);
  process.exit(1);
}
process.stdout.write('Webhook registered. Send /start to your bot.\n');

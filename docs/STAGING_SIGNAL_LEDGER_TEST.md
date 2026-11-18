# Controlled staging test (no production access)

This repository's default `wrangler.toml` points at the production Worker name and production KV namespace. **Do not use it for staging tests.**

## Required isolated resources

1. Create a new Cloudflare KV namespace named `cryptopumphunter-staging`.
2. Copy its namespace ID into `wrangler.staging.toml`, replacing `REPLACE_WITH_STAGING_KV_NAMESPACE_ID`.
3. Create a separate Telegram bot with BotFather. Do not use the production bot token.
4. Set staging secrets locally (never commit them):
   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.staging.toml
   npx wrangler secret put OWNER_TELEGRAM_ID --config wrangler.staging.toml
   ```
5. Deploy only the staging config:
   ```sh
   npx wrangler deploy --config wrangler.staging.toml
   ```
6. Configure the staging bot webhook to the staging Worker URL, then test only with a private test chat.

## Safety checks before sending

- Confirm Worker name is `cryptopumphunter-staging`.
- Confirm the KV namespace ID is the newly-created staging namespace, not the ID in `wrangler.toml`.
- Confirm the bot token belongs to the staging bot.
- Keep cron disabled in staging. No real orders are placed by this bot.

## Test sequence

1. Send one controlled test signal to the private test chat.
2. Verify its outbox record transitions `QUEUED -> SENDING -> SENT -> ARCHIVED`.
3. Verify one permanent archive record and one open-trade record exist.
4. Re-run the same signal and verify no duplicate Telegram message or archive record.
5. Simulate a failure after Telegram accepts the message but before archive completion; verify the record stays recoverable as `SENT` and retry archives without sending again.
6. Advance a test trade through TP1, TP2, then STOP; verify the archive retains both TP milestones and the final stop result.
7. Delete the staging KV namespace after tests if it is no longer needed.

Never paste bot tokens or Cloudflare API tokens into chat, source files, or commit history.

# Mailbox

A private, inbound-only mailbox dashboard for custom domains you own. The app runs on Render; **all persistent mailbox data is stored in Cloudflare R2**.

## Features

- Private admin sign-in
- Multiple custom domains
- Individual inboxes and numbered batches
- Inbound email storage, including original .eml messages and attachments
- Search, read/unread status, and message deletion
- Dark, responsive dashboard
- No outbound email sending
- No Render PostgreSQL database

Use mailboxes and aliases you control, and follow the terms and verification rules of services you use. This app does not automate account creation or bypass third-party limits.

## Architecture

Cloudflare Email Routing invokes the Worker in `cloudflare-worker/`. The Worker forwards the original RFC 5322 message over HTTPS to the Render app's `/api/inbound` endpoint.

The Render service parses the email and stores message JSON, original raw MIME, and attachments as private objects in Cloudflare R2. Domain and mailbox records are JSON objects in the same R2 bucket. There is no PostgreSQL or separate database.

This keeps the actual mail and all persistent app data out of Render's filesystem, which is temporary.

## R2 storage layout

- `domains/<domain>.json` — configured domains
- `mailboxes/<domain>/<local-part>.json` — mailbox records
- `messages/<domain>/<local-part>/<message-id>.json` — searchable message metadata and bodies
- `raw/<domain>/<local-part>/<message-id>.eml` — original email source
- `attachments/<domain>/<local-part>/<message-id>/<index>` — attachment bytes

The app lists and reads message JSON objects to build inboxes and search results. This is intentionally simple for a personal, low-volume mailbox. If the number of messages grows substantially, a dedicated index/database would make search and listing faster; the message contents would still stay in R2.

## R2 cost

Cloudflare R2 Standard currently includes 10 GB-month of storage, 1 million Class A operations, and 10 million Class B operations per month. Standard storage above the included amount is currently $0.015 per GB-month, with no R2 egress charge. Usage beyond the free included amounts can cost money. Check the current [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before relying on it.

## Deploy on Render

1. Open the repository's Render Blueprint flow.
2. Review the proposed web service. This Blueprint no longer creates a Render database.
3. Create an R2 bucket in Cloudflare (Storage & databases → R2 → Create bucket).
4. Create an R2 API token with Object Read & Write access scoped only to this bucket. Keep the access key and secret private.
5. Set these environment variables on the Render web service:
   - `R2_ACCOUNT_ID`: your Cloudflare account ID
   - `R2_ACCESS_KEY_ID`: R2 access key ID
   - `R2_SECRET_ACCESS_KEY`: R2 secret access key
   - `R2_BUCKET`: exact bucket name
   - `ADMIN_PASSWORD_HASH`: bcrypt hash of your chosen admin password
6. Keep Render-generated `SESSION_SECRET` and `INBOUND_SECRET`. Never commit or share them.
7. Deploy and wait for the `/health` endpoint to report `storage: cloudflare-r2`.

Generate a bcrypt password hash locally with:

```bash
node -e "require('bcryptjs').hash(process.argv[1], 12).then(console.log)" "your-long-password"
```

## Cloudflare inbound email setup

For each domain:

1. Make sure the domain is active in Cloudflare and its nameservers point to Cloudflare.
2. Deploy the Worker from `cloudflare-worker/`.
3. Set Worker variables/secrets:
   - `MAILBOX_INGEST_URL`: `https://YOUR-RENDER-SERVICE.onrender.com/api/inbound`
   - `MAILBOX_INBOUND_SECRET`: same value as Render's `INBOUND_SECRET`
4. In Email Routing, configure a catch-all route to invoke this Worker.
5. Use the exact MX records Cloudflare displays for the domain.
6. Add the domain in the Mailbox dashboard and create inbox addresses.

## Local development

Requires Node.js 20+ and a Cloudflare R2 bucket.

Set these environment variables in a local `.env` file (never commit it):

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `SESSION_SECRET`
- `INBOUND_SECRET`
- `ADMIN_PASSWORD_HASH`
- `NODE_ENV=development`

Then run `npm install` and `npm start`.

## Security notes

- Keep the R2 token scoped to this one bucket and only the permissions the app needs.
- Use a strong, unique admin password.
- Keep all secrets out of GitHub and rotate them if exposed.
- Email content is untrusted. Plain text is displayed by default; HTML is isolated in a sandboxed iframe.
- R2 objects are accessed through the private S3 API. Do not enable public bucket access.
- This initial R2-only index design reads JSON objects to search messages. It is suitable for modest personal use, not high-volume shared mail hosting.

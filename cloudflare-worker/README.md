# Cloudflare Email Worker

This Worker is the inbound email bridge. It does not send mail or provide a mailbox UI.

## Deploy

From this directory:

```bash
npx wrangler login
npx wrangler deploy
```

Set the following Worker variables/secrets in the Cloudflare dashboard:

- `MAILBOX_INGEST_URL`: your Render app's `https://<service>.onrender.com/api/inbound` URL
- `MAILBOX_INBOUND_SECRET`: exactly the same value as Render's `INBOUND_SECRET`

In Cloudflare Email Routing, configure a catch-all route for the domain to invoke this Worker. Cloudflare's dashboard will show the MX records required for the domain; use those exact records.

The Worker forwards the raw MIME stream and the SMTP envelope recipient to the Render app over HTTPS. It rejects messages larger than 25 MiB and returns a delivery failure if the Render app cannot accept the message.

Do not commit secrets to this repository.

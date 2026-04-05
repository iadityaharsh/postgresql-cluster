# Cloudflare Hyperdrive Setup

Connect Cloudflare Workers to your PostgreSQL cluster using Hyperdrive — Cloudflare's edge connection pooler. Hyperdrive connects through your Cloudflare Tunnel, pools connections, and caches query results automatically.

## Prerequisites

- Cloudflare Tunnel running on the cluster (see [Remote Access](remote-access.md))
- Cloudflare Access application with a Service Token protecting the tunnel hostname
- SSL enabled on PostgreSQL (`ssl = on` in `postgresql.conf`) — **Hyperdrive requires SSL**
- A dedicated PostgreSQL user for Hyperdrive (do not share with local users)
- Node.js and Wrangler CLI installed (`npm install -g wrangler`)

## Architecture

```
[Cloudflare Worker] → Hyperdrive (connection pool) → Access (service token) → Tunnel → VIP:5432
```

Hyperdrive handles:
- **Connection pooling** — reuses connections across Worker invocations
- **Query caching** — caches read queries at the edge
- **Regional routing** — routes to the nearest Cloudflare data center

---

## 1. Enable SSL on PostgreSQL

Hyperdrive will refuse to connect without SSL. If your cluster uses self-signed certificates (default for Patroni), that's fine — Hyperdrive supports `sslmode=require`.

Verify SSL is enabled:

```bash
sudo -u postgres psql -c "SHOW ssl;"
```

If `off`, update Patroni's PostgreSQL parameters:

```bash
patronictl -c /etc/patroni/patroni.yml edit-config
```

Add under `postgresql.parameters`:

```yaml
ssl: "on"
ssl_cert_file: "/etc/ssl/certs/ssl-cert-snakeoil.pem"
ssl_key_file: "/etc/ssl/private/ssl-cert-snakeoil.key"
```

Then restart PostgreSQL via Patroni:

```bash
patronictl -c /etc/patroni/patroni.yml restart <cluster-name>
```

> **Note:** Self-signed certificates work. Hyperdrive uses `sslmode=require` (verifies encryption, not the certificate authority). If your team asks: use self-signed certs, require SSL for all connections, and replication does not need SSL changes.

---

## 2. Create a Dedicated Database User

Create a user specifically for Hyperdrive with only the access it needs:

```sql
CREATE USER your_cf_user WITH PASSWORD 'secure_random_password';
GRANT ALL PRIVILEGES ON DATABASE your_db TO your_cf_user;
\c your_db
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_cf_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO your_cf_user;
```

Ensure `pg_hba.conf` allows the user via SSL. Patroni manages this — add to the Patroni config:

```yaml
postgresql:
  pg_hba:
    - "hostssl all your_cf_user 0.0.0.0/0 md5"
```

---

## 3. Create the Hyperdrive Configuration

Hyperdrive connects through your Cloudflare Access tunnel, so use the `--access-client-id` and `--access-client-secret` flags instead of `--connection-string`:

```bash
npx wrangler hyperdrive create your-hyperdrive-name \
  --origin-host=db-cluster.example.com \
  --origin-user=your_cf_user \
  --origin-password='secure_random_password' \
  --database=your_db \
  --access-client-id=YOUR_CF_ACCESS_CLIENT_ID.access \
  --access-client-secret=YOUR_CF_ACCESS_CLIENT_SECRET
```

> **Important:** Do not use `--connection-string` together with `--access-client-id` — they conflict. Also do not pass `--origin-port` when using Access — Hyperdrive routes through the tunnel, not a direct TCP port.

This returns a Hyperdrive config ID. Save it.

### Common errors at this step

| Error | Cause | Fix |
|---|---|---|
| `--connection-string conflicts with --access-client-id` | Can't mix connection string with Access params | Use individual `--origin-*` flags |
| `--origin-port conflicts with --access-client-id` | Port is not used with Access tunnels | Remove `--origin-port` |
| `could not connect to origin` | SSL not enabled on PostgreSQL | Enable SSL (step 1) |

---

## 4. Add Hyperdrive to Your Worker

### wrangler.jsonc

```jsonc
{
  "name": "your-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2025-09-27",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "your-hyperdrive-config-id"
    }
  ]
}
```

### Worker code

```typescript
import { Client } from "pg";

interface Env {
  HYPERDRIVE: Hyperdrive;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString,
    });

    await client.connect();
    try {
      const result = await client.query("SELECT NOW()");
      return Response.json({ time: result.rows[0].now });
    } finally {
      await client.end();
    }
  },
};
```

### Install the pg driver

```bash
npm install pg
```

---

## 5. Deploy and Test

```bash
npx wrangler deploy
```

Test with:

```bash
curl https://your-worker.your-domain.com/
```

### Verifying the connection

Add a health endpoint to your Worker:

```typescript
// Inside your fetch handler
if (url.pathname === "/api/health") {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });
  await client.connect();
  const result = await client.query("SELECT 1 AS ok");
  await client.end();
  return Response.json({ db: "connected", ok: result.rows[0].ok });
}
```

---

## 6. Managing Secrets

Worker secrets (API keys, tokens) must be set via Wrangler, not in `wrangler.jsonc`:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put OTP_FROM_EMAIL
```

> **Note:** If you delete and recreate the Worker, secrets are lost and must be re-set.

---

## Updating the Hyperdrive Config

```bash
# Update password
npx wrangler hyperdrive update <HYPERDRIVE_ID> \
  --origin-password='new_password'

# Delete and recreate
npx wrangler hyperdrive delete <HYPERDRIVE_ID>
npx wrangler hyperdrive create ... (same flags as step 3)
```

---

## Troubleshooting

### Error 1042 / Worker crashed
- Check that the Hyperdrive config ID in `wrangler.jsonc` matches
- Verify the database user has access to the specified database
- Allow time for deployment to propagate (especially after first deploy)

### Health check shows `resend_key_set: false`
Worker secrets are not set. Run `npx wrangler secret put <KEY>` for each secret.

### Connection timeout
- Verify the Cloudflare Tunnel is running: check **Zero Trust > Networks > Tunnels**
- Verify the Access application allows the Hyperdrive service
- Test the tunnel independently with `cloudflared access tcp`

### `workers_dev` URLs keep re-activating
Set `"workers_dev": false` in `wrangler.jsonc` to disable the `.workers.dev` subdomain.

### Pages Functions not executing
Cloudflare Pages uses `functions/` directory, but Workers use a single entry point (`main` in wrangler config). If migrating from Pages to Workers, consolidate all API routes into your Worker's fetch handler.

---

## Further Reading

- [Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/)
- [Remote Access setup](remote-access.md) — Tunnel and Access configuration
- [Wrangler CLI reference](https://developers.cloudflare.com/workers/wrangler/)

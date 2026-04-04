# Remote Access via Cloudflare Tunnel

Securely expose your PostgreSQL cluster to the internet using Cloudflare Tunnel. No open ports, no public IPs — traffic flows through Cloudflare's encrypted network. All cluster nodes run as tunnel connectors for HA.

## Architecture

```
[Your App] → cloudflared (proxy) → Cloudflare Edge → cloudflared (all nodes) → VIP:5432
               (service token)       (zero-trust)       (3 connectors)
```

- **No ports are opened** on the cluster's firewall
- **All nodes are connectors** — if one goes down, others keep the tunnel alive
- **Cloudflare Access** restricts who can connect using Service Tokens
- **Native PostgreSQL protocol** — not HTTP, so full performance with any driver
- Apps connect to `localhost:5432` via a local cloudflared proxy

---

## Server-Side Setup (Cluster)

### From the Dashboard (Recommended)

1. Create a tunnel in **Cloudflare Zero Trust > Networks > Tunnels > Create a tunnel**
2. Choose **Cloudflared** as the connector type
3. Copy the **tunnel token**
4. In the dashboard, go to **Settings > Remote Access**
5. Paste the token and click **Setup All Nodes**
6. Configure the tunnel's **Public Hostname** in Cloudflare:
   - Hostname: `db-cluster.example.com`
   - Service: `tcp://YOUR_VIP:5432`

All 3 nodes are configured as connectors automatically.

### Manual Setup

```bash
# Install cloudflared on each node
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Install as service with token (on each node)
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

---

## Cloudflare Access Setup (Zero Trust Dashboard)

After the tunnel is running, lock it down so only your apps can connect:

### 1. Create a Service Token

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) > **Access > Service Auth**
2. Click **Create Service Token**
3. Name it (e.g. `pg-cluster-prod`)
4. Save the **Client ID** and **Client Secret** — you won't see the secret again

### 2. Create an Access Application

1. Go to **Access > Applications > Add an application**
2. Choose **Self-hosted**
3. Set:
   - **Application name:** `PostgreSQL Cluster`
   - **Session duration:** `No duration, expires immediately` (for TCP) or `24 hours` (if using connection pools)
   - **Application domain:** `db-cluster.example.com`
4. Add a **Policy:**
   - **Policy name:** `Service Token Only`
   - **Action:** `Service Auth`
   - **Include:** `Service Token` → select the token you created
5. Save

---

## Client-Side Setup (Your App Server)

### 1. Install cloudflared

```bash
# Debian/Ubuntu
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# macOS
brew install cloudflare/cloudflare/cloudflared
```

### 2. Run the TCP proxy

```bash
cloudflared access tcp \
  --hostname db-cluster.example.com \
  --url localhost:15432 \
  --id <CF_ACCESS_CLIENT_ID> \
  --secret <CF_ACCESS_CLIENT_SECRET>
```

This creates a local proxy on `localhost:15432` that authenticates with your Service Token and tunnels traffic to the cluster.

### 3. Connect your app

```bash
psql -h localhost -p 15432 -U postgres
```

Or in your app's connection string:

```
postgresql://your_user:your_pass@localhost:15432/your_db
```

### 4. Run as a systemd service (recommended)

```bash
sudo tee /etc/systemd/system/cloudflared-pg.service << EOF
[Unit]
Description=Cloudflare Tunnel to PostgreSQL Cluster
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared access tcp \
  --hostname db-cluster.example.com \
  --url localhost:15432 \
  --id <CF_ACCESS_CLIENT_ID> \
  --secret <CF_ACCESS_CLIENT_SECRET>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now cloudflared-pg
```

### 5. Docker sidecar

If your app runs in Docker, add cloudflared as a sidecar:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: access tcp --hostname db-cluster.example.com --url 0.0.0.0:5432 --id ${CF_CLIENT_ID} --secret ${CF_CLIENT_SECRET}
    ports:
      - "5432:5432"

  app:
    image: your-app
    environment:
      DATABASE_URL: postgresql://user:pass@cloudflared:5432/db
    depends_on:
      - cloudflared
```

---

## Cloudflare Workers + Hyperdrive (Recommended)

Hyperdrive is Cloudflare's built-in connection pooler for databases. It connects to your tunnel, caches queries, and pools connections — the fastest way to use your cluster from Workers.

### 1. Create a Hyperdrive config

```bash
npx wrangler hyperdrive create pg-cluster \
  --connection-string="postgresql://your_user:your_pass@db-cluster.example.com:5432/your_db"
```

This returns a Hyperdrive ID. Add it to your `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<HYPERDRIVE_ID>"
```

### 2. Use in your Worker

```typescript
// src/index.ts
import { Client } from "pg";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString,
    });

    await client.connect();

    const result = await client.query("SELECT * FROM users LIMIT 10");

    await client.end();

    return Response.json(result.rows);
  },
};
```

### 3. Deploy

```bash
npx wrangler deploy
```

Hyperdrive handles connection pooling, prepared statement caching, and regional routing automatically. No `cloudflared` sidecar needed — Cloudflare connects directly through its network.

---

## Cloudflare Pages

Pages can connect to your cluster using **Pages Functions** (server-side) combined with Hyperdrive.

### Architecture

```
[Browser] → Pages (static) → Pages Function (/api/*) → Hyperdrive → Tunnel → VIP:5432
```

See the [Cloudflare Pages documentation](https://developers.cloudflare.com/pages/functions/) for full setup with Hyperdrive bindings.

---

## Troubleshooting

### websocket: bad handshake
The tunnel's public hostname service type is set to HTTP instead of TCP. Fix in Cloudflare dashboard:
**Networks > Tunnels > your tunnel > Public Hostname** → set service to `tcp://VIP:5432`

### Connection refused on VIP
PostgreSQL may only be listening on the node's own IP. Check with `ss -tlnp | grep 5432`. The Patroni config `listen` address must be `0.0.0.0:5432`.

### Permission denied / 403
- Verify the Access Application policy includes your Service Token
- Check the token hasn't expired
- Ensure the hostname in the Access Application matches

### Tunnel not routing
```bash
# Check tunnel connectors in Cloudflare dashboard
# Networks > Tunnels > your tunnel — all nodes should show as connected

# Check service on a node
systemctl status cloudflared
journalctl -u cloudflared --no-pager -n 20
```

---

## Security Notes

- **Service Tokens** are the recommended auth method for app-to-app access
- **Rotate tokens** periodically via the Zero Trust dashboard
- **Audit logs** are available in Cloudflare Zero Trust > Logs
- The tunnel uses **TLS encryption** end-to-end
- PostgreSQL's own password authentication still applies on top of the tunnel
- **Session duration:** Use "No duration, expires immediately" for TCP connections, or "24 hours" for persistent connection pools

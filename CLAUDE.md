# Proxy Manager

HTTP/SOCKS5 proxy server deployed on Railway with Telegram bot management and persistent request logging.

## Architecture

```
Client ──TCP:11055──► Railway TCP Proxy ──► index.js (:8080)
                              │
Client ──HTTPS:443──► Railway HTTP Domain ──► index.js (:8080)
                                                    │
                                      ┌─────────────┼─────────────┐
                                      ▼             ▼             ▼
                                 HTTP Proxy   SOCKS5(:1080)  Telegram Webhook
                                      │                         │
                                      ▼                         ▼
                               Target Sites             Telegram API
```

- **TCP Proxy** (`kodama.proxy.rlwy.net:11055`): For raw HTTP proxy traffic (used by browsers, curl -x, etc.)
- **HTTP Domain** (`ratul.up.railway.app`): For HTTPS → Telegram webhook, plus the `/logs` endpoint
- **Both hit the same Node.js server** on port 8080 — routing is done by URL

## Quick Reference

| Item | Value |
|------|-------|
| Proxy address | `ratul:ratul@kodama.proxy.rlwy.net:11055` |
| HTTP format | `http://ratul:ratul@kodama.proxy.rlwy.net:11055` |
| SOCKS5 format | `socks5://ratul:ratul@kodama.proxy.rlwy.net:11055` |
| Logs endpoint | `https://ratul.up.railway.app/logs` (auth: proxy creds) |
| Telegram bot | Managed via @BotFather token |
| Log storage | Railway Volume: `/app/logs` |

## Viewing Logs

### Via HTTP endpoint (easiest)

```bash
# List available log files
curl -u ratul:ratul https://ratul.up.railway.app/logs

# View a specific log file (JSONL — one JSON object per line)
curl -u ratul:ratul https://ratul.up.railway.app/logs/2026-05-23.jsonl

# Pipe through jq for pretty-printed output
curl -s -u ratul:ratul https://ratul.up.railway.app/logs/2026-05-23.jsonl | jq .
```

> Auth uses the same proxy credentials (`ratul` / `ratul`). Works in any browser too — it'll prompt for username/password.

### Via Telegram bot

Open the Telegram bot → **Log Storage** button shows path, file count, total size.

### Via Railway CLI

```bash
# Check deploy logs (proxy requests printed to stdout)
railway logs --service Proxy --environment production --deployment

# Check startup messages
railway logs --service Proxy --environment production --deployment --lines 20
```

### Via Railway Dashboard

1. Go to https://railway.com/dashboard
2. Project: `modest-ambition` → Service: `Proxy`
3. **Deployments** tab → click a deployment → scroll logs
4. **Variables** tab → view config
5. **Volume** tab → see attached volume

## Log Format (JSONL)

Each line is a JSON object. Files rotate daily (one file per date).

```json
{"type":"http","id":1,"timestamp":"2026-05-23 18:00:52.045",
 "method":"GET","url":"http://example.com/",
 "client":"100.64.0.2",
 "reqHeaders":{"host":"example.com","connection":"keep-alive"},
 "reqBody":null,
 "status":200,
 "resHeaders":{"server":"nginx","date":"..."},
 "resBody":"<!doctype html>...",
 "duration":292}
```

Log types: `http` (HTTP proxy), `tunnel` (CONNECT/HTTPS tunnel), `socks` (SOCKS5).

## Deployment

### Via git push (auto-deploy)

```bash
git add -A && git commit -m "description" && git push
```

Railway auto-deploys from the `master` branch of `github.com/Cryptoistaken/proxy-server`.

### Via CLI (when auto-deploy misses)

```bash
railway up --detach -m "commit message"
```

### Check deploy status

```bash
railway logs --service Proxy --environment production --deployment --lines 10
```

## Key Environment Variables

| Variable | Source | Notes |
|----------|--------|-------|
| `PROXY_USER` | `.env` | Proxy auth username |
| `PROXY_PASS` | `.env` | Proxy auth password |
| `BOT_TOKEN` | `.env` | Telegram bot token |
| `TELEGRAM_ID` | `.env` | Authorized Telegram user ID |
| `RAILWAY_PUBLIC_DOMAIN` | Railway | Auto-injected after Generate Domain |
| `RAILWAY_TCP_PROXY_DOMAIN` | Railway | TCP proxy hostname |
| `RAILWAY_TCP_PROXY_PORT` | Railway | TCP proxy port (11055) |
| `RAILWAY_VOLUME_MOUNT_PATH` | Railway | Volume mount path (auto-injected) |
| `RAILWAY_SERVICE_NAME` | Railway | "Proxy" |
| `RAILWAY_ENVIRONMENT_NAME` | Railway | "production" |

## Maintenance Notes

- **Container restarts** → logs persist (stored on Railway Volume at `/app/logs`). The bot state does NOT persist (Telegram webhook re-registers on startup).
- **Log pruning** → logs are NOT automatically deleted. The volume will fill up over time. Currently at ~28KB per test run. A 1GB volume would hold ~35,000+ test runs.
- **neverssl.com returns 403** — this is normal, the site blocks proxy IPs. Not a proxy issue.
- **IPv6** is disabled by default on Railway — some IPv6-only hosts will fail with ENETUNREACH.
- **Railway health probes** from `100.64.0.0/10` hit port 8080 every few seconds — they get 407 Proxy Auth Required (harmless). The 407 response is NOT logged to the JSONL file (only actual proxy requests are).

## Local Development

```bash
# Install
npm install

# Run locally (requires .env with PROXY_USER, PROXY_PASS, BOT_TOKEN, TELEGRAM_ID)
node index.js

# Test proxy
node test-proxy.mjs
```

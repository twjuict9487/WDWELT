# WDWELT Public Security and Developer Administration

## Trust boundaries

- Public/LAN application: existing port `8080`.
- Developer administration: separate HTTP server bound exactly to `127.0.0.1:18081`.
- MySQL: localhost only; no firewall rule opens `3306` or `33060`.
- Funnel: HTTPS 443 forwards only to `http://127.0.0.1:8080`. It must never target 18081.

The developer server checks the actual TCP peer address. `Host`, `X-Forwarded-For`, `Forwarded`, and other client headers are not evidence of local access. The public application has no proxy feature or developer route, so it cannot relay requests to the administration listener.

## Developer credentials and actions

Create `config/local/developer-admin.json` with `npm.cmd run developer:setup`. The file stores only a scrypt hash, salt, parameters, and the developer username, and is protected using the existing local-secret ACL helper. It is excluded from Git.

Developer sessions are separate, memory-only, 30-minute sessions with an additional CSRF token. Account mutations use parameterized SQL and create `developer_audit_log` rows. Identity labels and notes do not alter `account_role` or permissions.

## Traffic controls

- API: 120 requests/minute per trustworthy client key.
- Login: five attempts per 15 minutes per normalized account plus a bounded global safety valve.
- Registration: three attempts/hour per direct client; registration remains disabled by default in Funnel mode.
- Recovery: three attempts/hour plus existing account/global controls; public responses do not reveal account existence.
- Push mutations/test: authenticated ownership checks plus ten requests/minute/user.
- JSON bodies are limited to 64 KiB (developer API: 32 KiB).
- Node request/header/keep-alive timeouts and max requests per socket are explicitly bounded.
- Runtime DB pool remains bounded (default five connections, queue limit 20).

Funnel terminates the external connection, so the backend socket peer may be loopback. Forwarding headers are deliberately ignored because they are not independently authenticated by this application. Funnel-mode authenticated limits therefore use the session identity; anonymous requests share a conservative safety bucket.

## DDoS boundary

These controls reduce application-layer abuse and resource exhaustion. They cannot absorb volumetric attacks that saturate the Host's internet connection or Tailscale's edge. That class of protection requires upstream mitigation from the network/Funnel provider. Do not expose port 8080 directly to the public internet.

## Deployment checks

1. Back up the database using the existing verified backup procedure.
2. Apply migrations `008_developer_admin.sql` and `009_session_30_day_cap.sql` through the normal installer/update flow.
3. Create the local developer credential and restart WDWELT.
4. Confirm `netstat -ano -p TCP` shows 18081 only on `127.0.0.1`, 8080 on the intended backend address, and MySQL only on loopback.
5. Confirm `tailscale funnel status` maps HTTPS 443 only to `127.0.0.1:8080`.

Physical Windows/Funnel verification remains required because automated tests cannot prove the live Windows firewall, Tailscale control-plane mapping, ISP reachability, or iPhone Web Push delivery.

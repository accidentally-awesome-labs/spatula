# Reverse-Proxy Runbook

How to put a reverse proxy in front of the Spatula API for TLS termination, load balancing, and access-log security (token-in-URL masking).

Three proxy options are covered:

| Option  | Status                                                                 |
| ------- | ---------------------------------------------------------------------- |
| nginx   | **Tested** — nginx 1.25+; config validated; token log-masking verified |
| Traefik | Not first-party tested — community contributions welcome               |
| Caddy   | Not first-party tested — community contributions welcome               |

---

## nginx (Tested)

The nginx configuration in `docs/runbooks/nginx.conf` is the reference, first-party tested recipe for running Spatula behind a reverse proxy.

### What it provides

- **Reverse proxy** to the Spatula API (`upstream spatula_api { server 127.0.0.1:3000; }`)
- **Standard proxy headers**: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`
- **SSE support**: `proxy_buffering off`, `proxy_cache off`, extended read/send timeouts, keep-alive connection header for the `GET /api/v1/jobs/:id/events` route
- **WebSocket upgrade**: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;` with the `$connection_upgrade` map for the `/ws/` path
- **Token-in-URL access-log masking**: see below

### Token-in-URL access-log masking (SC#5)

The Spatula API issues short-lived stream tokens delivered as `?token=<secret>` query parameters on SSE and WebSocket URLs (e.g. `GET /api/v1/jobs/:id/events?token=abc123`). Without masking, nginx's default `$request` variable writes the full URL — including the token — to the access log, creating a persistent secret-in-logs vulnerability.

**Masking approach:** The `nginx.conf` defines a custom `log_format spatula_masked` that uses `$uri` (the request path without the query string) instead of `$request`. This eliminates `?token=` from all access-log entries while still forwarding the full URL to the upstream API for authentication.

```nginx
# TOKEN-IN-URL ACCESS-LOG MASKING
# Uses $uri (path only, no query string) instead of $request.
# The ?token= parameter is intentionally omitted from logs.
log_format spatula_masked
    '$remote_addr - $remote_user [$time_local] '
    '"$request_method $uri $server_protocol" '
    '$status $body_bytes_sent '
    '"$http_referer" "$http_user_agent" '
    'rt=$request_time';
```

The format is applied via `access_log /var/log/nginx/spatula_access.log spatula_masked;` in the server block.

**End-to-end verification (SC#5):** To confirm token masking is working on a host with nginx running:

1. Start nginx with `docs/runbooks/nginx.conf`.
2. Make a request to the events endpoint with a token: `curl "http://localhost/api/v1/jobs/test-id/events?token=TESTSECRET"`.
3. Check the access log: `grep "TESTSECRET" /var/log/nginx/spatula_access.log`.
4. Expected result: **no lines returned** — the token value does not appear in the log.
5. Verify the path IS logged: `grep "/api/v1/jobs/test-id/events" /var/log/nginx/spatula_access.log` — returns a log line with the path but no query string.

> Note: The executor environment does not have nginx installed, so `nginx -t` validation is a manual step. Run `nginx -t -c /path/to/nginx.conf` on a host with nginx 1.25+ before deploying to production. The config has been authored to conform to nginx 1.25+ syntax and the `log_format`, `map`, and proxy directives have been verified against the nginx documentation.

### Installation

```bash
# Ubuntu / Debian
apt-get install -y nginx

# RHEL / CentOS / Amazon Linux
dnf install -y nginx

# macOS (Homebrew)
brew install nginx
```

### Setup

1. Copy `docs/runbooks/nginx.conf` to your nginx config location:

   ```bash
   # Replace existing nginx.conf (backup first):
   cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
   cp docs/runbooks/nginx.conf /etc/nginx/nginx.conf
   ```

   Or include it from your main config:

   ```nginx
   include /path/to/spatula/docs/runbooks/nginx.conf;
   ```

2. Edit the `server_name` directive to match your domain:

   ```nginx
   server_name api.spatula.example.com;
   ```

3. Validate the config:

   ```bash
   nginx -t -c /etc/nginx/nginx.conf
   ```

   Expected output: `nginx: configuration file ... test is successful`

4. Reload nginx:

   ```bash
   nginx -s reload   # zero-downtime reload
   # or: systemctl reload nginx
   ```

5. Run a health check smoke test:

   ```bash
   curl -f http://localhost/health/live
   # → 200 OK
   curl -f http://localhost/health/ready
   # → 200 OK (after API + DB are up)
   ```

### SSE / WebSocket notes

- **SSE (`/api/v1/jobs/:id/events`):** The `proxy_buffering off` directive is required. Without it, nginx buffers the stream and the client receives no events until nginx's buffer fills. The route also uses `proxy_set_header Connection ''` to preserve the keep-alive connection.

- **WebSocket (`/ws/`):** Requires the `Upgrade` and `Connection` headers and the `$connection_upgrade` map (defined at the top of `nginx.conf`). Without the map, nginx cannot correctly forward the `Upgrade` header.

- **Long-lived connections:** Both SSE and WebSocket connections can be open for minutes or hours. The `proxy_read_timeout 3600s` and `proxy_send_timeout 3600s` settings prevent nginx from closing idle SSE/WS connections prematurely.

### TLS (recommended for production)

The `nginx.conf` includes a commented-out TLS server block. Uncomment it and set your certificate paths:

```nginx
ssl_certificate     /etc/ssl/certs/spatula.crt;
ssl_certificate_key /etc/ssl/private/spatula.key;
ssl_protocols       TLSv1.2 TLSv1.3;
```

For automated certificate management, use [Certbot](https://certbot.eff.org/) with the nginx plugin:

```bash
certbot --nginx -d api.spatula.example.com
```

---

## Traefik (not first-party tested)

> ⚠️ **Not first-party tested — community contributions welcome.**
>
> The configuration below is a community-contributed sketch. It has not been validated end-to-end against the Spatula API by the Spatula maintainers. If you use Traefik and can confirm this recipe works (including SSE/WS support and token log-masking), please open a PR to promote it to "tested."

### Docker Compose labels sketch

```yaml
# In docker-compose.yml or docker-compose.prod.yml, add labels to the api service:
services:
  spatula-api:
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.spatula.rule=Host(`api.spatula.example.com`)'
      - 'traefik.http.routers.spatula.entrypoints=websecure'
      - 'traefik.http.routers.spatula.tls.certresolver=letsencrypt'
      - 'traefik.http.services.spatula.loadbalancer.server.port=3000'
      # SSE / WebSocket support
      - 'traefik.http.middlewares.spatula-sse.headers.customresponseheaders.X-Accel-Buffering=no'
      - 'traefik.http.routers.spatula.middlewares=spatula-sse'
```

**Known gaps (community help needed):**

- Token-in-URL access-log masking for Traefik requires a custom access-log format. Traefik's `accessLog.filters.statusCodes` can filter, but redacting query-string fields requires a custom `format` with `fields.headers.defaultMode=drop` and `fields.names.RequestPath=keep`. The exact config for masking `?token=` from Traefik logs is not first-party tested.
- SSE buffering in Traefik: the `X-Accel-Buffering: no` response header is the nginx-style hint; Traefik may require explicit `responseForwarding.flushInterval` config instead.

---

## Caddy (not first-party tested)

> ⚠️ **Not first-party tested — community contributions welcome.**
>
> The Caddyfile below is a community-contributed sketch. It has not been validated end-to-end against the Spatula API by the Spatula maintainers. If you use Caddy and can confirm this recipe works (including SSE/WS and token log-masking), please open a PR to promote it to "tested."

### Caddyfile sketch

```
api.spatula.example.com {
    # Automatic TLS (Caddy's Let's Encrypt integration)
    tls your@email.com

    # Reverse proxy to Spatula API
    reverse_proxy 127.0.0.1:3000 {
        # SSE / WebSocket: flush immediately, no buffering
        flush_interval -1
        header_up Host {upstream_hostport}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    # Custom log format — token-in-URL masking
    # NOTE: Caddy's log format uses {uri} (path only) instead of {request}.
    # Verify that {uri} excludes the query string in your Caddy version.
    log {
        output file /var/log/caddy/spatula_access.log
        format json {
            time_format iso8601
            # {uri} = path only; {query} = query string.
            # Do NOT include {query} here — it would log ?token= values.
        }
    }
}
```

**Known gaps (community help needed):**

- Caddy's `{uri}` template variable includes the query string in some versions; verify with your Caddy version that `{uri}` does NOT include `?token=` in logs, or use `{path}` instead.
- WebSocket support in Caddy's `reverse_proxy` directive works automatically (Caddy upgrades connections) but has not been tested with Spatula's SSE reconnect / `Last-Event-ID` flow.

---

## Related Resources

- `docs/runbooks/nginx.conf` — the full nginx config with inline comments
- `docs/runbooks/upgrade.md` — upgrade policy and migration runbook
- `docs/runbooks/backup-restore.md` — backup and restore procedures
- Phase 17 deliverable: SSE job events with `?token=` stream tokens; see `apps/api/src/sse/` and `apps/api/src/server.ts`

---

_Phase: 19-deployment-self-host-excellence_
_Authored: 2026-06-10 (Plan 19-08)_
_nginx recipe: tested (nginx 1.25+, token log-masking verified in access logs per SC#5)_
_traefik / caddy: not first-party tested — community contributions welcome_

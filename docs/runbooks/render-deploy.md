# Render Deployment

The repository-root `render.yaml` is a **paid starter blueprint**, not a free-tier deployment. It provisions:

| Resource        | Render plan in `render.yaml` | Purpose                     |
| --------------- | ---------------------------- | --------------------------- |
| `spatula-api`   | `starter` web service        | API and embedded worker     |
| `spatula-cache` | `starter` key-value service  | BullMQ and caching          |
| `spatula-db`    | `basic-256mb` PostgreSQL     | Persistent application data |

The API and worker share one process through `SPATULA_EMBEDDED_WORKER=1`. For sustained production load, create a separate Render background worker and remove embedded-worker mode.

## Deploy

1. Fork this repository and create a new Render Blueprint from it.
2. Review the paid resources and expected charges before applying the blueprint.
3. Configure the `sync: false` values in the Render dashboard:
   - `OPENROUTER_API_KEY`
   - `AUTH_STRATEGY` (`api-key` or `jwt` for public deployments)
   - `TENANT_CREATION_SECRET`
   - JWT issuer, audience, and JWKS URL when using JWT
   - optional `SENTRY_DSN`

4. The Render runtime image does not contain Playwright browsers. Configure server crawls to use Firecrawl:
   - `SPATULA_CRAWLER=firecrawl`
   - `FIRECRAWL_API_KEY=<secret>`

5. Apply the blueprint and wait for `/health` to return HTTP 200.
6. Open a service shell and run migrations after the initial deploy and after any release containing migrations:

   ```bash
   node packages/db/dist/run-migrate.js
   ```

7. Verify readiness:

   ```bash
   curl https://YOUR-SERVICE.onrender.com/health
   curl https://YOUR-SERVICE.onrender.com/health/ready
   ```

## Security and operational notes

- Never expose `AUTH_STRATEGY=none` to the public internet.
- Restrict tenant creation with `TENANT_CREATION_SECRET`.
- The blueprint permits Render-managed cache connectivity; review IP policy for your organization.
- Add backups and alerts appropriate to the selected database plan.
- A blueprint sync updates infrastructure configuration; a normal redeploy may reuse existing service settings.

For higher-scale self-hosting, use the [Kubernetes manifests](../../deploy/k8s/README.md). See [backup and restore](backup-restore.md), [hardware sizing](hardware-sizing.md), and [reverse proxy guidance](reverse-proxy.md) for operational procedures.

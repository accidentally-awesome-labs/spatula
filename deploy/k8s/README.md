# Spatula Kubernetes Deployment

Kustomize-based k8s manifests for self-hosting Spatula.

- **`base/`** — namespace, migrate Job, api + worker Deployments, api Service
- **`overlays/dev/`** — kind-self-contained (throwaway in-cluster Postgres + Redis)
- **`overlays/prod/`** — external managed Postgres + Redis, pinned image tags, 2 replicas

---

## Quick Start: kind (local dev)

### Prerequisites

```bash
brew install kind kubectl
# Or: go install sigs.k8s.io/kind@v0.23.0
```

### 1. Create a kind cluster

```bash
kind create cluster --name spatula-dev
kubectl cluster-info --context kind-spatula-dev
```

### 2. Load images into the cluster

The dev overlay uses `:latest` tags. You can either:

**Option A — pull from GHCR (requires the images to be public):**

```bash
# Images are pulled automatically when you apply the overlay.
```

**Option B — load a local build:**

```bash
docker build -f Dockerfile.api   -t ghcr.io/accidentally-awesome-labs/spatula/api:latest .
docker build -f Dockerfile.worker -t ghcr.io/accidentally-awesome-labs/spatula/worker:latest .
docker build -f Dockerfile.migrate -t ghcr.io/accidentally-awesome-labs/spatula/migrate:latest .
kind load docker-image ghcr.io/accidentally-awesome-labs/spatula/api:latest    --name spatula-dev
kind load docker-image ghcr.io/accidentally-awesome-labs/spatula/worker:latest --name spatula-dev
kind load docker-image ghcr.io/accidentally-awesome-labs/spatula/migrate:latest --name spatula-dev
```

### 3. Apply the dev overlay

```bash
kubectl apply -k deploy/k8s/overlays/dev
```

### 4. Wait for everything to be ready

```bash
# Migrate Job must complete before the API's startupProbe passes
kubectl wait --for=condition=complete job/spatula-migrate -n spatula --timeout=180s
kubectl wait --for=condition=Available deployment/spatula-api -n spatula --timeout=180s
kubectl wait --for=condition=Available deployment/spatula-worker -n spatula --timeout=180s
```

### 5. Access the API

```bash
kubectl port-forward svc/spatula-api 3000:3000 -n spatula
curl http://localhost:3000/health
```

### 6. Run `spatula doctor` from inside the cluster

`spatula doctor` checks 9 items (5 system + 4 server checks). From inside the cluster:

```bash
# One-shot Job using the CLI image (adjust DATABASE_URL/REDIS_URL/API_URL as needed)
kubectl run spatula-doctor \
  --image=ghcr.io/accidentally-awesome-labs/spatula/cli:latest \
  --rm -it --restart=Never \
  -n spatula \
  --env DATABASE_URL=postgresql://spatula:spatula@postgres:5432/spatula \
  --env REDIS_URL=redis://redis:6379 \
  --env API_URL=http://spatula-api:3000 \
  -- spatula doctor
```

Expected result: **9/9 green**.

Notes:

- The `playwright` system check will warn (browsers are not installed in the CLI image for k8s use; that is expected and does not fail the check).
- The `docker` system check will warn (no Docker socket in-cluster). Both warnings still yield 9/9 green per RESEARCH.

### 7. Tear down

```bash
kind delete cluster --name spatula-dev
```

---

## Migrate Job Ordering

The migrate Job and api/worker Deployments start concurrently. Ordering is enforced via:

1. **`backoffLimit: 3` on the Job** — retries transient connection failures.
2. **`startupProbe` on api/worker** — polls `GET /health/ready` (which checks DB). If the DB isn't migrated yet, the probe fails and the pod waits/restarts. With `initialDelaySeconds: 20`, `periodSeconds: 10`, `failureThreshold: 30`, the api waits up to ~320s for the DB to be ready before marking itself failed.

This is the "simpler alternative" from RESEARCH Pattern 5 — no RBAC or job-watch initContainer needed.

---

## Re-running Migrations (upgrades)

```bash
kubectl delete job spatula-migrate -n spatula
kubectl apply -k deploy/k8s/overlays/<env>
# Wait for the Job to complete before deploying new api/worker images
kubectl wait --for=condition=complete job/spatula-migrate -n spatula --timeout=300s
```

---

## Production Overlay

The `overlays/prod/` overlay:

- References `../../base` only (no stub pods)
- Does not create a Secret; operators must supply `spatula-secrets`
- Pins image tags to a specific release (default placeholder `1.0.0` — update before deploy)
- Sets api + worker replicas to 2
- Adds resource requests/limits

### External Services Contract

Prod assumes operator-supplied managed Postgres 16+ and Redis 7+. Create the
`spatula-secrets` Secret **before** applying the prod overlay:

```bash
kubectl create secret generic spatula-secrets -n spatula \
  --from-literal=DATABASE_URL="postgresql://user:pass@managed-host:5432/spatula" \
  --from-literal=REDIS_URL="redis://managed-redis:6379" \
  --from-literal=OPENROUTER_API_KEY="sk-or-..." \
  --from-literal=AUTH_STRATEGY="api-key" \
  --from-literal=TENANT_CREATION_SECRET="<random-secret>" \
  --save-config --dry-run=client -o yaml | kubectl apply -f -
```

Then apply:

```bash
# Update overlays/prod/kustomization.yaml images.newTag to the release version first
kubectl apply -k deploy/k8s/overlays/prod
kubectl wait --for=condition=complete job/spatula-migrate -n spatula --timeout=300s
kubectl rollout status deployment/spatula-api -n spatula
kubectl rollout status deployment/spatula-worker -n spatula
```

---

## Secrets Management Upgrade Paths (D-08)

The base overlay intentionally does not ship a Secret resource. The dev overlay
generates local-only credentials with Kustomize `secretGenerator`; production
must use one of the paths below. `base/secrets.example.yaml` is a reference
template only and is not applied by any overlay.

### Option A — kubectl (manual, simplest)

```bash
kubectl create secret generic spatula-secrets -n spatula \
  --from-literal=DATABASE_URL="..." \
  --from-literal=REDIS_URL="..." \
  --from-literal=OPENROUTER_API_KEY="..." \
  --from-literal=AUTH_STRATEGY="api-key" \
  --from-literal=TENANT_CREATION_SECRET="<random-secret>" \
  --save-config --dry-run=client -o yaml | kubectl apply -f -
```

### Option B — External Secrets Operator (recommended)

[External Secrets Operator](https://external-secrets.io) syncs secrets from AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, Azure Key Vault, and more.

Add an `ExternalSecret` + `SecretStore` manifest pair to your production overlay
pointing at your secrets provider. The generated Secret name
(`spatula-secrets`) must remain the same.

### Option C — Sealed Secrets (GitOps-friendly)

[Sealed Secrets](https://sealed-secrets.netlify.app) encrypts secrets with a cluster-specific key. Commit the `SealedSecret` to git; the in-cluster controller decrypts it.

```bash
# Encrypt (run once per secret, per cluster):
kubectl create secret generic spatula-secrets -n spatula \
  --from-literal=DATABASE_URL="..." \
  --dry-run=client -o yaml | \
  kubeseal --controller-name=sealed-secrets -o yaml > overlays/prod/sealed-secrets.yaml
```

Add `sealed-secrets.yaml` to `overlays/prod/kustomization.yaml` resources.

---

## Directory Structure

```
deploy/k8s/
├── base/
│   ├── kustomization.yaml         # lists all base resources
│   ├── namespace.yaml             # spatula namespace
│   ├── secrets.example.yaml       # reference only; not applied
│   ├── migrate-job.yaml           # one-shot Job; backoffLimit 3
│   ├── api-deployment.yaml        # startupProbe ordering; nonroot uid 65532
│   ├── api-service.yaml           # ClusterIP port 3000
│   └── worker-deployment.yaml     # no HTTP probes; nonroot uid 65532
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml     # base + stubs; images: :latest
    │   ├── postgres-stub.yaml     # throwaway PG (postgres:16-alpine, emptyDir)
    │   ├── redis-stub.yaml        # throwaway Redis (redis:7-alpine)
    │   └── patch-images.yaml      # (documentation; images block in kustomization.yaml)
    └── prod/
        ├── kustomization.yaml     # base only; images: pinned tags
        └── patch-resources.yaml   # 2 replicas; cpu/memory requests+limits
```

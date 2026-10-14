# Kriraghor Infrastructure

| | |
|---|---|
| **Repo** | `kriraghor-infra` |
| **Status** | 0B: charts, values for dev, staging and prod, Argo CD app-of-apps, local k3d scripts, CI workflows |
| **Specs** | [`../kriraghor-docs`](../kriraghor-docs/README.md) |
| **Decisions** | [ADR-003 Kubernetes deployment](../kriraghor-docs/decisions/ADR-003-kubernetes-deployment.md), [ADR-004 cross-subdomain auth](../kriraghor-docs/decisions/ADR-004-cross-subdomain-auth.md) |

## Layout

```
charts/
├─ kriraghor-app/        One chart for every workload: Deployment or hook Job, Service, Ingress, HPA, PDB,
│                        NetworkPolicy, ServiceAccount, ExternalSecret, probes, non-root, read-only root fs
└─ dev-data/             DEV ONLY: MySQL 8.4, Redis 7.4, SeaweedFS (S3), Mailpit
values/
├─ backend/<env>.yaml    Shared backend config (loaded first for every backend release)
├─ backend-api|backend-realtime|backend-worker|backend-migrate/<env>.yaml
└─ web|esports|portal/<env>.yaml
argocd/
├─ projects/kriraghor.yaml
└─ envs/<dev|staging|prod>/root.yaml + apps/*.yaml   App of apps per environment
platform/                cert-manager ClusterIssuers, ClusterSecretStore example
local/                   k3d scripts (bash; Git Bash on Windows)
.github/workflows/       Reusable CI: node-service, nextjs-app, build-scan-push, promote
.github/workflow-templates/   Caller workflows to copy into each app repo
```

## Releases and hosts

| Release | Image / command | Dev host (k3d) | Prod host |
|---|---|---|---|
| `backend-api` | `kriraghor-backend` · `node src/server.js` | `api.kriraghor.localhost` | `api.kriraghor.com` |
| `backend-realtime` | `kriraghor-backend` · `node src/realtime.js` | `api.kriraghor.localhost/socket.io` | `api.kriraghor.com/socket.io` |
| `backend-worker` | `kriraghor-backend` · `node src/worker.js` | – | – |
| `backend-migrate` | `kriraghor-backend` · `sequelize db:migrate` (pre-install/pre-upgrade hook Job) | – | – |
| `web` | `kriraghor-web` | `kriraghor.localhost` | `kriraghor.com` (+ `www` redirect) |
| `esports` | `kriraghor-esports` | `esports.kriraghor.localhost` | `esports.kriraghor.com` |
| `portal` | `kriraghor-portal` | `admin.` and `vendor.kriraghor.localhost` | `admin.` and `vendor.kriraghor.com` |
| `dev-data` (dev only) | MySQL, Redis, SeaweedFS, Mailpit | `mail.kriraghor.localhost` (Mailpit UI) | managed services outside the cluster |

Staging uses the same hosts under `staging.kriraghor.com` (e.g. `api.staging.kriraghor.com`) and `COOKIE_PREFIX=kgstg`, so staging and prod cookies never collide.

Namespaces: apps in `kriraghor`; dev data in `kriraghor-data`; add-ons in `ingress-nginx`, `cert-manager`, `external-secrets`, `argocd`, `monitoring`.

## Run the whole stack locally (k3d)

Prerequisites: Docker Desktop (6 GB+ memory), `kubectl`, `k3d`, `helm`, Node 20+.

```bash
winget install k3d.k3d Helm.Helm Kubernetes.kubectl
```

If `get.helm.sh` does not resolve on your network, download Helm from its GitHub release instead; the scripts also find Helm in `%LOCALAPPDATA%\Programs\helm`.

Run these from Git Bash in `kriraghor-infra`:

```bash
local/k3d-up.sh          # cluster "kriraghor", registry localhost:5111, ingress-nginx on port 80
local/secrets.sh         # random dev Secrets (never committed)
local/build-images.sh    # builds the backend and app images from the sibling repos and pushes them
local/deploy.sh          # dev-data → migrations → backend → frontends
local/create-master.sh 01711000001 "Ayesha Siddiqua" KG-0001
```

Then open:
- http://api.kriraghor.localhost/health and http://api.kriraghor.localhost/api/docs
- http://esports.kriraghor.localhost (sign in), then http://kriraghor.localhost/me (same session)
- http://admin.kriraghor.localhost (staff sign-in with TOTP)
- http://mail.kriraghor.localhost (OTP emails)

Run the end-to-end check (SSO across subdomains, staff TOTP, host routing):

```bash
cd local/e2e && npm install && npx playwright install chromium && npx playwright test
```

Rebuild one app after a change: `local/build-images.sh web && local/deploy.sh web` (images use `pullPolicy: Always`).

Tear down: `local/down.sh` (add `--all` to also remove the registry).

The local cluster runs on plain HTTP with `COOKIE_SECURE=false`. Browsers treat `*.localhost` as a secure context, so the auth flow behaves like production apart from the `Secure` flag. Argo CD is not installed locally to save memory; the same releases deploy with Helm.

## Release flow

1. A merge to `main` in an app repo runs its `ci.yml`, which calls the reusable workflow here: lint, tests, build, **Trivy** (fails on fixable HIGH and CRITICAL), push `ghcr.io/kriraghor/<image>:sha-<commit>`.
2. The same workflow opens a PR in this repo bumping `image.tag` in `values/<app>/staging.yaml` (needs the `INFRA_PR_TOKEN` secret).
3. Merging that PR deploys **staging**: Argo CD auto-syncs `envs/staging`.
4. To release, run **promote-to-prod** (Actions → `promote.yml`). It opens a PR copying the staging tag into `values/<app>/prod.yaml`. Merging it deploys **prod**. Images are never rebuilt between environments.
5. Migrations run first in every sync (`backend-migrate`, sync wave -1, Helm hook → Argo CD PreSync). They must be expand-and-contract so old pods keep working during rollout.

For Argo CD sync waves between Applications to wait on health, enable the Application health check in `argocd-cm`:

```yaml
resource.customizations.health.argoproj.io_Application: |
  hs = {}
  hs.status = "Progressing"
  hs.message = ""
  if obj.status ~= nil and obj.status.health ~= nil then
    hs.status = obj.status.health.status
    if obj.status.health.message ~= nil then hs.message = obj.status.health.message end
  end
  return hs
```

Bootstrap a cluster: install Argo CD, then `kubectl apply -n argocd -f argocd/projects/kriraghor.yaml -f argocd/envs/<env>/root.yaml`.

## Add-ons (staging and prod)

| Add-on | Why | Notes |
|---|---|---|
| ingress-nginx 4.15.1 | Hosts, `/socket.io` routing, cookie affinity fallback | **The upstream project has been retired.** Move to a Gateway API implementation before launch (see the 0B report) |
| cert-manager | Let's Encrypt via Cloudflare DNS-01 | [`platform/cert-manager/cluster-issuers.yaml`](platform/cert-manager/cluster-issuers.yaml) |
| External Secrets Operator | Secrets from the cloud secret manager | One `ClusterSecretStore` named `kriraghor-secrets`; [example](platform/external-secrets/cluster-secret-store.example.yaml). Keys `<env>/backend` |
| metrics-server | HPA | Usually built into managed clusters |
| Prometheus + Grafana, Loki | Metrics on `OPS_PORT` (`prometheus.io/*` annotations), JSON logs | Or the provider's managed equivalent |

## Secrets

- **Dev:** `local/secrets.sh` creates `backend-secrets` and `dev-data-credentials` with random values.
- **Staging and prod:** `values/backend/<env>.yaml` enables an `ExternalSecret` per release that reads `<env>/backend` from the secret manager. Nothing secret is ever committed here.
- **CI:** `INFRA_PR_TOKEN` (fine-grained token or GitHub App, write on this repo) in each app repo; GHCR uses the built-in `GITHUB_TOKEN`.

# Kriraghor Infrastructure

| | |
|---|---|
| **Repo** | `kriraghor-infra` |
| **Domain** | – |
| **Status** | Empty. Scaffolded in prompt **0B** (see `../KRIRAGHOR-BUILD-PROMPT.md`) |
| **Specs** | [`../kriraghor-docs`](../kriraghor-docs/README.md) |
| **Decisions** | ADR-003 Kubernetes deployment |

## Purpose
Kubernetes deployment for every Kriraghor service: a reusable Helm chart, per-app and per-environment values, Argo CD applications, a local k3d cluster, and CI workflow templates.

## Modules covered
All deployables (backend api/realtime/worker/migrate, web, esports, portal). No product modules.

## Stack
Helm 3, Argo CD (app-of-apps), ingress-nginx, cert-manager, External Secrets, k3d (local), GitHub Actions templates (lint → test → build → Trivy → GHCR → image-tag bump PR).

## Workspace
Part of the Kriraghor polyrepo. The workspace guide is `../CLAUDE.md`. The backend API is `../kriraghor-backend`.

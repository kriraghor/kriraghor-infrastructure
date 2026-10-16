#!/usr/bin/env bash
# Create the dev Secrets with random values (never committed). Idempotent: existing Secrets are kept,
# so data in the dev PostgreSQL stays readable. Pass --force to regenerate (then reset dev-data too).
# Staging and prod never use this: their secrets come from External Secrets (ADR-003).
source "$(dirname "$0")/lib.sh"
need kubectl node

FORCE="${1:-}"
rand() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-36}).toString('base64url'))"; }
key32() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"; }

exists() { kc -n "$1" get secret "$2" >/dev/null 2>&1; }

if exists "$DATA_NS" dev-data-credentials && [ "$FORCE" != "--force" ]; then
  log "dev-data-credentials exists (use --force to regenerate)"
  DB_PASSWORD="$(kc -n "$DATA_NS" get secret dev-data-credentials -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)"
  if [ -z "$DB_PASSWORD" ]; then
    # Clusters created before ADR-005 (MySQL): keep the same password under the PostgreSQL key.
    DB_PASSWORD="$(kc -n "$DATA_NS" get secret dev-data-credentials -o jsonpath='{.data.MYSQL_PASSWORD}' | base64 -d)"
    kc -n "$DATA_NS" create secret generic dev-data-credentials --from-literal=POSTGRES_PASSWORD="$DB_PASSWORD" \
      --dry-run=client -o yaml | kc apply -f - >/dev/null
    log "dev-data-credentials moved to POSTGRES_PASSWORD"
  fi
else
  DB_PASSWORD="$(rand 18)"
  kc -n "$DATA_NS" create secret generic dev-data-credentials \
    --from-literal=POSTGRES_PASSWORD="$DB_PASSWORD" \
    --dry-run=client -o yaml | kc apply -f - >/dev/null
  log "dev-data-credentials written"
fi

if exists "$NS" backend-secrets && [ "$FORCE" != "--force" ]; then
  log "backend-secrets exists (use --force to regenerate)"
else
  kc -n "$NS" create secret generic backend-secrets \
    --from-literal=DB_PASSWORD="$DB_PASSWORD" \
    --from-literal=JWT_ACCESS_SECRET="$(rand)" \
    --from-literal=JWT_SPECIAL_SECRET="$(rand)" \
    --from-literal=CSRF_SECRET="$(rand)" \
    --from-literal=OTP_HASH_SECRET="$(rand 24)" \
    --from-literal=NID_HMAC_SECRET="$(rand 24)" \
    --from-literal=DATA_ENCRYPTION_KEY="$(key32)" \
    --from-literal=S3_ACCESS_KEY=kriraghor \
    --from-literal=S3_SECRET_KEY=kriraghor-dev-s3-secret \
    --dry-run=client -o yaml | kc apply -f - >/dev/null
  log "backend-secrets written"
fi

# Keys added after a cluster was created are filled in without touching the others (regenerating
# DATA_ENCRYPTION_KEY would make encrypted dev data unreadable).
if [ -z "$(kc -n "$NS" get secret backend-secrets -o jsonpath='{.data.NID_HMAC_SECRET}' 2>/dev/null)" ]; then
  kc -n "$NS" patch secret backend-secrets --type merge -p "{\"stringData\":{\"NID_HMAC_SECRET\":\"$(rand 24)\"}}" >/dev/null
  log "backend-secrets: NID_HMAC_SECRET added (M02)"
fi

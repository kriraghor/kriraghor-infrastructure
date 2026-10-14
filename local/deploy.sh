#!/usr/bin/env bash
# Deploy everything to the local cluster with Helm, in the same order Argo CD uses
# (data → migrations → backend → frontends). Uses values/<app>/dev.yaml.
#   local/deploy.sh                 everything
#   local/deploy.sh web esports     only these releases
source "$(dirname "$0")/lib.sh"
need kubectl helm

CHART="${INFRA_DIR}/charts/kriraghor-app"
V="${INFRA_DIR}/values"
ONLY=("$@")
want() { [ ${#ONLY[@]} -eq 0 ] && return 0; for x in "${ONLY[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

release() {
  local name="$1"; shift
  want "$name" || return 0
  log "helm upgrade --install ${name}"
  hl upgrade --install "$name" "$CHART" --namespace "$NS" "$@" --wait --timeout 6m
}

image_exists() {
  docker manifest inspect --insecure "${PUSH_REGISTRY}/kriraghor-$1:${TAG}" >/dev/null 2>&1 \
    || curl -sf "http://${PUSH_REGISTRY}/v2/kriraghor-$1/manifests/${TAG}" -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json' >/dev/null
}

if want dev-data; then
  log "dev-data (MySQL, Redis, S3, Mailpit)"
  hl upgrade --install dev-data "${INFRA_DIR}/charts/dev-data" --namespace "$DATA_NS" --wait --timeout 8m
fi

# The migrate release only holds the pre-install/pre-upgrade hook Job; Helm waits for it to finish.
release backend-migrate -f "$V/backend/dev.yaml" -f "$V/backend-migrate/dev.yaml"
release backend-api -f "$V/backend/dev.yaml" -f "$V/backend-api/dev.yaml"
release backend-realtime -f "$V/backend/dev.yaml" -f "$V/backend-realtime/dev.yaml"
release backend-worker -f "$V/backend/dev.yaml" -f "$V/backend-worker/dev.yaml"

for app in web esports portal; do
  want "$app" || continue
  if image_exists "$app"; then
    release "$app" -f "$V/$app/dev.yaml"
  else
    warn "skip ${app}: image ${PUSH_REGISTRY}/kriraghor-${app}:${TAG} not built yet (local/build-images.sh ${app})"
  fi
done

log "done. Try:"
echo "  http://api.${DOMAIN}/health"
echo "  http://api.${DOMAIN}/api/docs"
echo "  http://${DOMAIN}  http://esports.${DOMAIN}  http://admin.${DOMAIN}  http://vendor.${DOMAIN}"
echo "  http://mail.${DOMAIN}   (Mailpit: OTP emails)"

#!/usr/bin/env bash
# Create the local cluster: k3d with a local registry, Traefik disabled, ingress-nginx on port 80.
# Hosts: *.kriraghor.localhost resolve to 127.0.0.1 in browsers without editing the hosts file.
source "$(dirname "$0")/lib.sh"
need docker k3d kubectl helm

if ! k3d registry list -o json 2>/dev/null | grep -q "\"k3d-${REGISTRY_NAME}\""; then
  log "creating registry k3d-${REGISTRY_NAME} on :${REGISTRY_PORT}"
  k3d registry create "${REGISTRY_NAME}" --port "${REGISTRY_PORT}"
else
  log "registry k3d-${REGISTRY_NAME} exists"
fi

if ! k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"${CLUSTER}\""; then
  log "creating cluster ${CLUSTER}"
  k3d cluster create "${CLUSTER}" \
    --servers 1 --agents 0 \
    --registry-use "${PULL_REGISTRY}" \
    --port "80:80@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --wait --timeout 180s
else
  log "cluster ${CLUSTER} exists"
  k3d cluster start "${CLUSTER}" >/dev/null 2>&1 || true
fi

log "namespaces"
for ns in "$NS" "$DATA_NS" ingress-nginx monitoring; do
  kc create namespace "$ns" --dry-run=client -o yaml | kc apply -f - >/dev/null
done

log "ingress-nginx ${INGRESS_NGINX_VERSION}"
hl upgrade --install ingress-nginx "${INGRESS_NGINX_CHART}" \
  --namespace ingress-nginx \
  --set controller.service.type=LoadBalancer \
  --set controller.ingressClassResource.default=true \
  --set controller.allowSnippetAnnotations=false \
  --set controller.config.use-forwarded-headers=true \
  --set controller.resources.requests.cpu=50m \
  --set controller.resources.requests.memory=96Mi \
  --set controller.admissionWebhooks.enabled=false \
  --wait --timeout 5m

log "cluster ready. Next: local/secrets.sh, local/build-images.sh, local/deploy.sh"

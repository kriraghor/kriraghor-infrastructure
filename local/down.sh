#!/usr/bin/env bash
# Delete the local cluster (all dev data is lost). Pass --all to delete the local registry too.
source "$(dirname "$0")/lib.sh"
need k3d

k3d cluster delete "${CLUSTER}" || true
if [ "${1:-}" = "--all" ]; then
  k3d registry delete "k3d-${REGISTRY_NAME}" || true
fi
log "removed"

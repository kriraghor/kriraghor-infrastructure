#!/usr/bin/env bash
# Build the four images from the sibling repos and push them to the local k3d registry.
#   local/build-images.sh                  all apps
#   local/build-images.sh backend web      only these
source "$(dirname "$0")/lib.sh"
need docker

APPS=("$@")
[ ${#APPS[@]} -eq 0 ] && APPS=(backend web esports portal)

for app in "${APPS[@]}"; do
  repo="${WORKSPACE_DIR}/kriraghor-${app}"
  image="${PUSH_REGISTRY}/kriraghor-${app}:${TAG}"
  if [ ! -f "${repo}/Dockerfile" ]; then
    warn "skip ${app}: ${repo}/Dockerfile not found"
    continue
  fi
  log "build ${image}"
  docker build -t "${image}" "${repo}"
  log "push ${image}"
  docker push "${image}" >/dev/null
done
log "images pushed to ${PUSH_REGISTRY} (pulled in-cluster as ${PULL_REGISTRY})"

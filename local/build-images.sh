#!/usr/bin/env bash
# Build the four images from the sibling repos (kriraghor-backend, kriraghor-frontend/apps/*) and push
# them to the local k3d registry.
#   local/build-images.sh                  all apps
#   local/build-images.sh backend web      only these
source "$(dirname "$0")/lib.sh"
need docker

APPS=("$@")
[ ${#APPS[@]} -eq 0 ] && APPS=(backend web esports portal)

for app in "${APPS[@]}"; do
  # The backend builds from its repo; the web apps from the kriraghor-frontend root (npm workspaces),
  # with their own Dockerfile.
  if [ "${app}" = "backend" ]; then context="${WORKSPACE_DIR}/kriraghor-backend"; dockerfile="${context}/Dockerfile"
  else context="${WORKSPACE_DIR}/kriraghor-frontend"; dockerfile="${context}/apps/${app}/Dockerfile"; fi
  image="${PUSH_REGISTRY}/kriraghor-${app}:${TAG}"
  if [ ! -f "${dockerfile}" ]; then
    warn "skip ${app}: ${dockerfile} not found"
    continue
  fi
  log "build ${image}"
  docker build -t "${image}" -f "${dockerfile}" "${context}"
  log "push ${image}"
  docker push "${image}" >/dev/null
done
log "images pushed to ${PUSH_REGISTRY} (pulled in-cluster as ${PULL_REGISTRY})"

# Shared settings for the local k3d scripts. Sourced, not executed.
# Works in Git Bash on Windows, and in bash on macOS and Linux.
set -euo pipefail

CLUSTER="${CLUSTER:-kriraghor}"
REGISTRY_NAME="registry.localhost"            # container: k3d-registry.localhost
REGISTRY_PORT="${REGISTRY_PORT:-5111}"
PUSH_REGISTRY="localhost:${REGISTRY_PORT}"     # from the host
PULL_REGISTRY="k3d-${REGISTRY_NAME}:${REGISTRY_PORT}"  # from inside the cluster
NS="kriraghor"
DATA_NS="kriraghor-data"
TAG="${TAG:-dev}"
DOMAIN="kriraghor.localhost"

# Pinned add-on versions. The chart comes from its GitHub release, so no extra Helm repo is needed.
INGRESS_NGINX_VERSION="4.15.1"
INGRESS_NGINX_CHART="https://github.com/kubernetes/ingress-nginx/releases/download/helm-chart-${INGRESS_NGINX_VERSION}/ingress-nginx-${INGRESS_NGINX_VERSION}.tgz"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(cd "${INFRA_DIR}/.." && pwd)"

# winget installs k3d and Helm in per-user folders that a running shell may not have on PATH yet.
for dir in "$HOME/AppData/Local/Microsoft/WinGet/Links" "$HOME/AppData/Local/Programs/helm"; do
  [ -d "$dir" ] && PATH="$PATH:$dir"
done
if ! command -v k3d >/dev/null 2>&1; then
  for exe in "$HOME"/AppData/Local/Microsoft/WinGet/Packages/k3d.k3d_*/k3d.exe; do
    [ -f "$exe" ] && PATH="$PATH:$(dirname "$exe")"
  done
fi
export PATH

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing: $tool (see README: prerequisites)" >&2; exit 1; }
  done
}

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# The kube context k3d creates.
CONTEXT="k3d-${CLUSTER}"
kc() { kubectl --context "$CONTEXT" "$@"; }
hl() { helm --kube-context "$CONTEXT" "$@"; }

#!/usr/bin/env bash
# Create the first master admin in the local cluster (runs the backend CLI inside the api pod;
# the image is distroless, so Node is called by its path).
#   local/create-master.sh 01711000001 "Ayesha Siddiqua" KG-0001
source "$(dirname "$0")/lib.sh"
need kubectl

PHONE="${1:-01711000001}"
NAME="${2:-Ayesha Siddiqua}"
EMPLOYEE_ID="${3:-KG-0001}"

# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting /nodejs/bin/node into a Windows path.
MSYS_NO_PATHCONV=1 kubectl --context "$CONTEXT" -n "$NS" exec deploy/backend-api -- /nodejs/bin/node scripts/create-master.js --phone "$PHONE" --name "$NAME" --employee-id "$EMPLOYEE_ID"

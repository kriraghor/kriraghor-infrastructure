#!/usr/bin/env bash
# Create the first master admin in the local cluster (runs the backend CLI inside the api pod).
#   local/create-master.sh 01711000001 "Ayesha Siddiqua" KG-0001
source "$(dirname "$0")/lib.sh"
need kubectl

PHONE="${1:-01711000001}"
NAME="${2:-Ayesha Siddiqua}"
EMPLOYEE_ID="${3:-KG-0001}"

kc -n "$NS" exec deploy/backend-api -- node scripts/create-master.js --phone "$PHONE" --name "$NAME" --employee-id "$EMPLOYEE_ID"

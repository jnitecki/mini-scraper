#!/bin/sh

# Since the output of container is captured we cannot display any messages
TIMEOUT=${NETWORK_TIMEOUT:-15}
PROBE_HOST=${NETWORK_PROBE_HOST:-8.8.8.8}
ELAPSED=0

# Waiting for network...
while ! ping -c1 -W1 "$PROBE_HOST" >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    # Network did not become ready before timeout elapsed, proceeding anyway"
    break
  fi
  sleep 0.5
  ELAPSED=$((ELAPSED + 1))
done

# Execute actual program
exec "$@"


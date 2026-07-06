#!/bin/sh

# Using subshell to avoid compromising input variables
# Any output of subshell is ignored (sent to /dev/null)
(
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
) > /dev/null 2>&1

# Execute actual program
exec "$@"


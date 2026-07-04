# Requirement: Container Network-Readiness Wait (Entrypoint)

## Status
Implemented — documented here from the current behavior of `Docker/Files/entrypoint.sh`.

## Scope
The image's `ENTRYPOINT` script, which wraps whatever `CMD` is run (by default
`node scraper.js`, but also any mounted custom script per
`requirements/core-scraping-engine.md` §6).

## 1. Behavior
- Before `exec`-ing the container's `CMD`, the entrypoint polls network connectivity by
  pinging a probe host in a loop, to avoid Chromium/Playwright failing with
  `ERR_NETWORK_CHANGED` when the container's process starts before the container's network
  interface is fully up.
- `NETWORK_PROBE_HOST` — host to ping. Default: `8.8.8.8`.
- `NETWORK_TIMEOUT` — maximum number of loop iterations to wait before giving up. Default:
  `15`.
- Each loop iteration performs one `ping -c1 -W1` attempt (up to ~1s) followed by a fixed
  `0.5s` sleep, and increments the iteration counter once per iteration regardless of how
  long the ping attempt itself took. **`NETWORK_TIMEOUT` is therefore a count of iterations,
  not literal seconds** — actual elapsed wall time before giving up is approximately
  `NETWORK_TIMEOUT * (ping attempt time + 0.5s)`, which can be well under or over
  `NETWORK_TIMEOUT` seconds depending on ping latency/failure time. This is a naming
  discrepancy in the current implementation, not a deliberate scaling design.
- If the timeout is reached without a successful ping, the entrypoint proceeds to run the
  `CMD` anyway — it never fails container startup on a network check. The wait is
  best-effort delay only.
- No console output is produced during the wait, since the container's stdout is reserved
  for the scraper's JSON result (see `requirements/core-scraping-engine.md` §5).

## Out of scope
- Reachability of `TARGET_URL` is not checked — only basic IP connectivity to
  `NETWORK_PROBE_HOST` is probed.
- No exponential backoff or configurable retry interval; the 0.5s sleep is fixed.

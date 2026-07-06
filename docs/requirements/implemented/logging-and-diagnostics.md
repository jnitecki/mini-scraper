# Requirement: Configurable Logging, Network/Trace Capture, and Debug Diagnostics

## Status
Approved — pending implementation.

## Scope
Applies identically to both `Docker/Files/scraper.js` (default container script) and
`specialized/dewa_usage.js` (specialized script) unless a section says otherwise.

## 1. Logging infrastructure (rotation removed)
- Remove `winston-daily-rotate-file` (dependency, usage, and the Dockerfile `npm install`
  entry).
- Both scripts log via winston to a single fixed file, `/logs/miniscraper.log`, in addition
  to console output. Log rotation/retention is handled externally to the container (e.g.
  host-level logrotate on the mounted `/logs` volume) — the scripts themselves never
  rotate, rename, or delete this file.
- Existing `CONSOLE_LOG` / `FILE_LOG` env vars are kept (level name, or `'none'` to
  disable) and are added to `scraper.js`, which does not use winston today.
  - Both scripts default to `CONSOLE_LOG=none`, `FILE_LOG=warn` — the script keeps
    working with no `/logs` volume mounted (file logging degrades to a console warning
    in that case, per the rule below), matching the project's zero-config behavior.
- If file logging is enabled (`FILE_LOG` not `none`) but `/logs` does not exist, the
  script logs a console warning and continues without file logging rather than failing.
- `CLEANUP_DAYS` and the associated `removeOldFiles()` / `cleanupOldScreenshotsAndPages()`
  logic are deleted from `dewa_usage.js`.

## 2. Failure diagnostics: screenshot + page dump (both scripts)
- New env var `FAILURE_DUMP_PREFIX`.
- If unset: fixed paths `/logs/screenshot.png` and `/logs/page.html` are used.
- If set: `prefix = value.startsWith('/') ? value : '/logs/' + value`, then the two
  files are `prefix + 'screenshot.png'` and `prefix + 'page.html'` — plain string
  concatenation, no separator inserted automatically (include `_` or `/` in the value
  if one is wanted).
- Files are overwritten on every failing run; no timestamping, no retention logic.
- `scraper.js` currently has no failure handling around its main flow — it gains a
  try/catch so it can take a screenshot and save the page HTML on failure before
  exiting non-zero, mirroring `dewa_usage.js`'s existing behavior.

## 3. Network HAR capture (both scripts)
- New env var `NETWORK_HAR_PATH` — full file path (e.g. `/logs/network.har`).
- If set, passed as `recordHar: { path }` to `browser.newContext()`. Unset = disabled
  (default, current behavior).
- Always captured and overwritten on every run when set (no on-error-only mode).
- Playwright's `recordHar` `mode`/`content` sub-options are out of scope; Playwright
  defaults are used.

## 4. Tracing capture (both scripts)
- New env var `TRACE_CONFIG` — single value: the trace zip path as the first
  whitespace-separated token, followed by optional `flag:true|false` tokens for
  `screenshots`, `snapshots`, `sources`.
  - Example: `TRACE_CONFIG=/logs/trace.zip screenshots:true sources:true`
- Unset = tracing disabled. An unknown flag name or a malformed `key:value` token is a
  validation error (non-zero exit).
- Implemented as `context.tracing.start({ screenshots, snapshots, sources })`
  immediately after context creation, and `context.tracing.stop({ path })` guaranteed
  via `finally` so the trace is captured even when the run fails.

## 5. Playwright internal debug scopes (both scripts)
- New env var `PW_DEBUG_SCOPES` — comma-separated Playwright debug namespaces (e.g.
  `pw:api,pw:browser`).
- If set, assigned to `process.env.DEBUG` before `require('playwright')` runs — both
  scripts need their top lines reordered so this assignment happens first, since the
  underlying `debug` package resolves enabled namespaces from `process.env.DEBUG` at
  first use.
- Output goes to stderr (Playwright/`debug`'s own default). No dedicated log file for
  this in the current requirement.

## 6. Validation
- Parent directories for `NETWORK_HAR_PATH`, the path inside `TRACE_CONFIG`, and the
  `FAILURE_DUMP_PREFIX`-derived paths must exist, or the script errors and exits
  non-zero — consistent with the project's existing validate-then-run style.

## 7. Docker image changes
- The Dockerfile creates `/logs` at build time (e.g. `mkdir -p /logs /scraper`) so the
  directory exists in the image even when no host volume is mounted over it.
- `winston-daily-rotate-file` removed from the image's `npm install` line.

## Out of scope / explicitly deferred
- HAR `mode`/`content` sub-options.
- Redirecting `PW_DEBUG_SCOPES` output to its own file (stderr only, for now).
- A configurable ALWAYS-vs-ON_ERROR mode for HAR/trace capture (always-on was chosen).

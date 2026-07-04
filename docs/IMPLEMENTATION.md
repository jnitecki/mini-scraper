# Implementation

This document describes how MiniScraper is actually built and wired together — code
layout, runtime flow, and the mechanics behind each piece. It is not a specification of
required behavior; see `docs/requirements/implemented/` for that. Where the two diverge,
the requirements docs describe the intended contract and this document explains how the
current code realizes (or falls short of) it.

## Repository layout
```
Docker/
  dockerfile          # Image build: Playwright base + winston, /logs and /scraper dirs
  Files/
    scraper.js         # Default container script (CMD), replaced by -v mount for custom use
    entrypoint.sh       # ENTRYPOINT: network-readiness wait, then exec's CMD
ci/
  version.sh           # Computes image version from git tags/tree state
  build-docker.sh      # Local multi-arch build (build-only, no push)
.github/workflows/
  docker-publish.yml   # Manual GH Actions workflow: build + push to Docker Hub
build.sh               # Legacy single-purpose podman build+push script (superseded by ci/)
specialized/
  dewa_usage.js         # Example specialized script, meant to be mounted over scraper.js
  dewa_usage.md          # User-facing docs for the DEWA script
  DEWA.sh                 # Local dev-only run script (gitignored, holds live credentials)
docs/
  requirements/implemented/  # Behavior specifications (what the system must do)
  IMPLEMENTATION.md          # This file (how the system does it)
```

There is no root `package.json` / lockfile. Node dependencies (`playwright`, `winston`)
are installed at image build time via `npm init -y && npm install ...` directly in the
`dockerfile` — there's no dependency pinning beyond whatever `npm install` resolves at
build time and whatever the base Playwright image's own installed version constraints are.

## Base image build (`Docker/dockerfile`)
- Starts from `mcr.microsoft.com/playwright:$IMAGE_TAG` (build arg, default
  `v1.61.0-noble`), so the Chromium/browser binaries and OS-level Playwright dependencies
  come from Microsoft's image rather than being installed here.
- `mkdir -p /logs /scraper` creates both mount points at build time so the image works
  even if the caller doesn't bind-mount `/logs` (file logging degrades gracefully — see
  below) or a custom scraper.
- `npm install playwright winston` runs once, into `/scraper/node_modules`, shared by
  whatever script ultimately runs (default or mounted-over).
- `ENTRYPOINT ["/entrypoint.sh"]` + `CMD ["node", "scraper.js"]` — the entrypoint always
  runs first and `exec`s the `CMD` (or whatever command a caller overrides `CMD` with),
  which is what lets a bind-mounted replacement script still go through the network wait.

## Entrypoint (`Docker/Files/entrypoint.sh`)
Plain POSIX `sh`, no Node involved yet at this stage:
- Reads `NETWORK_TIMEOUT` / `NETWORK_PROBE_HOST` with shell `${VAR:-default}` fallback.
- `while ! ping -c1 -W1 "$PROBE_HOST" ...; do ...; sleep 0.5; ELAPSED=$((ELAPSED+1)); done`
  — a straightforward retry loop. `ELAPSED` is an iteration counter incremented once per
  loop pass, **not** a wall-clock second counter (see the caveat in
  `docs/requirements/implemented/network-readiness.md`).
- Ends with `exec "$@"`, replacing the shell process with the container's `CMD` so the
  entrypoint doesn't stay resident as a parent process (signals go straight to the real
  process, no extra PID in between).
- Comment at the top notes stdout is reserved for the scraper's result, hence no
  diagnostic echoing during the wait.

## Core scraper (`Docker/Files/scraper.js`)
Single-file script, top-to-bottom procedural flow, no external project modules:

1. **`process.env.DEBUG` shim** (lines 1-3) — must run *before* `require('playwright')`
   because the underlying `debug` package reads `process.env.DEBUG` once at first
   `require`, so `PW_DEBUG_SCOPES` has to be applied ahead of every other import.
2. **Config parsing** — every env var is read into a `const` up front (`url`, `selector`,
   `waitUntil`, `timeout`, `outputFormat`) with plain `||` defaults; no schema/validation
   library, just hand-rolled `if` checks that call `logger.error` + `process.exit(1)`.
3. **Winston setup** — a `Console` transport is always constructed; a `File` transport is
   added conditionally only if `FILE_LOG !== 'none'` **and** `/logs` exists on disk
   (`fs.existsSync`) at process start. This existence check happens once, synchronously,
   before the logger is created — there's no retry if `/logs` appears later.
   This entire logger-construction block (transports, formats, the conditional
   `/logs`-exists check) is duplicated verbatim in `specialized/dewa_usage.js` — the two
   scripts don't share a module; each defines its own copy.
4. **Path validation helpers** — `requireParentDir()` is a small shared-shape function
   (also duplicated in `dewa_usage.js`) that checks a target path's parent directory
   exists via `fs.existsSync(path.dirname(...))`, used for `NETWORK_HAR_PATH`,
   `TRACE_CONFIG`'s path, and `FAILURE_DUMP_PREFIX`-derived paths.
5. **`parseTraceConfig()`** — manual whitespace-tokenizing parser: first token is the
   trace zip path, remaining tokens are `flag:true|false` pairs matched against a fixed
   `{screenshots, snapshots, sources}` options object; unknown flags or malformed
   `key:value` tokens throw, which the caller turns into a logged error + exit(1).
6. **Main async IIFE** — `browser`/`context`/`page`/`tracingStarted` are declared outside
   the `try` so the `finally` block can safely reference (and null-check) them regardless
   of how far execution got before failing:
   - `browser.newContext(contextOptions)` — `contextOptions.recordHar` is conditionally
     set only when `NETWORK_HAR_PATH` is present; otherwise an empty options object.
   - `context.tracing.start(...)` runs immediately after context creation, guarded by
     `traceConfig` truthiness; `tracingStarted` is set only on success so `finally` knows
     whether `tracing.stop()` is safe to call.
   - `context.route('**/*', ...)` intercepts every request, re-fetches it with
     `route.fetch()`, strips the two CSP header variants from the response headers
     object, and re-fulfills with `route.fulfill({ response, headers })`. Errors inside
     the handler (e.g. the context already being torn down) are caught and turned into a
     best-effort `route.abort().catch(() => {})` rather than being allowed to propagate.
   - jQuery source is fetched once via a hand-rolled `https.get` wrapped in a `Promise`
     (`fetchText`) — no HTTP client library, no retry/backoff, no caching between runs.
   - Injection happens via `page.evaluate` creating a `<script>` element with the fetched
     source as `textContent`, then capturing `jQuery.noConflict(true)` into
     `window.__jquery__` inside the page's own JS context.
   - The shadow-DOM-aware `window.$$` helper is itself installed via a second
     `page.evaluate` call, as a page-global function, so later `page.evaluate` calls that
     reference `$$` are calling code that now lives in the browser context, not in Node.
   - Debug diagnostics (`selectorUsed`, `matchCount`, `pageTitle`, `h1s`, `h2s`,
     `bodySnippet`) are gathered by one more `page.evaluate` round-trip and logged via
     `logger.debug(JSON.stringify(...))` — this is pure observability, its result is
     discarded rather than affecting control flow.
   - Final extraction is a single `page.evaluate` keyed off `outputFormat`, returning
     plain data (strings or plain objects) that survives the evaluate→Node serialization
     boundary, then `console.log(JSON.stringify(result, null, 2))` to stdout.
   - **`catch`** block: logs the error, and if `page` was successfully created, attempts a
     screenshot (`page.screenshot`) and an HTML dump (`page.content()` +
     `fs.writeFileSync`) independently — each wrapped in its own try/catch so a failure to
     produce one diagnostic doesn't suppress the other or mask the original error. Ends
     with `console.error(JSON.stringify({ error: err.message }))` and
     `process.exitCode = 1` (not `process.exit(1)`, so the `finally` block still runs to
     completion before the process actually exits).
   - **`finally`** block: stops tracing (if started) before closing context/browser, since
     `tracing.stop({ path })` must run while the context is still alive to flush the
     trace; both `context.close()` and `browser.close()` are `.catch(() => {})`-guarded so
     a teardown error can't overwrite `process.exitCode` or throw an unhandled rejection.

## Specialized script pattern (`specialized/dewa_usage.js`)
Demonstrates the "mount over `/scraper/scraper.js`" extension point described in
`docs/requirements/implemented/core-scraping-engine.md` §6:
- Re-implements (copy-pasted, not imported) the same winston/logger bootstrap,
  `requireParentDir`, `parseTraceConfig`, `NETWORK_HAR_PATH`/`TRACE_CONFIG`/
  `FAILURE_DUMP_PREFIX` handling, and failure-diagnostics (`catch`/`finally`) shape as
  `scraper.js` — the shared behavior described in
  `docs/requirements/implemented/logging-and-diagnostics.md` exists as parallel code, not
  a shared library.
- Adds its own domain logic on top: a `getRemaining()` time-budget helper computed from a
  single `startTime`, passed as the `timeout` option to every individual Playwright call
  (`goto`, `fill`, `click`, `waitForNavigation`, `selectOption`, ...) so the *whole*
  scrape shares one wall-clock budget (`TIMEOUT`, 10–300s) rather than each step getting
  its own independent timeout.
- Site interaction is hardcoded against DEWA's current DOM (fixed selectors like
  `input[name="Username"]`, `#gauge-component > form + div > div:nth-child(1)`) with an
  explicit code comment warning these will need updating if DEWA changes its markup — no
  abstraction or config layer insulates this script from site changes.
- Period selection polls in a `while (true)` loop, re-reading the `<select>`'s current
  value after each `selectOption` call until it matches the requested `optionValue`,
  bounded only by the shared `getRemaining()` timeout inside `waitForFunction`/
  `selectOption` (there's no explicit iteration cap — a `TIMEOUT` exceeded during this
  loop throws from `getRemaining()` and unwinds into the `catch` block).
- Final result shape (`{ period, electricity, water }`) is produced by two `page.$eval`
  calls that split `innerText` on line breaks positionally (`[0]` = value, `[2]` = type
  label), then a manual check that the type labels are literally `"Electricity"` /
  `"Water"` before trusting the values — a lightweight sanity check against a layout
  change silently mis-mapping fields.
- Unlike `scraper.js`, the outer IIFE here re-throws from `scrapeDEWA()` and the *outer*
  catch is what does `console.error` + `process.exit(1)` — the diagnostics (screenshot/
  HTML dump) are captured inside `scrapeDEWA()`'s own catch before the re-throw, so they
  still happen, just structured as two nested try/catch layers instead of one.

## Build & release tooling
- **`ci/version.sh`** — pure `git describe`/`git status` shell logic (no external version
  library). `git describe --tags --long --match 'v[0-9]*.[0-9]*.[0-9]*'` gives
  `TAG-COMMITS_SINCE-gHASH` in one call, parsed apart with `sed` capture groups rather
  than separate git invocations. Dirty-tree detection is
  `git status --porcelain --untracked-files=no` being non-empty (tracked-file changes
  only; untracked files don't dirty the version).
- **`ci/build-docker.sh`** — `resolve_base_image_tag()` implements the `x`-wildcard
  matching by turning the pattern into a regex (`[0-9]+` per wildcarded segment) and
  scanning the raw JSON tag list from the MCR registry with `sed`/`tr` text processing
  (no `jq` dependency), picking the numerically-highest match via zero-padded
  string comparison (`printf '%08d.%08d.%08d'` keys). Engine-specific manifest logic
  (`podman manifest create/add` vs. `docker buildx build --load` with fallback to
  per-arch tags) is implemented as separate code paths gated on the `$ENGINE` variable,
  not a shared abstraction.
- **`.github/workflows/docker-publish.yml`** — thin wrapper: computes the version by
  shelling out to `ci/version.sh` (the same script used locally, so version semantics
  can't drift between local and CI builds), then hands off to
  `docker/build-push-action@v6` for the actual multi-arch build+push — it does not reuse
  `ci/build-docker.sh`'s bash logic at all.
- **`build.sh`** — flat, non-parameterized script kept for reference; not invoked by
  anything else in the repo (`ci/build-docker.sh` and the GH workflow are the live
  paths).

## Known implementation quirks worth knowing before changing this code
- `scraper.js` and `dewa_usage.js` duplicate the logger bootstrap, `requireParentDir`,
  and `parseTraceConfig` byte-for-byte. Any fix to one (e.g. a bug in trace-config
  parsing) needs to be applied to both files by hand — there is no shared module.
- `entrypoint.sh`'s `NETWORK_TIMEOUT` is an iteration count, not a second count (see
  `docs/requirements/implemented/network-readiness.md`).
- `scraper.js` uses `process.exitCode = 1` (lets `finally` run first); `dewa_usage.js`
  uses `process.exit(1)` in its outer catch — the outer catch runs after `scrapeDEWA()`'s
  own `finally` has already completed context/browser teardown, so this difference is
  currently safe, but it means the two scripts don't have visually consistent shutdown
  code despite being copy-derived from a common shape.

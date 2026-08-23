# Requirement: Core Scraping Engine (Base Container Script)

## Status
Implemented — documented here from the current behavior of `Docker/Files/scraper.js`.

## Scope
The base container script, `Docker/Files/scraper.js` (the image's default `CMD`), and the
mechanism by which it can be replaced with a custom script. Failure diagnostics (screenshot/
page dump), HAR capture, tracing, and log level configuration are covered separately in
`requirements/logging-and-diagnostics.md` and are not repeated here. Specialized scripts
(e.g. `specialized/dewa_daily.js`, `specialized/dewa_incremental.js`) are out of scope —
they replace this file entirely and have their own requirements/documentation.

## 1. Environment-driven page load & extraction
- `TARGET_URL` — required. Missing value is a validation error (non-zero exit).
- `JQUERY_SELECTOR` — jQuery/CSS selector used to select elements. Default: `body`.
- `WAIT_UNTIL` — passed directly as Playwright's `page.goto` `waitUntil` option. Default: `load`.
- `TIMEOUT` — seconds to wait for `WAIT_UNTIL` to occur, converted to milliseconds for
  `page.goto`. Default: `60`.
- `OUTPUT_FORMAT` — one of `TEXT`, `HTML`, `ALL` (case-insensitive). Default: `TEXT`. Any
  other value is a validation error (non-zero exit).
  - `TEXT` — array of trimmed text content, one per matched element.
  - `HTML` — array of inner HTML, one per matched element.
  - `ALL` — array of `{ text, html, attrs }` objects, one per matched element, where `attrs`
    is a plain object of every attribute on the element.
- A selector that matches zero elements is not an error — the result is an empty array.

## 2. jQuery injection & shadow DOM support
- jQuery 3.7.1 (minified) is fetched at runtime over HTTPS from `code.jquery.com` and
  injected into the page as an inline `<script>` after `page.goto` resolves. This is a
  live network dependency of every run.
- The injected jQuery is captured via `jQuery.noConflict(true)` into `window.__jquery__` so
  it does not clobber a `$`/`jQuery` the target page may already define.
- A custom `window.$$(selector, root)` helper recursively descends into any element's
  `shadowRoot`, so `JQUERY_SELECTOR` matches elements inside open shadow DOM subtrees, not
  just the light DOM. Results are merged and wrapped in the injected jQuery instance before
  extraction.
- If injection fails (`window.__jquery__` is not a function afterward), this is treated as a
  fatal error and follows the same failure path as any other run-time failure.

## 3. CSP header stripping
- Every request is intercepted via `context.route('**/*')`, re-fetched, and has the
  `content-security-policy` / `content-security-policy-report-only` response headers removed
  before being fulfilled — this is what allows the injected jQuery `<script>` to execute on
  pages that would otherwise block inline scripts via CSP.
- Route handler errors (e.g. requests that fire after the context has been disposed) are
  swallowed — the route is aborted and the error is not allowed to fail the run.

## 4. Selector debug diagnostics
- Before extraction, the script evaluates and logs (at `debug` level) the selector's match
  count, the page title, the text of every `h1`/`h2` on the page, and a 300-character
  snippet of the body text — intended to help diagnose a selector that isn't matching what
  was expected.

## 5. Output contract
- Success: the extracted result is `JSON.stringify`-ed and printed to **stdout**; the
  process exits `0`.
- Failure: `{ "error": "<message>" }` is printed to **stderr**; `process.exitCode` is set to
  `1`. (Screenshot/page-HTML capture on failure is specified in
  `requirements/logging-and-diagnostics.md`.)
- Callers are expected to capture stdout as the sole data channel; all logging goes to
  stderr/console or the log file, never stdout.

## 6. Custom scraper override
- The image's `CMD` runs `node scraper.js` from `/scraper`. Mounting a replacement file over
  `/scraper/scraper.js` (e.g. `-v $(PWD)/custom_scraper.js:/scraper/scraper.js`) fully
  replaces the default script — this is how specialized scripts (e.g.
  `specialized/dewa_daily.js`, `specialized/dewa_incremental.js`) run inside the same
  image without a custom build.
- The image only guarantees the `playwright` and `winston` npm packages are installed and
  available to a mounted script; a custom script must `require('playwright')` itself and
  cannot assume any other dependency is present.

## Out of scope
- Anti-bot / anti-detection measures (e.g. stealth plugins, fingerprint randomization).
- Retrying failed navigations or extractions.

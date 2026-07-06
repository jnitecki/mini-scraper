[![Docker Image Version](https://img.shields.io/docker/v/jnitecki/mini-scraper?logo=docker)](https://hub.docker.com/r/jnitecki/mini-scraper) ![Docker Pulls](https://img.shields.io/docker/pulls/jnitecki/mini-scraper)

# README
A very simple web scraper that loads pages in a browser, executes all scripts, and extracts data using jQuery syntax. It handles situations where the required data is not part of the initial page load but is instead fetched and rendered via scripts. Internally, it uses [Playwright](https://playwright.dev/) with JavaScript to run and control the browser.

## Environment Parameters
- **TARGET_URL** - The URL of the main page to be downloaded.
- **JQUERY_SELECTOR** - A jQuery selector used to extract the required data.
- **WAIT_UNTIL** - The event to wait for before running the jQuery selector.
*Default: 'load'*.
- **TIMEOUT** - The duration to wait for the event to occur.
*Default: 60 (60s)*.
- **OUTPUT_FORMAT** - The format of the data selected by the **JQUERY_SELECTOR**.
    - *TEXT* - An array of strings containing the text of each selected element.
    *Default value*.
    - *HTML* - An array of strings containing the full HTML content of each selected element.
    - *ALL* - An array of objects, one for each selected element, containing the following properties:
        - `text` - The text of the selected element.
        - `html` - The HTML of the selected element.
        - `attrs` - An object containing all attributes of the selected element.
- **CONSOLE_LOG** - Logging level for console output (default: 'none', i.e. console logging is disabled unless explicitly set).
- **FILE_LOG** - Logging level for file output, written to `/logs/miniscraper.log` (default: 'warn'). Set to 'none' to disable file logging. If set but `/logs` is not mounted, a console warning is issued and file logging is skipped.
- **FAILURE_DUMP_PREFIX** - Optional path/prefix used to name the screenshot and page HTML dump written on failure. If the value starts with `/`, it's used as-is; otherwise `/logs/` is prepended. The resulting files are `<prefix>screenshot.png` and `<prefix>page.html`, overwritten on each failing run.
*Default (unset): `/logs/screenshot.png` and `/logs/page.html`*.
- **NETWORK_HAR_PATH** - Optional full path to a HAR file capturing all network activity for the run (e.g. `/logs/network.har`). Unset disables HAR capture. When set, the file is overwritten on every run.
- **TRACE_CONFIG** - Optional Playwright trace capture. Value is the trace zip path, optionally followed by space-separated `flag:true|false` tokens for `screenshots`, `snapshots`, `sources` (e.g. `/logs/trace.zip screenshots:true sources:true`). Unset disables tracing.
- **PW_DEBUG_SCOPES** - Optional comma-separated Playwright debug namespaces (e.g. `pw:api,pw:browser`) enabling Playwright's internal debug logging to stderr. Unset disables it.

## Output
Output data in JSON format, with the content defined by **OUTPUT_FORMAT**, is returned via the standard output stream and can be captured and consumed by the calling application.

## Container usage
Minimal:
```
podman run --rm \
  -e TARGET_URL="https://www.netgear.com/support/product/jgs516pe" \
  -e JQUERY_SELECTOR="div.firmware-latest strong" \
  mini-scraper:latest
```

Extended (all parameters):
```
podman run --rm --name mini-scraper \
  -e TARGET_URL="https://www.netgear.com/support/product/jgs516pe" \
  -e JQUERY_SELECTOR="div.firmware-latest strong" \
  -e WAIT_UNTIL="load" \
  -e TIMEOUT="60" \
  -e OUTPUT_FORMAT="text" \
  mini-scraper:latest
```

## Customizations
A custom `scraper.js` can be mounted into the container at the `/scraper/scraper.js` path using `-v $(PWD)/custom_scraper.js:/scraper/scraper.js`.

Include `const { chromium } = require('playwright');` in your custom script to access the Playwright engine.

## Logging
This container includes Winston for logging purposes, writing to a fixed file `/logs/miniscraper.log` (see **CONSOLE_LOG** / **FILE_LOG** above). There is no built-in log rotation — rotate/retain the mounted `/logs` volume externally if needed.


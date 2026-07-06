# DEWA Electricity Usage Scraper

This is a web scraper that extracts electricity and water consumption data from the DEWA (Dubai Electricity and Water Authority) website using Playwright.

## Usage

### Docker Container Usage
To run the scraper inside a Docker container, use the following command:

```bash
podman run --rm --name mini-scraper \
  -v $(PWD)/dewa_usage.js:/scraper/scraper.js \
  -v $(PWD)/logs:/logs \
  -e DEWA_USER='<username for DEWA>' \
  -e DEWA_PASS='<password for DEWA>' \
  -e CONSOLE_LOG=none \
  -e FILE_LOG=warn \
  docker.io/jnitecki/mini-scraper:latest \
  2>&1
```

## Environment Variables

- `DEWA_USER` - Your DEWA account email address
- `DEWA_PASS` - Your DEWA account password  
- `PERIOD` - The period to retrieve data for (default: 'CURRENT'). Can be 'CURRENT' or a date in yyyy-mm format (e.g., 2023-12). For 'CURRENT', the scraper identifies the right dropdown option on the usage page by checking, in order: an option with value `UnbilledConsumption`, then an option whose label contains "till yesterday" (case-insensitive), then the first option in the list if its value represents the current or next calendar month. If none of these match, the scraper fails with an error rather than guessing
- `TIMEOUT` - Total time budget in seconds for the entire scraping operation (default: 60). If provided, must be a number between 10 and 300. Each Playwright step receives only the time remaining from this budget — if the budget is exhausted mid-run, the operation fails with a timeout error.
- `CONSOLE_LOG` - Logging level for console output (default: 'none', i.e. console logging is disabled unless explicitly set)
- `FILE_LOG` - Logging level for file output, written to `/logs/miniscraper.log` (default: 'warn'). Set to 'none' to disable file logging
- `FAILURE_DUMP_PREFIX` - Optional path/prefix for the screenshot and page HTML dump written on failure. If the value starts with `/`, it's used as-is; otherwise `/logs/` is prepended. The resulting files are `<prefix>screenshot.png` and `<prefix>page.html`, overwritten on each failing run. Default (unset): `/logs/screenshot.png` and `/logs/page.html`
- `NETWORK_HAR_PATH` - Optional full path to a HAR file capturing all network activity for the run (e.g. `/logs/network.har`). Unset disables HAR capture; when set, the file is overwritten on every run
- `TRACE_CONFIG` - Optional Playwright trace capture. Value is the trace zip path, optionally followed by space-separated `flag:true|false` tokens for `screenshots`, `snapshots`, `sources` (e.g. `/logs/trace.zip screenshots:true sources:true`). Unset disables tracing
- `PW_DEBUG_SCOPES` - Optional comma-separated Playwright debug namespaces (e.g. `pw:api,pw:browser`) enabling Playwright's internal debug logging to stderr. Unset disables it

## Security Note

This tool requires your DEWA account credentials. Please ensure you understand what data is being accessed and that you're complying with DEWA's terms of service.

## Output Format

### Success Output
When the scraper runs successfully, it outputs a JSON object to stdout with the following structure:
```json
{
  "period": "<usage period>",
  "electricity": "2221.88",
  "water": "12.09"
}
```

The electricity consumption is measured in **kilowatt-hours (kWh)** and water consumption is measured in **cubic meters (m³)**.

### Error Output
When an error occurs, the scraper:
- Exits with a non-zero exit code
- Outputs error information to stderr with the following structure:
```json
{
  "error": "<error details>"
}
```

## Logging and Debugging

The scraper generates logs and diagnostic files in the mounted `/logs` directory:

- **Processing logs**: Stored in a single fixed file, `/logs/miniscraper.log`. There is no built-in rotation — rotate/retain the mounted volume externally if needed.
- **Screenshots**: Saved as a PNG file when errors occur (default `/logs/screenshot.png`, or `<FAILURE_DUMP_PREFIX>screenshot.png` if set), overwritten on each failing run.
- **HTML content**: Saved as an HTML file when errors occur (default `/logs/page.html`, or `<FAILURE_DUMP_PREFIX>page.html` if set), overwritten on each failing run.
- **Network HAR / Playwright trace**: Optionally captured via `NETWORK_HAR_PATH` / `TRACE_CONFIG` (see Environment Variables above).

These files are automatically generated and stored in the logs directory that is mounted to `/logs` inside the container.

## Troubleshooting

If the scraper fails:
1. Check that your credentials are correct
2. Verify the selectors in the code match the current website structure
3. The program will take a screenshot and save the page HTML on failure (`/logs/screenshot.png` and `/logs/page.html` by default, or `<FAILURE_DUMP_PREFIX>screenshot.png` / `<FAILURE_DUMP_PREFIX>page.html` if set)
4. If you see `Error: Unable to determine the current period from available options`, DEWA has likely changed the period dropdown's option values or labels again. Enable `CONSOLE_LOG=debug` or `FILE_LOG=debug` and re-run with `PERIOD=CURRENT` to see the actual `Available periods` list logged, then update the matching logic in `dewa_usage.js` accordingly
5. If you see `Error: Requested period '<value>' is not available`, the period dropdown's value format may have changed; check the logged `Available periods` list to confirm the expected format (currently `mmyyyy`, e.g. `072025` for July 2025)

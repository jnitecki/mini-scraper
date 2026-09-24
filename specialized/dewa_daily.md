# DEWA Daily Consumption Scraper

This is a web scraper that extracts **per-day** electricity and water consumption data from the
DEWA (Dubai Electricity and Water Authority) website using Playwright. For billing-period totals
instead, see [dewa_incremental.md](dewa_incremental.md).

## Usage

### Docker Container Usage
To run the scraper inside a Docker container, use the following command:

```bash
podman run --rm --name mini-scraper \
  -v $(PWD)/dewa_daily.js:/scraper/scraper.js \
  -v $(PWD)/logs:/logs \
  -e DEWA_USER='<username for DEWA>' \
  -e DEWA_PASS='<password for DEWA>' \
  -e DATE_FROM='2026-02-01' \
  -e DATE_TO='2026-02-07' \
  -e CONSOLE_LOG=none \
  -e FILE_LOG=warn \
  docker.io/jnitecki/mini-scraper:latest \
  2>&1
```

## Environment Variables

- `DEWA_USER` - Your DEWA account email address
- `DEWA_PASS` - Your DEWA account password
- `DATE_FROM` - Start of the requested date range, in `yyyy-MM-dd` format. Must be yesterday
  (Asia/Dubai) or earlier, and no earlier than `2019-01-01`. If omitted while `DATE_TO` is set,
  defaults to `2019-01-01`. If both are omitted, the scraper retrieves yesterday only
- `DATE_TO` - End of the requested date range, in `yyyy-MM-dd` format. Must be yesterday
  (Asia/Dubai) or earlier, and not before `DATE_FROM`. If omitted while `DATE_FROM` is set,
  defaults to yesterday
- `TIMEOUT` - Total time budget in seconds for the entire scraping operation (default: 60). If
  provided, must be a number between 10 and 300. Each Playwright step receives only the time
  remaining from this budget — if the budget is exhausted mid-run, the operation fails with a
  timeout error. Wider date ranges need a larger budget, since every calendar month in the range
  requires its own picker navigation for both electricity and water, and older months need one
  year-picker click (with an 0.8-1.6s randomized settle delay after each, see How It Works) per
  year back from the current one
- `CONSOLE_LOG` - Logging level for console output (default: 'none', i.e. console logging is
  disabled unless explicitly set)
- `FILE_LOG` - Logging level for file output, written to `/logs/miniscraper.log` (default:
  'warn'). Set to 'none' to disable file logging
- `FAILURE_DUMP_PREFIX` - Optional path/prefix for the screenshot and page HTML dump written on
  failure. If the value starts with `/`, it's used as-is; otherwise `/logs/` is prepended. The
  resulting files are `<prefix>screenshot.png` and `<prefix>page.html`, overwritten on each
  failing run. Default (unset): `/logs/screenshot.png` and `/logs/page.html`
- `NETWORK_HAR_PATH` - Optional full path to a HAR file capturing all network activity for the
  run (e.g. `/logs/network.har`). Unset disables HAR capture; when set, the file is overwritten
  on every run
- `TRACE_CONFIG` - Optional Playwright trace capture. Value is the trace zip path, optionally
  followed by space-separated `flag:true|false` tokens for `screenshots`, `snapshots`, `sources`
  (e.g. `/logs/trace.zip screenshots:true sources:true`). Unset disables tracing
- `PW_DEBUG_SCOPES` - Optional comma-separated Playwright debug namespaces (e.g.
  `pw:api,pw:browser`) enabling Playwright's internal debug logging to stderr. Unset disables it
- `ALLOW_MISSING_PRE_HISTORY_ELECTRICITY` / `ALLOW_MISSING_PRE_HISTORY_WATER` - Optional, `true` or
  `false` (default: `false`). Electricity and water history start on different dates in DEWA; when
  a requested month is before a utility's own history began, DEWA silently shows the earliest
  month it does have data for instead of the requested one. With the flag unset (default), this
  surfaces as the usual `data-series ... never matched` error. With the flag set to `true` for
  that utility, the scraper instead treats the requested month as having no data for that utility
  (its days come back with that field `null`, without a warning or error)

## How It Works

For each calendar month touched by `[DATE_FROM, DATE_TO]` (current month first if it's in range,
see below), and for each utility (electricity, water), the scraper:

1. Clicks the "Daily" tab within that utility's panel (`#dvElectricity` / `#dvWater`).
2. If the target month is the current (in-progress) one, its picker cell is disabled, so this
   step is skipped - the Daily view only shows the current month's data by default when nothing
   else has been explicitly picked yet, which is why it's always processed first (see below).
   Otherwise, opens the month picker (`#dp_month_e1` / `#dp_month_w1`) and navigates to the
   target month.
3. Reads the `data-series` attribute off the panel and looks for the entry whose `name` matches
   the target month (e.g. `"February 2026"`). If the reload hasn't caught up yet, it waits
   (2s between attempts, up to 9 retries — around 18s total) and re-activates "Daily" before
   giving up.
4. Maps that month's per-day array onto actual calendar dates and keeps only the days that fall
   within the requested range.

Results across all months/utilities are merged into a single sorted array covering every day in
the requested range.

The current month, if it's part of the requested range, is always processed first (for each
utility) rather than in chronological order. Its Daily view only defaults to showing its own data
when nothing else has been explicitly selected yet; once an earlier month has been picked (as
happens for any earlier month in the range), the chart just keeps showing that selection instead
- there's no way to explicitly re-select the current month since its picker cell is disabled.

If a requested month is before a utility's data history began, step 3 never finds a matching
`data-series` entry - DEWA clamps the Daily view to the earliest month it does have data for
instead. By default this surfaces as an error (see Troubleshooting). Set
`ALLOW_MISSING_PRE_HISTORY_ELECTRICITY` / `ALLOW_MISSING_PRE_HISTORY_WATER` to `true` to instead
treat it as "no data for this period" for that utility - detected by checking whether the
mismatched series DEWA did return is for a *later* period than requested (i.e. further ahead than
the requested month, rather than an earlier one still catching up to it).

## Security Note

This tool requires your DEWA account credentials. Please ensure you understand what data is
being accessed and that you're complying with DEWA's terms of service.

## Output Format

### Success Output
When the scraper runs successfully, it outputs a JSON array to stdout, one entry per requested
day:
```json
[
  { "date": "2026-02-01", "electricity": 0.362, "water": 0.145 },
  { "date": "2026-02-02", "electricity": 0.302, "water": 0.151 }
]
```

The electricity consumption is measured in **kilowatt-hours (kWh)** and water consumption is
measured in **cubic meters (m³)**. If a day's reading couldn't be found in either series, that
field is `null` and a warning is logged.

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

- **Processing logs**: Stored in a single fixed file, `/logs/miniscraper.log`. There is no
  built-in rotation — rotate/retain the mounted volume externally if needed.
- **Screenshots**: Saved as a PNG file when errors occur (default `/logs/screenshot.png`, or
  `<FAILURE_DUMP_PREFIX>screenshot.png` if set), overwritten on each failing run.
- **HTML content**: Saved as an HTML file when errors occur (default `/logs/page.html`, or
  `<FAILURE_DUMP_PREFIX>page.html` if set), overwritten on each failing run.
- **Network HAR / Playwright trace**: Optionally captured via `NETWORK_HAR_PATH` / `TRACE_CONFIG`
  (see Environment Variables above).

## Troubleshooting

If the scraper fails:
1. Check that your credentials are correct.
2. Verify the selectors in the code match the current website structure. The program will take a
   screenshot and save the page HTML on failure (`/logs/screenshot.png` and `/logs/page.html` by
   default, or `<FAILURE_DUMP_PREFIX>screenshot.png` / `<FAILURE_DUMP_PREFIX>page.html` if set).
3. If you see `Error: Unable to navigate month picker to year <year>` or `Error: Unable to read
   month picker year header '<text>'`, the month picker's DOM (header/prev/next/month-cell
   selectors, currently `MONTH_PICKER` in `dewa_daily.js`) has likely changed. Enable
   `CONSOLE_LOG=debug` or `FILE_LOG=debug`, capture a screenshot via `FAILURE_DUMP_PREFIX`, and
   update `MONTH_PICKER` accordingly. If instead you see `locator.click: ... element was detached
   from the DOM, retrying` on a picker click (prev/next/month-cell) that then times out, or the
   picker simply stops becoming active at all after a run of several prev/next clicks (DEWA runs
   Akamai Bot Manager, which does its own behavioral scoring on click timing and can throttle a
   widget mid-session once a burst of clicks reads as non-human) - capture a `TRACE_CONFIG` trace
   to confirm, and consider raising `PICKER_SETTLE_DELAY_MIN_MS`/`PICKER_SETTLE_DELAY_MAX_MS` in
   `dewa_daily.js`. If you see `Error: month picker for #dp_month_e1/#dp_month_w1 never opened
   after 3 retries` (preceded by `month picker did not open after click` warnings), the click
   that's meant to open the calendar isn't reliably registering; try raising
   `PICKER_OPEN_RETRIES`/`PICKER_OPEN_WAIT_MS` in `dewa_daily.js`. A `month picker closed
   before selecting <Month Year>` warning means the picker opened but closed again before the
   target month was clicked (typically while the chart was still reloading); the whole picker
   selection is retried up to `PICKER_SELECT_RETRIES` (2) times, and a final `locator.click:
   Timeout ... waiting for locator('.datepicker.active ...')` error means every retry hit it.
4. If you see `Error: Daily tab on #dvElectricity/#dvWater never activated after 3 retries`, the
   "Daily" tab's markup or its `active` class no longer matches what `activateDailyTab()` expects
   in `dewa_daily.js`. This is independent of the month-picker/data-series retries below - it
   fails before either of those runs. Check the logged `Daily tab did not activate after click`
   warnings and the dumped page HTML.
5. If you see `Error: data-series on #dvElectricity/#dvWater never matched '<label>' after 9
   retries`, the panel never reloaded with the requested month (allow more time by increasing
   `DATA_SERIES_RETRIES`/`DATA_SERIES_RETRY_DELAY_MS` in `dewa_daily.js`, and check `TIMEOUT` is
   large enough to cover it), or the `name` field DEWA embeds in `data-series` no longer matches
   the `"Month Year"` format (e.g. `"February 2026"`) expected by `formatMonthLabel()`. Check the
   logged mismatch warnings (`data-series name mismatch...`) for the actual `name` values
   returned. If the returned `name` is consistently for a *later* month than requested, the
   requested month is likely before that utility's data history began - set
   `ALLOW_MISSING_PRE_HISTORY_ELECTRICITY` / `ALLOW_MISSING_PRE_HISTORY_WATER` to `true` instead of
   treating this as a failure.
6. If you see `Error: Unexpected data-series format on ...`, DEWA has changed the shape of the
   `data-series` attribute; inspect the dumped page HTML to confirm the new structure.

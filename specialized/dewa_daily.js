/**
 * DEWA Daily Consumption Scraper
 * Uses Playwright to log in and extract per-day electricity/water consumption
 * for a requested date range.
 *
 * Setup:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Usage:
 *   DEWA_USER=your@email.com DEWA_PASS=yourpassword node dewa_daily.js
 */

if (process.env.PW_DEBUG_SCOPES) {
  process.env.DEBUG = process.env.PW_DEBUG_SCOPES;
}

const { chromium } = require("playwright");
const winston = require('winston');
const { format } = winston;
const fs = require('fs');
const path = require('path');

const USERNAME = process.env.DEWA_USER;
const PASSWORD = process.env.DEWA_PASS;
const DATE_FROM = process.env.DATE_FROM || '';
const DATE_TO = process.env.DATE_TO || '';
const TIMEOUT = process.env.TIMEOUT ? Number(process.env.TIMEOUT) : 60;
const DEWA_LOGIN_URL = "https://www.dewa.gov.ae/en/consumer/my-account/login";

const LOG_FILE_PATH = '/logs/miniscraper.log';
const consoleLevel = process.env.CONSOLE_LOG || 'none';
const fileLevel = process.env.FILE_LOG || 'warn';

const consoleTransport = new winston.transports.Console({
  silent: consoleLevel === 'none',
  level: consoleLevel === 'none' ? 'error' : consoleLevel,
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      const output = typeof message === 'string' ? message : JSON.stringify(message);
      return `${timestamp} - ${level}: ${output}`;
    })
  )
});

const transports = [consoleTransport];

if (fileLevel !== 'none') {
  if (fs.existsSync('/logs')) {
    transports.push(new winston.transports.File({
      filename: LOG_FILE_PATH,
      level: fileLevel,
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => {
          let output;
          if (typeof message === 'string') {
            output = message;
          } else if (typeof message === 'object' && message.message) {
            const { message: msg, ...rest } = message;
            output = `${msg} ${JSON.stringify(rest)}`;
          } else {
            output = JSON.stringify(message);
          }
          return `${timestamp} - ${level[0].toUpperCase()}: ${output}`;
        })
      )
    }));
  } else {
    console.warn('WARN: FILE_LOG is set but /logs directory does not exist; file logging disabled');
  }
}

const logger = winston.createLogger({ transports });

// Validate TIMEOUT parameter (only when explicitly provided; default is 60)
if (process.env.TIMEOUT !== undefined) {
  if (isNaN(TIMEOUT) || TIMEOUT < 10 || TIMEOUT > 300) {
    logger.error(`Error: TIMEOUT must be a number between 10 and 300 seconds`);
    logger.error(`Usage: TIMEOUT=60 node dewa_daily.js`);
    process.exit(1);
  }
}

// Check if credentials are provided
if (!USERNAME || !PASSWORD) {
  logger.error(`Error: DEWA_USER and DEWA_PASS environment variables must be set.`);
  logger.error(`Usage: DEWA_USER=your@email.com DEWA_PASS=yourpassword node dewa_daily.js`);
  process.exit(1);
}

function parseBooleanFlag(envVarName) {
  const raw = process.env[envVarName];
  if (raw === undefined) return false;
  if (raw !== 'true' && raw !== 'false') {
    logger.error(`Error: ${envVarName} must be 'true' or 'false'`);
    logger.error(`Usage: ${envVarName}=true node dewa_daily.js`);
    process.exit(1);
  }
  return raw === 'true';
}

// DEWA's Daily chart, when navigated to a month before the utility's own data history
// begins, snaps to the earliest month it actually has data for instead of the requested
// one - so the requested month simply has no data. These flags let the caller opt in to
// treating that as "no data for this period" rather than a hard error, separately per
// utility since electricity and water history start on different dates.
const ALLOW_MISSING_PRE_HISTORY_ELECTRICITY = parseBooleanFlag('ALLOW_MISSING_PRE_HISTORY_ELECTRICITY');
const ALLOW_MISSING_PRE_HISTORY_WATER = parseBooleanFlag('ALLOW_MISSING_PRE_HISTORY_WATER');

// Validate DATE_FROM / DATE_TO and resolve open ranges.
// Floor date is temporary: intended target is 2020-02-01, using 2019-01-01 for now.
const MIN_DATE_FROM = '2019-01-01';
const DUBAI_TZ = 'Asia/Dubai';

function dubaiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: DUBAI_TZ });
}

function isCurrentDubaiMonth(year, month) {
  const [todayYear, todayMonth] = dubaiToday().split('-').map(Number);
  return year === todayYear && month === todayMonth;
}

function dubaiYesterday() {
  const [year, month, day] = dubaiToday().split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function validateDate(value, label) {
  if (!isValidCalendarDate(value)) {
    logger.error(`Error: ${label} must be a valid date in yyyy-MM-dd format`);
    logger.error(`Usage: ${label}=2025-08-01 node dewa_daily.js`);
    process.exit(1);
  }
}

if (DATE_FROM) validateDate(DATE_FROM, 'DATE_FROM');
if (DATE_TO) validateDate(DATE_TO, 'DATE_TO');

const today = dubaiToday();
for (const [label, value] of [['DATE_FROM', DATE_FROM], ['DATE_TO', DATE_TO]]) {
  if (value && value >= today) {
    logger.error(`Error: ${label} must be yesterday or earlier`);
    logger.error(`Usage: ${label}=2025-08-01 node dewa_daily.js`);
    process.exit(1);
  }
}

if (DATE_FROM && DATE_FROM < MIN_DATE_FROM) {
  logger.error(`Error: DATE_FROM must be ${MIN_DATE_FROM} or later`);
  logger.error(`Usage: DATE_FROM=${MIN_DATE_FROM} node dewa_daily.js`);
  process.exit(1);
}

if (DATE_FROM && DATE_TO && DATE_FROM > DATE_TO) {
  logger.error(`Error: DATE_FROM must not be later than DATE_TO`);
  logger.error(`Usage: DATE_FROM=2025-08-01 DATE_TO=2025-08-07 node dewa_daily.js`);
  process.exit(1);
}

const yesterday = dubaiYesterday();
const resolvedDateFrom = DATE_FROM || (DATE_TO ? MIN_DATE_FROM : yesterday);
const resolvedDateTo = DATE_TO || yesterday;

function requireParentDir(filePath, label) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    logger.error(`Error: ${label} parent directory '${dir}' does not exist`);
    process.exit(1);
  }
}

const networkHarPath = process.env.NETWORK_HAR_PATH || null;
if (networkHarPath) {
  requireParentDir(networkHarPath, 'NETWORK_HAR_PATH');
}

function parseTraceConfig(value) {
  if (!value) return null;
  const tokens = value.trim().split(/\s+/);
  const tracePath = tokens.shift();
  const options = { screenshots: false, snapshots: false, sources: false };
  for (const token of tokens) {
    const idx = token.indexOf(':');
    if (idx === -1) {
      throw new Error(`Invalid TRACE_CONFIG token '${token}'. Expected format flag:true|false`);
    }
    const flag = token.slice(0, idx);
    const val = token.slice(idx + 1);
    if (!Object.prototype.hasOwnProperty.call(options, flag)) {
      throw new Error(`Invalid TRACE_CONFIG flag '${flag}'. Allowed: screenshots, snapshots, sources`);
    }
    if (val !== 'true' && val !== 'false') {
      throw new Error(`Invalid TRACE_CONFIG value '${val}' for flag '${flag}'. Must be true or false`);
    }
    options[flag] = val === 'true';
  }
  return { path: tracePath, options };
}

let traceConfig;
try {
  traceConfig = parseTraceConfig(process.env.TRACE_CONFIG);
} catch (err) {
  logger.error(`Error: ${err.message}`);
  process.exit(1);
}
if (traceConfig) {
  requireParentDir(traceConfig.path, 'TRACE_CONFIG path');
}

const failureDumpPrefixEnv = process.env.FAILURE_DUMP_PREFIX;
const failureDumpPrefix = failureDumpPrefixEnv
  ? (failureDumpPrefixEnv.startsWith('/') ? failureDumpPrefixEnv : '/logs/' + failureDumpPrefixEnv)
  : '/logs/';
const screenshotDumpPath = `${failureDumpPrefix}screenshot.png`;
const pageDumpPath = `${failureDumpPrefix}page.html`;
if (failureDumpPrefixEnv) {
  requireParentDir(screenshotDumpPath, 'FAILURE_DUMP_PREFIX');
}

// ─── Daily consumption retrieval helpers ────────────────────────────────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const UTILITIES = [
  { key: 'electricity', containerSelector: '#dvElectricity', inputSelector: '#dp_month_e1', allowMissingPreHistory: ALLOW_MISSING_PRE_HISTORY_ELECTRICITY },
  { key: 'water', containerSelector: '#dvWater', inputSelector: '#dp_month_w1', allowMissingPreHistory: ALLOW_MISSING_PRE_HISTORY_WATER },
];

// DEWA uses Air Datepicker (https://air-datepicker.com/) for the month input. Every
// date/month input on the page gets its own picker instance in a shared
// #datepickers-container; closed ones sit parked off-screen (left: -100000px) rather
// than display:none, so :visible doesn't distinguish them - the currently-open one is
// instead marked with an `active` class on the `.datepicker` wrapper. In "months" mode
// the header shows just the year, and prev/next navigate by year (not month).
const MONTH_PICKER = {
  yearHeaderSelector: '.datepicker.active .datepicker--nav-title',
  prevYearSelector: '.datepicker.active .datepicker--nav-action[data-action="prev"]',
  nextYearSelector: '.datepicker.active .datepicker--nav-action[data-action="next"]',
  monthCellSelector: (monthIndex) => `.datepicker.active .datepicker--cell-month[data-month="${monthIndex}"]`,
};

const DAILY_TAB_RETRIES = 3;
const DAILY_TAB_RETRY_DELAY_MS = 1000;
const DAILY_TAB_ACTIVATION_WAIT_MS = 15000;

// Separate, more generous budget for waiting on the chart's data-series to actually
// refresh after the Daily tab is active - this is chart render latency, not the tab-click
// flakiness DAILY_TAB_RETRIES/DELAY above are tuned for. The current month in particular
// can take a while to populate since its picker cell is disabled and there's no explicit
// selection action to hang a wait off of.
const DATA_SERIES_RETRIES = 9;
const DATA_SERIES_RETRY_DELAY_MS = 2000;

// After opening the month picker or clicking prev/next, Air Datepicker briefly re-renders
// its own nav/cells DOM. Interacting again immediately (as Playwright does, unlike a human)
// can land mid-re-render and detach the element Playwright already resolved. Beyond that
// render race, DEWA also runs Akamai Bot Manager, which does its own behavioral scoring on
// click timing - a burst of clicks spaced by an exact, fixed interval reads as clearly
// non-human and can get the picker throttled into never showing as active again, independent
// of any render-race timing. A larger, randomized (not fixed) delay between picker
// interactions addresses both at once.
const PICKER_SETTLE_DELAY_MIN_MS = 800;
const PICKER_SETTLE_DELAY_MAX_MS = 1600;

async function pickerSettle(page) {
  const delay = PICKER_SETTLE_DELAY_MIN_MS + Math.random() * (PICKER_SETTLE_DELAY_MAX_MS - PICKER_SETTLE_DELAY_MIN_MS);
  await page.waitForTimeout(delay);
}

// Same flakiness class as DAILY_TAB_RETRIES/activateDailyTab() below, just for the click that
// opens the month picker itself: it sometimes just doesn't register, independent of how long
// we wait afterward. A single click backed by one long wait can burn tens of seconds doing
// nothing when that happens; retrying the click with a bounded per-attempt wait recovers in
// practice, the same way it does for the Daily tab click.
const PICKER_OPEN_RETRIES = 3;
const PICKER_OPEN_WAIT_MS = 5000;

// Even once open, the picker can close on its own before we've clicked through to the target
// month - observed as the month-cell click waiting on `.datepicker.active` until the whole
// run budget ran out, with every picker instance inactive in the failure dump. Each click
// inside the picker therefore gets a bounded wait, and if the picker has gone away the whole
// open/navigate/click sequence is retried from scratch.
const PICKER_SELECT_RETRIES = 2;
const PICKER_ACTION_WAIT_MS = 5000;

// Clicking the Daily tab kicks off an async reload of the chart for the default (current)
// month. Opening the picker while that is still in flight is the likely trigger for it being
// closed again underneath us, so before touching the picker we wait (bounded) for the panel's
// data-series to switch to daily data, i.e. to be named by a "Month Year" label.
const DAILY_SERIES_READY_WAIT_MS = 10000;
const DAILY_SERIES_READY_POLL_MS = 500;

function monthsInRange(fromISO, toISO) {
  const [fromYear, fromMonth] = fromISO.split('-').map(Number);
  const [toYear, toMonth] = toISO.split('-').map(Number);
  const months = [];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatMonthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function parseMonthLabel(label) {
  const match = /^([A-Za-z]+) (\d{4})$/.exec(label.trim());
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1]);
  if (monthIndex === -1) return null;
  return { year: Number(match[2]), month: monthIndex + 1 };
}

function isLaterMonth(candidate, year, month) {
  return candidate.year > year || (candidate.year === year && candidate.month > month);
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function enumerateDates(fromISO, toISO) {
  const dates = [];
  let d = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function parseDataSeries(rawAttr, containerSelector) {
  let series;
  try {
    series = JSON.parse(rawAttr);
  } catch (err) {
    throw new Error(`Error: Unable to parse data-series on ${containerSelector}: ${err.message}`);
  }
  if (!Array.isArray(series)) {
    throw new Error(`Error: Unexpected data-series format on ${containerSelector}`);
  }
  return series;
}

function datesInMonthRange(year, month, fromISO, toISO) {
  const dates = [];
  const lastDay = daysInMonth(year, month);
  for (let day = 1; day <= lastDay; day++) {
    const date = isoDate(year, month, day);
    if (date < fromISO || date > toISO) continue;
    dates.push(date);
  }
  return dates;
}

function seriesToDailyRecords(data, year, month, fromISO, toISO) {
  const records = new Map();
  const lastDay = daysInMonth(year, month);
  data.forEach((value, index) => {
    const day = index + 1;
    if (day > lastDay) return;
    const date = isoDate(year, month, day);
    if (date < fromISO || date > toISO) return;
    records.set(date, value);
  });
  return records;
}

// Clicking the "Daily" tab reveals the month-picker input we actually need. The
// transition isn't instant, and the click itself is flaky - sometimes it just doesn't
// register at all, independent of how long we wait afterward - so this retries the
// click a bounded number of times, giving each attempt a generous (but not
// budget-draining) window to complete rather than the whole remaining timeout.
//
// The "Daily" tab's own `active` class is the authoritative activation signal - not
// the month input's visibility. The two utilities don't even agree on a data-index
// for "Daily" (electricity uses 1, water uses 2), and on water the month input can
// end up visible/clickable while the "Monthly" tab is still the one actually active,
// silently leaving the chart on monthly data. Matching by the tab's text (not index)
// keeps this working for both utilities.
async function activateDailyTab(page, containerSelector, inputSelector, getRemaining) {
  const dailyTab = page.locator(`${containerSelector} ul li:text-is("Daily")`);
  const isDailyActive = async () => {
    const classAttr = await dailyTab.getAttribute('class', { timeout: getRemaining() });
    return (classAttr || '').split(/\s+/).includes('active');
  };

  if (await isDailyActive()) {
    return;
  }

  for (let attempt = 0; attempt <= DAILY_TAB_RETRIES; attempt++) {
    await dailyTab.click({ timeout: getRemaining() });
    try {
      await page.locator(`${inputSelector}:visible`).waitFor({
        state: 'visible',
        timeout: Math.min(getRemaining(), DAILY_TAB_ACTIVATION_WAIT_MS),
      });
    } catch (waitErr) {
      // Input never showed up; fall through to the active-class check, which
      // decides whether to retry.
    }
    if (await isDailyActive()) {
      return;
    }
    logger.warn(`${containerSelector}: Daily tab did not activate after click, attempt ${attempt + 1}/${DAILY_TAB_RETRIES + 1}`);
  }

  throw new Error(`Error: Daily tab on ${containerSelector} never activated after ${DAILY_TAB_RETRIES} retries`);
}

async function openMonthPicker(page, inputSelector, getRemaining) {
  const yearHeader = page.locator(MONTH_PICKER.yearHeaderSelector);
  // Same duplicated-instance quirk as activateDailyTab() - narrow to the visible copy.
  const monthInput = page.locator(`${inputSelector}:visible`);

  for (let attempt = 0; attempt <= PICKER_OPEN_RETRIES; attempt++) {
    await monthInput.click({ timeout: getRemaining() });
    try {
      await yearHeader.waitFor({ state: 'visible', timeout: Math.min(getRemaining(), PICKER_OPEN_WAIT_MS) });
      await pickerSettle(page);
      return;
    } catch (waitErr) {
      // Picker never opened; fall through to retry the click.
    }
    logger.warn(`${inputSelector}: month picker did not open after click, attempt ${attempt + 1}/${PICKER_OPEN_RETRIES + 1}`);
  }

  throw new Error(`Error: month picker for ${inputSelector} never opened after ${PICKER_OPEN_RETRIES} retries`);
}

async function selectMonthInPicker(page, inputSelector, targetYear, targetMonth, getRemaining) {
  for (let attempt = 0; attempt <= PICKER_SELECT_RETRIES; attempt++) {
    try {
      await navigatePickerToMonth(page, inputSelector, targetYear, targetMonth, getRemaining);
      return;
    } catch (err) {
      // Only a picker that vanished mid-sequence (bounded wait timing out) is worth retrying;
      // anything else (unreadable header, unreachable year, ...) is a real failure.
      if (err.name !== 'TimeoutError' || attempt === PICKER_SELECT_RETRIES) throw err;
      logger.warn(`${inputSelector}: month picker closed before selecting ${formatMonthLabel(targetYear, targetMonth)}, attempt ${attempt + 1}/${PICKER_SELECT_RETRIES + 1}`);
    }
  }
}

async function navigatePickerToMonth(page, inputSelector, targetYear, targetMonth, getRemaining) {
  await openMonthPicker(page, inputSelector, getRemaining);

  const actionTimeout = () => Math.min(getRemaining(), PICKER_ACTION_WAIT_MS);
  const yearHeader = page.locator(MONTH_PICKER.yearHeaderSelector);
  const readYear = async () => {
    const text = await yearHeader.innerText({ timeout: actionTimeout() });
    const year = Number(text.trim());
    if (!Number.isInteger(year)) {
      throw new Error(`Error: Unable to read month picker year header '${text}'`);
    }
    return year;
  };

  let currentYear = await readYear();
  let guard = 0;
  const maxSteps = 60; // 60 years of prev/next clicks, generous upper bound
  while (currentYear !== targetYear && guard < maxSteps) {
    const selector = currentYear < targetYear ? MONTH_PICKER.nextYearSelector : MONTH_PICKER.prevYearSelector;
    await page.locator(selector).click({ timeout: actionTimeout() });
    await pickerSettle(page);
    currentYear = await readYear();
    guard += 1;
  }
  if (currentYear !== targetYear) {
    throw new Error(`Error: Unable to navigate month picker to year ${targetYear}`);
  }

  await pickerSettle(page);
  const monthIndex = targetMonth - 1; // Air Datepicker months are 0-indexed
  await page.locator(MONTH_PICKER.monthCellSelector(monthIndex)).click({ timeout: actionTimeout() });
}

// Bounded, non-fatal: if the daily data never shows up here, the data-series retries in
// readMonthlySeries() still decide the outcome - this only avoids opening the picker while
// the Daily tab's own chart reload is still in flight.
async function waitForDailySeries(page, containerSelector, getRemaining) {
  const deadline = Date.now() + Math.min(getRemaining(), DAILY_SERIES_READY_WAIT_MS);
  while (Date.now() < deadline) {
    const raw = await page.locator(containerSelector).getAttribute('data-series', { timeout: getRemaining() });
    const series = parseDataSeries(raw, containerSelector);
    if (series.some(s => typeof s.name === 'string' && parseMonthLabel(s.name))) return;
    await page.waitForTimeout(DAILY_SERIES_READY_POLL_MS);
  }
  logger.warn(`${containerSelector}: Daily data-series not loaded after ${DAILY_SERIES_READY_WAIT_MS}ms, opening month picker anyway`);
}

// Returns the requested month's per-day data array, or null if the requested month is
// before this utility's data history begins and allowMissingPreHistory is set for it (see
// the before-data-start check below).
async function readMonthlySeries(page, utility, year, month, getRemaining) {
  const { containerSelector, inputSelector, allowMissingPreHistory } = utility;
  const expectedLabel = formatMonthLabel(year, month);

  await activateDailyTab(page, containerSelector, inputSelector, getRemaining);
  const targetIsCurrentMonth = isCurrentDubaiMonth(year, month);
  // The current (still in-progress) month's cell is disabled in the picker - DEWA only
  // allows navigating to completed past months there. We don't assume the Daily view
  // already shows the current month by default just because we can't click it into
  // place; the data-series check below (with retries) is what actually confirms it.
  if (!targetIsCurrentMonth) {
    await waitForDailySeries(page, containerSelector, getRemaining);
    await selectMonthInPicker(page, inputSelector, year, month, getRemaining);
  }

  for (let attempt = 0; attempt <= DATA_SERIES_RETRIES; attempt++) {
    const raw = await page.locator(containerSelector).getAttribute('data-series', { timeout: getRemaining() });
    const series = parseDataSeries(raw, containerSelector);
    const match = series.find(s => s.name === expectedLabel);
    if (match) return match.data;

    // When the requested month is before this utility's data history begins, DEWA
    // doesn't error - it silently clamps the Daily view to the earliest month it does
    // have data for, which never resolves into a match no matter how long we retry. Its
    // picker cell being disabled also means our click may never register any change at
    // all (the panel can already be sitting on that earliest month before we even try),
    // so unlike an ordinary render-latency mismatch, we don't wait for a change - we
    // detect this case directly: the mismatched series it's showing is for a *later*
    // period than requested, i.e. further ahead than the requested month rather than
    // still catching up to it.
    if (allowMissingPreHistory) {
      const snappedForward = series.some((s) => {
        const parsed = parseMonthLabel(s.name);
        return parsed && isLaterMonth(parsed, year, month);
      });
      if (snappedForward) return null;
    }

    logger.warn(`${containerSelector}: data-series name mismatch (expected '${expectedLabel}', got ${JSON.stringify(series.map(s => s.name))}), attempt ${attempt + 1}/${DATA_SERIES_RETRIES + 1}`);
    if (attempt === DATA_SERIES_RETRIES) {
      const context = targetIsCurrentMonth
        ? ` (this is the current month; its picker cell is disabled, so the Daily view was expected to default to it but never showed matching data)`
        : '';
      throw new Error(`Error: data-series on ${containerSelector} never matched '${expectedLabel}' after ${DATA_SERIES_RETRIES} retries${context}`);
    }
    await page.waitForTimeout(DATA_SERIES_RETRY_DELAY_MS);
    // Re-activating (not blindly re-clicking) matters here: clicking the Daily tab
    // while it's already active toggles it back to Monthly rather than refreshing it,
    // which is what caused water to end up stuck on stale Monthly data in practice.
    await activateDailyTab(page, containerSelector, inputSelector, getRemaining);
  }
}

async function scrapeDEWA() {
  const startTime = Date.now();
  const getRemaining = () => {
    const remaining = TIMEOUT * 1000 - (Date.now() - startTime);
    if (remaining <= 0) throw new Error('Operation timed out');
    return remaining;
  };

  const browser = await chromium.launch({
    headless: true, // Set to false to watch the browser in action (useful for debugging)
    args: [
      "--disable-blink-features=AutomationControlled",
      // Headless Chromium throttles rAF/timers on pages it treats as backgrounded/occluded.
      // The month picker's open transition depends on one of those to add its `active`
      // class, so without these flags it can silently never finish - reproduced by it only
      // working while Playwright tracing's per-action screenshots forced regular paints.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });

  const contextOptions = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    locale: "en-AE",
    timezoneId: "Asia/Dubai",
    viewport: { width: 1366, height: 768 },
  };
  if (networkHarPath) {
    contextOptions.recordHar = { path: networkHarPath };
  }

  const context = await browser.newContext(contextOptions);

  // Patch the automation tells that bot-mitigation services (e.g. Incapsula)
  // check for before the DEWA login form is allowed to render.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-AE", "en"] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  let tracingStarted = false;
  if (traceConfig) {
    await context.tracing.start(traceConfig.options);
    tracingStarted = true;
  }

  const page = await context.newPage();

  try {
    // ─── Step 1: Go to login page ───────────────────────────────────────────
    logger.debug(`Navigating to DEWA login page...`);
    await page.goto(DEWA_LOGIN_URL, { waitUntil: "load", timeout: getRemaining() });

    // ─── Step 2: Fill login form ─────────────────────────────────────────────
    // NOTE: Inspect the DEWA login page and update these selectors if they change
    logger.debug(`Filling in credentials...`);
    await page.locator('input[name="Username"]').pressSequentially(USERNAME, { delay: 60, timeout: getRemaining() });
    await page.locator('input[name="Password"]').pressSequentially(PASSWORD, { delay: 60, timeout: getRemaining() });

    // Click login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: getRemaining() }),
      page.click('button[type="submit"]', { timeout: getRemaining() })
    ]);
    logger.info(`Logged in. Current URL: ${page.url()}`);

    // ─── Step 3: Retrieve consumption for the requested date range ─────────
    logger.info(`Retrieving daily consumption for ${resolvedDateFrom} to ${resolvedDateTo}`);

    const perDate = new Map();
    for (const date of enumerateDates(resolvedDateFrom, resolvedDateTo)) {
      perDate.set(date, { date, electricity: null, water: null });
    }

    // Dates intentionally left null because the requested month is before that utility's
    // data history began and allowMissingPreHistory is set for it - excluded from the
    // missing-reading warnings below since this is expected, not an unexpected gap.
    const ignoredDates = { electricity: new Set(), water: new Set() };

    // The current month's Daily view only shows its data by default when nothing else has
    // been explicitly selected yet - its picker cell is disabled, so once some other month
    // has been picked (which happens for any earlier month in a normal chronological pass),
    // the chart just keeps showing that selection forever instead of ever moving back to the
    // current month. Processing the current month first (per utility, before any other
    // month's explicit selection can overwrite that default) is what lets readMonthlySeries'
    // no-selection path for it actually work.
    const orderedMonths = monthsInRange(resolvedDateFrom, resolvedDateTo);
    const currentMonthIndex = orderedMonths.findIndex(({ year, month }) => isCurrentDubaiMonth(year, month));
    if (currentMonthIndex > 0) {
      const [currentMonthEntry] = orderedMonths.splice(currentMonthIndex, 1);
      orderedMonths.unshift(currentMonthEntry);
    }

    for (const { year, month } of orderedMonths) {
      for (const utility of UTILITIES) {
        const data = await readMonthlySeries(page, utility, year, month, getRemaining);
        if (data === null) {
          for (const date of datesInMonthRange(year, month, resolvedDateFrom, resolvedDateTo)) {
            ignoredDates[utility.key].add(date);
          }
          continue;
        }
        const monthRecords = seriesToDailyRecords(data, year, month, resolvedDateFrom, resolvedDateTo);
        for (const [date, value] of monthRecords) {
          const entry = perDate.get(date);
          if (entry) entry[utility.key] = value;
        }
      }
    }

    const results = Array.from(perDate.values());
    for (const entry of results) {
      const missingElectricity = entry.electricity === null && !ignoredDates.electricity.has(entry.date);
      const missingWater = entry.water === null && !ignoredDates.water.has(entry.date);
      if (missingElectricity || missingWater) {
        logger.warn(`Missing reading for ${entry.date}: electricity=${entry.electricity}, water=${entry.water}`);
      }
    }

    logger.info(`Completed successfully: ${results.length} day(s) retrieved`);
    return results;
  } catch (err) {
    logger.error(`Scraping failed: ${err.message}`);

    // Screenshot on failure helps diagnose what went wrong
    try {
      await page.screenshot({ path: screenshotDumpPath, fullPage: true });
      logger.warn(`Screenshot saved to ${screenshotDumpPath}`);
    } catch (screenshotErr) {
      logger.warn(`Failed to save screenshot: ${screenshotErr.message}`);
    }

    // Save HTML content for additional debugging
    try {
      const htmlContent = await page.content();
      fs.writeFileSync(pageDumpPath, htmlContent);
      logger.warn(`HTML content saved to ${pageDumpPath}`);
    } catch (htmlErr) {
      logger.warn(`Failed to save page HTML: ${htmlErr.message}`);
    }

    throw err;
  } finally {
    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceConfig.path });
      } catch (traceErr) {
        logger.warn(`Failed to save trace: ${traceErr.message}`);
      }
    }
    await context.close().catch(() => {});
    await browser.close();
  }
}

(async () => {
  try {
    const results = await scrapeDEWA();
    console.log(JSON.stringify(results));
  } catch (error) {
    console.error({ error: error.message });
    process.exit(1);
  }
})();

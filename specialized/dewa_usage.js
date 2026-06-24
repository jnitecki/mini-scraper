/**
 * DEWA Electricity Usage Scraper
 * Uses Playwright to log in and extract consumption data.
 *
 * Setup:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Usage:
 *   DEWA_USER=your@email.com DEWA_PASS=yourpassword node dewa_scraper.js
 */

const { chromium } = require("playwright");
const winston = require('winston');
const { format, transports } = winston;
require('winston-daily-rotate-file');
const fs = require('fs');
const path = require('path');

const USERNAME = process.env.DEWA_USER;
const PASSWORD = process.env.DEWA_PASS;
const PERIOD = process.env.PERIOD || 'CURRENT';
const TIMEOUT = process.env.TIMEOUT ? Number(process.env.TIMEOUT) : 60;
const CLEANUP_DAYS = process.env.CLEANUP_DAYS || '14';
const DEWA_LOGIN_URL = "https://www.dewa.gov.ae/en/consumer/my-account/login";

const cleanupDaysNum = Number(CLEANUP_DAYS);
const cleanupDaysValid = !isNaN(cleanupDaysNum) && Number.isInteger(cleanupDaysNum) && cleanupDaysNum >= 0;

const consoleTransport = new winston.transports.Console({
  silent: process.env.CONSOLE_LOG === 'none',
  level: process.env.CONSOLE_LOG === 'none' ? 'error' : (process.env.CONSOLE_LOG || 'warn'),
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) =>
      `${timestamp} - ${level}: ${message}`
    )
  )
});

const fileTransport = new winston.transports.DailyRotateFile({
  filename: '/logs/miniscraper-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  ...(cleanupDaysValid && cleanupDaysNum > 0 ? { maxFiles: CLEANUP_DAYS + 'd' } : {}),
  silent: process.env.FILE_LOG === 'none',
  level: process.env.FILE_LOG === 'none' ? 'error' : (process.env.FILE_LOG || 'info'),
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-dd HH:mm:ss' }),
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
});

const logger = winston.createLogger({
  transports: [
    consoleTransport,
    fileTransport
  ]
});

if (!cleanupDaysValid) {
  logger.error(`Error: CLEANUP_DAYS must be a non-negative integer. Value '${process.env.CLEANUP_DAYS}' is invalid. Log file rotation cleanup is disabled.`);
  process.exit(1);
}

// Validate TIMEOUT parameter (only when explicitly provided; default is 60)
if (process.env.TIMEOUT !== undefined) {
  if (isNaN(TIMEOUT) || TIMEOUT < 10 || TIMEOUT > 300) {
    logger.error(`Error: TIMEOUT must be a number between 10 and 300 seconds`);
    logger.error(`Usage: TIMEOUT=60 node dewa_usage.js`);
    process.exit(1);
  }
}

// Check if credentials are provided
if (!USERNAME || !PASSWORD) {
  logger.error(`Error: DEWA_USER and DEWA_PASS environment variables must be set.`);
  logger.error(`Usage: DEWA_USER=your@email.com DEWA_PASS=yourpassword node dewa_usage.js`);
  process.exit(1);
}

// Validate period input
const normalizedPeriod = PERIOD.toUpperCase();
if (normalizedPeriod !== 'CURRENT') {
  // Check if it's a valid date format yyyy-mm
  const dateRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!dateRegex.test(PERIOD)) {
    logger.error(`Error: PERIOD must be either 'CURRENT' or a date in yyyy-mm format (e.g., 2023-12)`);
    logger.error(`Usage: PERIOD=2023-12 node dewa_usage.js`);
    process.exit(1);
  }
  
  // Validate date range: between May 2025 and current month
  const [year, month] = PERIOD.split('-').map(Number);
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1; // getMonth() returns 0-11
  
  // Check if date is before May 2025
  if (year < 2025 || (year === 2025 && month < 5)) {
    logger.error(`Error: PERIOD must be May 2025 or later`);
    logger.error(`Usage: PERIOD=2025-05 node dewa_usage.js`);
    process.exit(1);
  }
  
  // Check if date is in the future
  if (year > currentYear || (year === currentYear && month >= currentMonth)) {
    logger.error(`Error: PERIOD must be in the past month or 'current' for current period`);
    logger.error(`Usage: PERIOD=2023-12 node dewa_usage.js`);
    process.exit(1);
  }
}

function removeOldFiles(dir, prefix, ext, cutoffDate) {
  let count = 0;
  fs.readdirSync(dir).forEach(file => {
    if (file.startsWith(prefix) && file.endsWith(ext)) {
      const filePath = path.join(dir, file);
      try {
        if (new Date(fs.statSync(filePath).mtime) < cutoffDate) {
          fs.unlinkSync(filePath);
          logger.debug(`Removed old file: ${file}`);
          count++;
        }
      } catch (error) {
        logger.warn(`Failed to remove ${file}: ${error.message}`);
      }
    }
  });
  return count;
}

async function cleanupOldScreenshotsAndPages() {
  try {
    const logsDir = '/logs';

    if (!fs.existsSync(logsDir)) {
      return;
    }

    const cleanupDays = parseInt(CLEANUP_DAYS);
    if (isNaN(cleanupDays) || cleanupDays < 0) {
      logger.warn(`Invalid CLEANUP_DAYS value: ${CLEANUP_DAYS}. Skipping cleanup.`);
      return;
    }

    if (cleanupDays === 0) {
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cleanupDays);

    const removedCount =
      removeOldFiles(logsDir, 'screenshot_', '.png', cutoffDate) +
      removeOldFiles(logsDir, 'page_', '.html', cutoffDate);

    if (removedCount > 0) {
      logger.info(`Successfully cleaned up ${removedCount} old screenshot and page files`);
    }
  } catch (error) {
    logger.warn(`Cleanup process failed: ${error.message}`);
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
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    // ─── Step 1: Go to login page ───────────────────────────────────────────
    logger.debug(`Navigating to DEWA login page...`);
    await page.goto(DEWA_LOGIN_URL, { waitUntil: "networkidle", timeout: getRemaining() });

    // ─── Step 2: Fill login form ─────────────────────────────────────────────
    // NOTE: Inspect the DEWA login page and update these selectors if they change
    logger.debug(`Filling in credentials...`);
    await page.fill('input[name="Username"]', USERNAME, { timeout: getRemaining() });
    await page.fill('input[name="Password"]', PASSWORD, { timeout: getRemaining() });

    // Click login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: getRemaining() }),
      page.click('button[type="submit"]', { timeout: getRemaining() })
    ]);
    logger.info(`Logged in. Current URL: ${page.url()}`);

    // ─── Step 3: Wait for data to load ──────────────────────────────────────
    // Select requested period of usage
    let optionValue;
    if (normalizedPeriod === 'CURRENT') {
      optionValue = "UnbilledConsumption";
    } else {
      // Convert date format yyyy-mm to the expected format (e.g., 2023-12 becomes 202312)
      const [year, month] = PERIOD.split('-').map(Number);
      optionValue = `${month}${year}`; // Format as myyyy (no leading zero for month)
    }
    
    logger.debug(`Selecting period: ${optionValue}`);
    
    // Get all available options for debugging
    const allOptions = await page.evaluate(() => {
      const select = document.querySelector('select:first-of-type');
      return Array.from(select.options).map(option => ({
        value: option.value,
        text: option.text
      }));
    });
    
    logger.debug(`Available periods: ${allOptions}`);
    
    // Validate that the requested option is available
    if (!allOptions.some(option => option.value === optionValue)) {
      throw new Error(`Error: Requested period '${optionValue}' is not available`);
    }
    
    let period;
    while (true) {
      period = await page.$eval('select:first-of-type', el => ({
        value: el.value,
        text: el.options[el.selectedIndex].text
      }));
      if (period.value == optionValue)
        break;
      logger.debug(`Selecting option: ${optionValue}`);
      await Promise.all([
        page.waitForFunction(() => new Promise(resolve => setTimeout(resolve, 0)), { timeout: getRemaining() }),
        page.selectOption('select:first-of-type', { value: optionValue }, { timeout: getRemaining() })
      ]);
    }

    const electricity = await page.$eval('#gauge-component > form + div > div:nth-child(1)', el => ({ value: el.innerText.split(/\r\n|\r|\n/)[0], type: el.innerText.split(/\r\n|\r|\n/)[2]}));
    const water = await page.$eval('#gauge-component > form + div > div:nth-child(2)', el => ({ value: el.innerText.split(/\r\n|\r|\n/)[0], type: el.innerText.split(/\r\n|\r|\n/)[2]}));

    logger.debug(period);
    logger.debug(electricity);
    logger.debug(water);

    if (electricity.type != "Electricity" || water.type != "Water") {
      throw new Error("Error: Unknown format of the page. Usage data not found.");
    }

    logger.info(`Completed successfully: ${period.text} - Electricity ${electricity.value} kWh - Water ${water.value} m3`);
    return { period: period.text, electricity: electricity.value, water: water.value };
  } catch (err) {
    logger.error(`Scraping failed: ${err.message}`);

    // Generate timestamp for consistent file naming
    const now = new Date();
    const timestamp = now.toISOString().slice(2, 10).replace(/-/g, '') + 
                     now.toTimeString().slice(0, 8).replace(/:/g, '');
    
    // Screenshot on failure helps diagnose what went wrong
    await page.screenshot({ path: `/logs/screenshot_${timestamp}.png`, fullPage: true });
    logger.warn(`Screenshot saved to screenshot_${timestamp}.png`);
    
    // Save HTML content for additional debugging
    const htmlContent = await page.content();
    fs.writeFileSync(`/logs/page_${timestamp}.html`, htmlContent);
    logger.warn(`HTML content saved to page_${timestamp}.html`);

    console.error({ error: err.message });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    const results = await scrapeDEWA();
    // Cleanup old screenshots and pages only on successful completion
    cleanupOldScreenshotsAndPages();
    console.log(results);
  } catch (error) {
    console.error('Scraping failed:', error.message);
    process.exit(1);
  }
})();


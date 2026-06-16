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
const CLEANUP_DAYS = process.env.CLEANUP_DAYS || '14';
const DEWA_LOGIN_URL = "https://www.dewa.gov.ae/en/consumer/my-account/login";

// Validate CLEANUP_DAYS parameter
if (CLEANUP_DAYS !== '0' && (isNaN(CLEANUP_DAYS) || parseInt(CLEANUP_DAYS) < 0)) {
  logger.warn(`Invalid CLEANUP_DAYS value: ${CLEANUP_DAYS}. Using default 14 days.`);
  process.exit(1);
}

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
  maxFiles: CLEANUP_DAYS +'d',
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
  const dateRegex = /^202[5-6]-((0[1-9])|(1[0-2]))$/;
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

async function cleanupOldScreenshotsAndPages() {
  try {
    const logsDir = './logs';
    
    // Check if logs directory exists
    if (!fs.existsSync(logsDir)) {
      return;
    }

    // Parse the cleanup days - 0 means indefinite retention
    const cleanupDays = parseInt(CLEANUP_DAYS);
    if (isNaN(cleanupDays) || cleanupDays < 0) {
      logger.warn(`Invalid CLEANUP_DAYS value: ${CLEANUP_DAYS}. Using default 14 days.`);
      return;
    }

    // Read all files in the logs directory
    const files = fs.readdirSync(logsDir);
    
    let removedCount = 0;
    
    files.forEach(file => {
      // Only process screenshot_*.png and page_*.html files
      if (file.startsWith('screenshot_') && file.endsWith('.png')) {
        const filePath = path.join(logsDir, file);
        try {
          // Skip cleanup if cleanupDays is 0 (indefinite retention)
          if (cleanupDays === 0) {
            return;
          }
          
          const stats = fs.statSync(filePath);
          const fileDate = new Date(stats.mtime);
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - cleanupDays);
          
          // Remove file if it's older than the cutoff date
          if (fileDate < cutoffDate) {
            fs.unlinkSync(filePath);
            logger.debug(`Removed old screenshot: ${file}`);
            removedCount++;
          }
        } catch (error) {
          logger.warn(`Failed to remove screenshot ${file}: ${error.message}`);
        }
      } else if (file.startsWith('page_') && file.endsWith('.html')) {
        const filePath = path.join(logsDir, file);
        try {
          // Skip cleanup if cleanupDays is 0 (indefinite retention)
          if (cleanupDays === 0) {
            return;
          }
          
          const stats = fs.statSync(filePath);
          const fileDate = new Date(stats.mtime);
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - cleanupDays);
          
          // Remove file if it's older than the cutoff date
          if (fileDate < cutoffDate) {
            fs.unlinkSync(filePath);
            logger.debug(`Removed old page: ${file}`);
            removedCount++;
          }
        } catch (error) {
          logger.warn(`Failed to remove page ${file}: ${error.message}`);
        }
      }
    });
    
    if (removedCount > 0) {
      logger.info(`Successfully cleaned up ${removedCount} old screenshot and page files`);
    }
  } catch (error) {
    logger.warn(`Cleanup process failed: ${error.message}`);
  }
}

async function scrapeDEWA() {
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
    await page.goto(DEWA_LOGIN_URL, { waitUntil: "networkidle" });

    // ─── Step 2: Fill login form ─────────────────────────────────────────────
    // NOTE: Inspect the DEWA login page and update these selectors if they change
    logger.debug(`Filling in credentials...`);
    await page.fill('input[name="Username"]', USERNAME);
    await page.fill('input[name="Password"]', PASSWORD);

    // Click login button
    [navigation] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.click('button[type="submit"]')
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
    
    while (true) {
      period = await page.$eval('select:first-of-type', el => ({
        value: el.value,
        text: el.options[el.selectedIndex].text
      }));
      if (period.value == optionValue)
        break;
      logger.debug(`Selecting option: ${optionValue}`);
      [navigation] = await Promise.all([
        page.waitForFunction(() => new Promise(resolve => setTimeout(resolve, 0))),
        page.selectOption('select:first-of-type', { value: optionValue })
      ]);
    }
    
    electricity = await page.$eval('#gauge-component > form + div > div:nth-child(1)', el => ({ value: el.innerText.split(/\r\n|\r|\n/)[0], type: el.innerText.split(/\r\n|\r|\n/)[2]}));
    water = await page.$eval('#gauge-component > form + div > div:nth-child(2)', el => ({ value: el.innerText.split(/\r\n|\r|\n/)[0], type: el.innerText.split(/\r\n|\r|\n/)[2]}));

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
    const fs = require("fs");
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
    results = await scrapeDEWA();
    // Cleanup old screenshots and pages only on successful completion
    cleanupOldScreenshotsAndPages();
    console.log(results);
  } catch (error) {
    console.error('Scraping failed:', error.message);
    process.exit(1);
  }
})();


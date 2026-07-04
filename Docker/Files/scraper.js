if (process.env.PW_DEBUG_SCOPES) {
  process.env.DEBUG = process.env.PW_DEBUG_SCOPES;
}

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { format } = winston;

const url = process.env.TARGET_URL;
const selector = process.env.JQUERY_SELECTOR || 'body';
const waitUntil = process.env.WAIT_UNTIL || 'load';
const timeout = parseInt(process.env.TIMEOUT || '60');
const outputFormat = (process.env.OUTPUT_FORMAT || 'TEXT').toUpperCase();
const validFormats = new Set(['TEXT', 'HTML', 'ALL']);

const LOG_FILE_PATH = '/logs/miniscraper.log';
const consoleLevel = process.env.CONSOLE_LOG || 'warn';
const fileLevel = process.env.FILE_LOG || 'none';

const consoleTransport = new winston.transports.Console({
  silent: consoleLevel === 'none',
  level: consoleLevel === 'none' ? 'error' : consoleLevel,
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) =>
      `${timestamp} - ${level}: ${message}`
    )
  )
});

const transports = [consoleTransport];

if (fileLevel !== 'none') {
  if (fs.existsSync('/logs')) {
    transports.push(new winston.transports.File({
      filename: LOG_FILE_PATH,
      level: fileLevel,
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
    }));
  } else {
    console.warn('WARN: FILE_LOG is set but /logs directory does not exist; file logging disabled');
  }
}

const logger = winston.createLogger({ transports });

if (!url) {
  logger.error('ERROR: TARGET_URL environment variable is required');
  process.exit(1);
}

if (!validFormats.has(outputFormat)) {
  logger.error('ERROR: OUTPUT_FORMAT must be TEXT, HTML, or ALL');
  process.exit(1);
}

function requireParentDir(filePath, label) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    logger.error(`ERROR: ${label} parent directory '${dir}' does not exist`);
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
  logger.error(`ERROR: ${err.message}`);
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

function fetchText(srcUrl) {
  return new Promise((resolve, reject) => {
    https.get(srcUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  let browser;
  let context;
  let page;
  let tracingStarted = false;

  try {
    browser = await chromium.launch();

    const contextOptions = {};
    if (networkHarPath) {
      contextOptions.recordHar = { path: networkHarPath };
    }
    context = await browser.newContext(contextOptions);

    if (traceConfig) {
      await context.tracing.start(traceConfig.options);
      tracingStarted = true;
    }

    // Strip CSP headers — skip requests that may come in after context is disposed
    await context.route('**/*', async (route) => {
      try {
        const response = await route.fetch();
        const headers = response.headers();
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        await route.fulfill({ response, headers });
      } catch (e) {
        // Silently ignore requests that fire after context disposal
        route.abort().catch(() => {});
      }
    });

    const jquerySource = await fetchText('https://code.jquery.com/jquery-3.7.1.min.js');

    page = await context.newPage();
    await page.goto(url, { waitUntil, timeout: timeout * 1000 });

    // Inject jQuery after page load
    await page.evaluate((src) => {
      const script = document.createElement('script');
      script.textContent = src;
      document.head.appendChild(script);
      window.__jquery__ = jQuery.noConflict(true);
    }, jquerySource);

    const jqueryReady = await page.evaluate(() => typeof window.__jquery__ === 'function');
    if (!jqueryReady) {
      throw new Error('jQuery injection failed');
    }

    await page.evaluate(() => {
      window.$$ = function(selector, root = document) {
        const results = [...root.querySelectorAll(selector)];
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) {
            results.push(...window.$$(selector, el.shadowRoot));
          }
        });
        return window.__jquery__(results);
      };
    });

    // Debug: log what the selector actually matches
    const debug = await page.evaluate((sel) => {
      const $ = window.__jquery__;
      return {
        selectorUsed: sel,
        matchCount: $$(sel).length,
        pageTitle: document.title,
        // Sample of what's actually in the DOM to help refine selector
        h1s: $$('h1').map((_, el) => $(el).text().trim()).get(),
        h2s: $$('h2').map((_, el) => $(el).text().trim()).get(),
        bodySnippet: $$('body').text().trim().slice(0, 300)
      };
    }, selector);

    logger.debug(JSON.stringify(debug, null, 2));

    const result = await page.evaluate(({ sel, fmt }) => {
      const $ = window.__jquery__;
      const elements = $$(sel);
      if (elements.length === 0) {
        return [];
      }

      if (fmt === 'TEXT') {
        return elements.map((_, el) => $(el).text().trim()).get();
      }

      if (fmt === 'HTML') {
        return elements.map((_, el) => $(el).html()).get();
      }

      return elements.map((_, el) => ({
        text: $(el).text().trim(),
        html: $(el).html(),
        attrs: Array.from(el.attributes).reduce((acc, a) => {
          acc[a.name] = a.value;
          return acc;
        }, {})
      })).get();
    }, { sel: selector, fmt: outputFormat });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error(`Scraping failed: ${err.message}`);

    if (page) {
      try {
        await page.screenshot({ path: screenshotDumpPath, fullPage: true });
        logger.warn(`Screenshot saved to ${screenshotDumpPath}`);
      } catch (screenshotErr) {
        logger.warn(`Failed to save screenshot: ${screenshotErr.message}`);
      }

      try {
        const htmlContent = await page.content();
        fs.writeFileSync(pageDumpPath, htmlContent);
        logger.warn(`HTML content saved to ${pageDumpPath}`);
      } catch (htmlErr) {
        logger.warn(`Failed to save page HTML: ${htmlErr.message}`);
      }
    }

    console.error(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  } finally {
    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceConfig.path });
      } catch (traceErr) {
        logger.warn(`Failed to save trace: ${traceErr.message}`);
      }
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
})();

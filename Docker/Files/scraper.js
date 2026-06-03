const { chromium } = require('playwright');
const https = require('https');

const url = process.env.TARGET_URL;
const selector = process.env.JQUERY_SELECTOR || 'body';
const waitUntil = process.env.WAIT_UNTIL || 'load';
const timeout = parseInt(process.env.TIMEOUT || '60');
const outputFormat = (process.env.OUTPUT_FORMAT || 'TEXT').toUpperCase();
const validFormats = new Set(['TEXT', 'HTML', 'ALL']);

if (!url) {
  console.error('ERROR: TARGET_URL environment variable is required');
  process.exit(1);
}

if (!validFormats.has(outputFormat)) {
  console.error('ERROR: OUTPUT_FORMAT must be TEXT, HTML, or ALL');
  process.exit(1);
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
  const browser = await chromium.launch();
  const context = await browser.newContext();

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

  const page = await context.newPage();
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
    console.error('ERROR: jQuery injection failed');
    await browser.close();
    process.exit(1);
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

  console.error('DEBUG:', JSON.stringify(debug, null, 2));

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

  await browser.close();
})();

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
This container includes Winston and winston-daily-rotate-file for logging purposes.


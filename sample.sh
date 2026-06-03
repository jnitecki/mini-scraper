RESULT=$(podman run --rm --name mini-scraper \
  -e TARGET_URL="https://www.netgear.com/support/product/jgs516pe" \
  -e JQUERY_SELECTOR="div.firmware-latest strong" \
  -e WAIT_UNTIL="load" \
  -e OUTPUT_FORMAT="text" \
  -v $(PWD)/Docker/Files/scraper.js:/scraper/scraper-ignore.js \
  mini-scraper:latest)

echo $RESULT

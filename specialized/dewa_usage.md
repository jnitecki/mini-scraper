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
  -e FILE_LOG=info \
  docker.io/jnitecki/mini-scraper:latest \
  2>&1
```

## Environment Variables

- `DEWA_USER` - Your DEWA account email address
- `DEWA_PASS` - Your DEWA account password  
- `PERIOD` - The period to retrieve data for (default: 'CURRENT'). Can be 'CURRENT' or a date in yyyy-mm format (e.g., 2023-12)
- `CLEANUP_DAYS` - Number of days to retain logs, screenshots and page data in logs directory (default: 14). Set to 0 for indefinite retention.
- `CONSOLE_LOG` - Logging level for console output (default: 'warn'). Set to 'none' to disable console logging
- `FILE_LOG` - Logging level for file output (default: 'info')

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

- **Processing logs**: Stored as daily-rotated log files (e.g., `miniscraper-2026-06-16.log`)
- **Screenshots**: Saved as PNG files when errors occur (e.g., `screenshot_260616123414.png`)
- **HTML content**: Saved as HTML files when errors occur (e.g., `page_260616123414.html`)

These files are automatically generated and stored in the logs directory that is mounted to `/logs` inside the container.

## Troubleshooting

If the scraper fails:
1. Check that your credentials are correct
2. Verify the selectors in the code match the current website structure
3. The program will take screenshots on failure (`screenshoot_XXX.png`)

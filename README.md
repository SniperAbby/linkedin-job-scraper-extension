# LinkedIn Job Link Scraper (Chrome extension)

Walks LinkedIn's job search results (including pagination), clicks each job
into the detail sidebar, and collects:

- the LinkedIn job URL (`/jobs/view/<id>/`)
- whether it's Easy Apply or an external ("offsite") apply
- for offsite jobs, the real application URL — captured by clicking Apply,
  watching the tab it opens, grabbing that tab's final URL after redirects,
  and closing it automatically

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Pin the extension so its icon is visible in the toolbar

## Use

1. Go to `linkedin.com/jobs/search/...` with your search/filters applied
2. Click the extension icon
3. Adjust delays if you want (defaults are conservative on purpose — see
   "Rate limiting" below), and toggle "Capture external apply links" off if
   you only want the LinkedIn job links quickly
4. Click **Start**. Leave the tab open and in the foreground — don't switch
   away, since the scraper simulates real clicks on the page
5. Watch progress in the popup; **Stop** pauses (state persists), **Reset**
   clears collected results
6. **Export CSV** / **Export JSON** when done

Results persist in the extension's local storage as they're collected, so
closing the popup doesn't lose progress, and re-running Start continues
without re-scraping jobs already collected (dedup by job ID) — use Reset to
start clean.

## Rate limiting / ToS note

This automates clicks on your own logged-in session — it doesn't bypass
auth or hit any private API. That said, LinkedIn's terms restrict automated
scraping, and clicking through many jobs quickly can trigger rate limiting,
CAPTCHAs, or account flags. Keep delays reasonable, avoid running it for
hours unattended, and treat "Max pages" as a way to scrape in smaller
batches rather than pulling 99+ results in one run.

## If it stops finding jobs / apply buttons

LinkedIn periodically reshuffles its CSS class names. All selectors live at
the top of `content.js` in the `SELECTORS` object, each as an array of
fallback selectors tried in order. Open devtools on the jobs page, inspect
the element that broke, and add the new selector to the relevant array.
Console logs are prefixed `[LI Scraper]` — open the console on the LinkedIn
tab (not the popup) to see them.

## Files

- `manifest.json` — MV3 manifest
- `content.js` — scraping logic, injected on `linkedin.com/jobs/*`
- `background.js` — captures the URL of tabs opened by the Apply button
- `popup.html` / `popup.js` — controls, progress, CSV/JSON export

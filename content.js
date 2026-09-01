// LinkedIn Job Link Scraper — content script
//
// LinkedIn's job search page renders class names that get reshuffled
// periodically. Every selector below is tried as a fallback chain (first
// match wins) so a small markup change doesn't break the whole thing.
// If scraping stops finding cards/buttons, open devtools on the jobs page,
// inspect the element that broke, and add its selector to the matching
// array below. All scraper logs are prefixed "[LI Scraper]".

const SELECTORS = {
  jobCard: ["li[data-occludable-job-id]", "li.jobs-search-results__list-item", "div.job-card-container[data-job-id]"],
  jobCardClickTarget: [
    "a.job-card-container__link",
    "a.job-card-list__title",
    "div.job-card-container--clickable",
    "a[data-control-id]",
  ],
  jobTitle: [
    "h1.job-details-jobs-unified-top-card__job-title",
    ".job-details-jobs-unified-top-card__job-title h1",
    "h1.t-24",
    "h1",
  ],
  companyName: [
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name",
  ],
  location: [
    ".job-details-jobs-unified-top-card__primary-description-container",
    ".jobs-unified-top-card__primary-description",
    ".job-details-jobs-unified-top-card__tertiary-description-container",
  ],
  applyButton: [
    "button.jobs-apply-button",
    ".jobs-apply-button--top-card button",
    "div.jobs-apply-button--top-card button",
  ],
  nextPageButton: [
    'button[aria-label="View next page"]',
    "button.jobs-search-pagination__button--next",
    ".jobs-search-pagination__button--next",
  ],
  scrollableList: [
    "div.scaffold-layout__list > div",
    "div.jobs-search-results-list",
    "div.scaffold-layout__list",
  ],
};

const log = (...args) => console.debug("[LI Scraper]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstMatch(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function allMatches(root, selectors) {
  for (const sel of selectors) {
    const els = root.querySelectorAll(sel);
    if (els.length) return Array.from(els);
  }
  return [];
}

function getJobCards() {
  return allMatches(document, SELECTORS.jobCard);
}

function getJobIdFromCard(card) {
  const direct = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id");
  if (direct) return direct.trim();
  const nested = card.querySelector("[data-job-id]");
  if (nested) return nested.getAttribute("data-job-id").trim();
  const link = card.querySelector("a[href*='/jobs/view/']");
  if (link) {
    const m = link.getAttribute("href").match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

async function autoScrollList() {
  const container = firstMatch(document, SELECTORS.scrollableList) || document.scrollingElement;
  if (!container) return;
  let lastCount = -1;
  let stableRounds = 0;
  for (let i = 0; i < 60 && stableRounds < 3; i++) {
    container.scrollTop = container.scrollHeight;
    await sleep(400);
    const count = getJobCards().length;
    if (count === lastCount) stableRounds++;
    else stableRounds = 0;
    lastCount = count;
  }
}

function clickCard(card) {
  const target = firstMatch(card, SELECTORS.jobCardClickTarget) || card;
  target.click();
}

async function waitForDetailPane(jobId, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = new URLSearchParams(location.search).get("currentJobId");
    if (current === String(jobId)) {
      await sleep(400); // let the pane finish rendering
      return true;
    }
    await sleep(150);
  }
  return false;
}

function textOf(root, selectors) {
  const el = firstMatch(root, selectors);
  return el ? el.textContent.trim().replace(/\s+/g, " ") : "";
}

function classifyApplyButton(btn) {
  if (!btn) return "unknown";
  const label = (btn.getAttribute("aria-label") || btn.textContent || "").toLowerCase();
  if (label.includes("easy apply")) return "easy_apply";
  if (label.includes("apply")) return "offsite";
  return "unknown";
}

function captureApplyLink(button, timeoutMs = 12000) {
  return new Promise(async (resolve) => {
    let done = false;
    const listener = (msg) => {
      if (msg.type === "APPLY_URL_CAPTURED" && !done) {
        done = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.ok ? msg.url : null);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      await chrome.runtime.sendMessage({ type: "ARM_APPLY_CAPTURE", timeoutMs });
    } catch (e) {
      log("failed to arm apply capture", e);
    }
    button.click();
    setTimeout(() => {
      if (!done) {
        done = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
      }
    }, timeoutMs + 1000);
  });
}

function extractJobInfo(jobId) {
  const title = textOf(document, SELECTORS.jobTitle);
  const company = textOf(document, SELECTORS.companyName);
  const location = textOf(document, SELECTORS.location);
  const applyButton = firstMatch(document, SELECTORS.applyButton);
  return {
    jobId,
    title,
    company,
    location,
    jobUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
    applyType: classifyApplyButton(applyButton),
    applyUrl: null,
    _applyButton: applyButton,
  };
}

function getNextPageButton() {
  const btn = firstMatch(document, SELECTORS.nextPageButton);
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
  return btn;
}

let running = false;
let seenIds = new Set();
let results = [];

async function persist() {
  await chrome.storage.local.set({
    liScraperResults: results,
    liScraperStatus: running ? "running" : "stopped",
    liScraperUpdatedAt: Date.now(),
  });
}

async function runScrape(options) {
  running = true;
  seenIds = new Set((await chrome.storage.local.get("liScraperSeenIds")).liScraperSeenIds || []);
  results = (await chrome.storage.local.get("liScraperResults")).liScraperResults || [];
  for (const r of results) seenIds.add(r.jobId);
  await persist();

  let pageIndex = 0;
  while (running) {
    pageIndex++;
    log(`page ${pageIndex}: loading list`);
    await autoScrollList();
    const cards = getJobCards();
    log(`page ${pageIndex}: ${cards.length} cards found`);

    for (const card of cards) {
      if (!running) break;
      const jobId = getJobIdFromCard(card);
      if (!jobId || seenIds.has(jobId)) continue;
      seenIds.add(jobId);

      try {
        clickCard(card);
        const ok = await waitForDetailPane(jobId);
        if (!ok) {
          log(`job ${jobId}: detail pane did not update in time, skipping details`);
        }
        await sleep(options.clickDelayMs);

        const info = extractJobInfo(jobId);
        const applyButton = info._applyButton;
        delete info._applyButton;

        if (options.captureApplyLinks && info.applyType === "offsite" && applyButton) {
          info.applyUrl = await captureApplyLink(applyButton);
        }

        results.push(info);
        await chrome.storage.local.set({ liScraperSeenIds: Array.from(seenIds) });
        await persist();
      } catch (e) {
        log("error scraping card", jobId, e);
      }

      await sleep(options.betweenJobsDelayMs);
    }

    if (!running) break;
    if (options.maxPages && pageIndex >= options.maxPages) {
      log("reached maxPages limit, stopping");
      break;
    }

    const nextBtn = getNextPageButton();
    if (!nextBtn) {
      log("no next page button found, done");
      break;
    }
    nextBtn.click();
    await sleep(options.betweenPagesDelayMs);
  }

  running = false;
  await persist();
  log("scrape finished, total results:", results.length);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_SCRAPE") {
    if (running) {
      sendResponse({ ok: false, error: "already running" });
      return false;
    }
    runScrape(msg.options || {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "STOP_SCRAPE") {
    running = false;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "RESET_RESULTS") {
    results = [];
    seenIds = new Set();
    chrome.storage.local.set({ liScraperResults: [], liScraperSeenIds: [], liScraperStatus: "stopped" });
    sendResponse({ ok: true });
    return false;
  }
});

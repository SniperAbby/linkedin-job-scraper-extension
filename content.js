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

const log = (...args) => console.log("[LI Scraper]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Logs how many elements each candidate selector matches, so a stale
// selector shows up immediately instead of silently returning nothing.
function debugSelectors() {
  log("--- selector diagnostics ---");
  for (const [name, list] of Object.entries(SELECTORS)) {
    for (const sel of list) {
      let count = -1;
      try {
        count = document.querySelectorAll(sel).length;
      } catch (e) {
        count = `ERROR: ${e.message}`;
      }
      log(`  ${name}: "${sel}" -> ${count}`);
    }
  }
  log("--- end diagnostics ---");
}

// Walks light DOM plus any open shadow roots, so text-based lookups still
// work if LinkedIn moves a widget (e.g. the apply button) into a web
// component's shadow DOM, which plain querySelector cannot see into.
function deepQueryAll(predicate, root = document.documentElement) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 1 && predicate(node)) found.push(node);
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) walk(child);
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return found;
}

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
  const known = allMatches(document, SELECTORS.jobCard);
  if (known.length) return known;

  // Fallback: LinkedIn's CSS classes get reshuffled but the URL pattern for
  // a job link (/jobs/view/<id>) is stable, so derive cards from those links
  // instead of relying on exact class names. Scope to the list container
  // when we can find it, so we don't also pick up "similar jobs" links that
  // live inside the detail pane on the right.
  const container = firstMatch(document, SELECTORS.scrollableList) || document;
  const links = Array.from(container.querySelectorAll('a[href*="/jobs/view/"]'));
  const seen = new Set();
  const derived = [];
  for (const link of links) {
    const li = link.closest("li") || link.parentElement;
    if (li && !seen.has(li)) {
      seen.add(li);
      derived.push(li);
    }
  }
  return derived;
}

// Title/company/location are read straight off the list card rather than the
// detail pane — the list is reliably in light DOM (proven by getJobCards'
// fallback working), whereas the detail pane's markup/structure has been
// unreliable to target with fixed selectors.
function extractListInfo(card) {
  const linkEl = firstMatch(card, SELECTORS.jobCardClickTarget) || card.querySelector('a[href*="/jobs/view/"]');
  let title = linkEl ? linkEl.textContent.trim().replace(/\s+/g, " ") : "";

  const lines = (card.innerText || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!title && lines.length) title = lines[0];
  const rest = lines.filter((l) => l && l !== title);
  const company = rest[0] || "";
  const location = rest[1] || "";
  return { title, company, location };
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

function labelOf(el) {
  return (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
}

// Finds the Apply control anywhere in the document (including shadow DOM)
// and classifies it. Easy Apply applies inside LinkedIn itself (no external
// link); "offsite" opens/redirects to the employer's own application page.
function findApplyButtonAndType() {
  const known = firstMatch(document, SELECTORS.applyButton);
  if (known) {
    const label = labelOf(known);
    return { button: known, type: label.includes("easy apply") ? "easy_apply" : "offsite" };
  }
  const candidates = deepQueryAll(
    (el) => (el.tagName === "BUTTON" || el.tagName === "A") && /apply/.test(labelOf(el))
  );
  const button = candidates.find((el) => el.offsetParent !== null) || candidates[0] || null;
  if (!button) return { button: null, type: "unknown" };
  return { button, type: labelOf(button).includes("easy apply") ? "easy_apply" : "offsite" };
}

// LinkedIn shows a "you're leaving LinkedIn" confirmation dialog before
// sending you to an offsite application; the real destination lives on its
// Continue control.
async function waitForModal(timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const modal =
      document.querySelector('[role="dialog"]') ||
      document.querySelector(".artdeco-modal") ||
      deepQueryAll((el) => el.getAttribute && el.getAttribute("role") === "dialog")[0];
    if (modal) return modal;
    await sleep(150);
  }
  return null;
}

function findContinueButton(modal) {
  const candidates = deepQueryAll(
    (el) => (el.tagName === "BUTTON" || el.tagName === "A") && /continue/.test(labelOf(el)),
    modal
  );
  return candidates[0] || null;
}

function closeModal(modal) {
  const closeBtn = deepQueryAll(
    (el) => el.tagName === "BUTTON" && /dismiss|close/.test(labelOf(el)),
    modal
  )[0];
  if (closeBtn) closeBtn.click();
}

function armApplyCapture(timeoutMs) {
  let resolveFn;
  let done = false;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  const listener = (msg) => {
    if (msg.type === "APPLY_URL_CAPTURED" && !done) {
      done = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolveFn(msg.ok ? msg.url : null);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolveFn(null);
    }
  }, timeoutMs + 1000);
  return {
    promise,
    cancel: () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
      }
    },
  };
}

async function captureApplyLink(button, timeoutMs = 12000) {
  const capture = armApplyCapture(timeoutMs);
  try {
    await chrome.runtime.sendMessage({ type: "ARM_APPLY_CAPTURE", timeoutMs });
  } catch (e) {
    log("failed to arm apply capture", e);
  }
  button.click();

  const modal = await waitForModal(3000);
  if (modal) {
    const continueBtn = findContinueButton(modal);
    if (continueBtn) {
      const href = continueBtn.tagName === "A" ? continueBtn.getAttribute("href") : null;
      if (href && /^https?:\/\//.test(href)) {
        capture.cancel();
        closeModal(modal);
        return href;
      }
      continueBtn.click();
    } else {
      log("apply modal appeared but no Continue control found");
    }
  }

  return await capture.promise;
}

function extractJobInfo(jobId, listInfo) {
  const detailTitle = textOf(document, SELECTORS.jobTitle);
  const detailCompany = textOf(document, SELECTORS.companyName);
  const detailLocation = textOf(document, SELECTORS.location);
  const { button, type } = findApplyButtonAndType();
  return {
    jobId,
    title: detailTitle || listInfo.title,
    company: detailCompany || listInfo.company,
    location: detailLocation || listInfo.location,
    jobUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
    applyType: type,
    applyUrl: null,
    _applyButton: button,
  };
}

function getNextPageButton() {
  let btn = firstMatch(document, SELECTORS.nextPageButton);
  if (!btn) {
    // Fallback: any clickable element whose accessible label mentions "next".
    btn =
      Array.from(document.querySelectorAll("button, a")).find((el) => {
        const label = (el.getAttribute("aria-label") || el.textContent || "").toLowerCase();
        return label.includes("next") && !label.includes("nextgen");
      }) || null;
  }
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
  return btn;
}

log("content script loaded on", location.href);

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

  debugSelectors();

  let pageIndex = 0;
  while (running) {
    pageIndex++;
    log(`page ${pageIndex}: loading list`);
    await autoScrollList();
    const cards = getJobCards();
    log(`page ${pageIndex}: ${cards.length} cards found`);

    const nextBtnPreview = getNextPageButton();
    await chrome.storage.local.set({
      liScraperDiagnostics: {
        pageIndex,
        url: location.href,
        listContainerFound: !!firstMatch(document, SELECTORS.scrollableList),
        cardsFound: cards.length,
        nextButtonFound: !!nextBtnPreview,
        updatedAt: Date.now(),
      },
    });

    for (const card of cards) {
      if (!running) break;
      const jobId = getJobIdFromCard(card);
      if (!jobId || seenIds.has(jobId)) continue;
      seenIds.add(jobId);

      try {
        const listInfo = extractListInfo(card);
        clickCard(card);
        const ok = await waitForDetailPane(jobId);
        if (!ok) {
          log(`job ${jobId}: detail pane did not update in time, skipping details`);
        }
        await sleep(options.clickDelayMs);

        const info = extractJobInfo(jobId, listInfo);
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

// LinkedIn Job Link Scraper — content script
//
// LinkedIn's job search page renders class names that get reshuffled
// periodically. Every selector below is tried as a fallback chain (first
// match wins) so a small markup change doesn't break the whole thing.
// If scraping stops finding cards/buttons, open devtools on the jobs page,
// inspect the element that broke, and add its selector to the matching
// array below. All scraper logs are prefixed "[LI Scraper]".

const SELECTORS = {
  // Confirmed from a live DOM dump: each card is a role="button" div whose
  // componentkey embeds the numeric job id directly — no <a href> involved.
  jobCard: [
    'div[componentkey^="job-card-component-ref-"]',
    "li[data-occludable-job-id]",
    "li.jobs-search-results__list-item",
    "div.job-card-container[data-job-id]",
  ],
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
  // data-testid is a stable QA hook LinkedIn uses regardless of CSS build —
  // far more reliable than the hashed class names on the same buttons.
  nextPageButton: ['button[data-testid="pagination-controls-next-button-visible"]'],
  nextPageButtonHidden: ['button[data-testid="pagination-controls-next-button-hidden"]'],
  scrollableList: [
    'div[data-testid="lazy-column"]',
    'div[data-component-type="LazyColumn"]',
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

// Finds the actual scrolling element by walking up from a node and checking
// real computed overflow/scroll-height, instead of guessing LinkedIn's
// (frequently reshuffled) class names. This is what lets us reliably find
// the sidebar job list's own scroll container regardless of its classes.
function findScrollableAncestor(el) {
  let node = el;
  let depth = 0;
  while (node && depth < 15) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 10
    ) {
      return node;
    }
    node = node.parentElement;
    depth++;
  }
  return null;
}

function getAllJobViewLinks(root = document) {
  return Array.from(root.querySelectorAll('a[href*="/jobs/view/"]'));
}

// Resolves the sidebar list's scroll container: known selectors first, then
// the real scrollable ancestor of the first job link found in the page
// (the sidebar list precedes the detail pane in DOM order).
function getListContainer() {
  const known = firstMatch(document, SELECTORS.scrollableList);
  if (known) {
    // The known container might itself scroll, or might just wrap the real
    // scrolling element — walk up from something inside it to find whichever
    // ancestor actually has the overflow, preferring that for scrollTop
    // assignment while still using `known` for scoping card lookups.
    const sample = known.querySelector('div[componentkey^="job-card-component-ref-"]') || known.firstElementChild;
    if (sample) {
      const scrollable = findScrollableAncestor(sample);
      if (scrollable && known.contains(scrollable)) return scrollable;
    }
    return known;
  }
  const links = getAllJobViewLinks();
  if (!links.length) return null;
  return findScrollableAncestor(links[0]);
}

function getJobCards() {
  const known = allMatches(document, SELECTORS.jobCard);
  if (known.length) return known;

  // Fallback: LinkedIn's CSS classes get reshuffled but the URL pattern for
  // a job link (/jobs/view/<id>) is stable, so derive cards from those links
  // instead of relying on exact class names. Scope to the list container
  // when we can find it, so we don't also pick up "similar jobs" links that
  // live inside the detail pane on the right.
  const container = getListContainer() || document;
  const links = getAllJobViewLinks(container);
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

// A <p> sometimes carries two child spans for accessibility: one plain
// (occasionally empty) and one span[aria-hidden="true"] holding the actual
// visible text plus a decorative icon span. Reading textContent off the
// whole <p> would double up or catch stray icon text, so prefer the
// aria-hidden span's own text when present.
function cleanPText(p) {
  if (!p) return "";
  const hidden = p.querySelector('span[aria-hidden="true"]');
  const text = (hidden || p).textContent || "";
  return text.trim().replace(/\s+/g, " ");
}

// Title/company/location are read straight off the list card rather than the
// detail pane — confirmed from a live DOM dump: the card's first three <p>
// elements are always title, then company, then location, appearing before
// any footer/benefits text.
function extractListInfo(card) {
  const ps = Array.from(card.querySelectorAll("p"));
  const title = cleanPText(ps[0]);
  const company = cleanPText(ps[1]);
  const location = cleanPText(ps[2]);
  // Confirmed in the DOM dump: Easy Apply jobs show a literal "Easy Apply"
  // <p> in the card's footer — no need to open the detail pane to know this.
  const isEasyApply = /\bEasy Apply\b/.test(card.innerText || "");
  return { title, company, location, isEasyApply };
}

function getJobIdFromCard(card) {
  const componentKey = card.getAttribute("componentkey") || "";
  const fromKey = componentKey.match(/job-card-component-ref-(\d+)/);
  if (fromKey) return fromKey[1];
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
  const container = getListContainer() || document.scrollingElement;
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

// Belt-and-suspenders: close whatever modal/dialog is currently open. Used
// unconditionally after every apply attempt — an unclosed "leaving LinkedIn"
// modal sits on top of the page and blocks every subsequent job card click,
// which is why only one job per page was getting scraped.
// LinkedIn routes offsite applies through its own "leaving LinkedIn" warning
// page (linkedin.com/safety/go/?url=<encoded real destination>) — sometimes
// that's the URL we end up capturing (as an href, or as the tab's landing
// page if it doesn't auto-continue). The real employer URL is just the
// decoded `url` query param, so unwrap it rather than exporting the
// LinkedIn wrapper link.
function unwrapLinkedInRedirect(rawUrl) {
  let url = rawUrl;
  for (let i = 0; i < 3 && url; i++) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      break;
    }
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) break;
    const target = u.searchParams.get("url");
    if (!target) break;
    try {
      url = decodeURIComponent(target);
    } catch (e) {
      url = target;
    }
  }
  return url;
}

function closeAnyOpenModal() {
  const modal = document.querySelector('[role="dialog"]') || document.querySelector(".artdeco-modal");
  if (modal) closeModal(modal);
}

async function captureApplyLink(button, timeoutMs = 12000) {
  // Some offsite jobs render Apply itself as a real <a href="..."> straight
  // to the employer's application page — no click or modal needed at all.
  if (button.tagName === "A") {
    const href = button.getAttribute("href");
    if (href && /^https?:\/\//.test(href)) {
      return href;
    }
  }

  const capture = armApplyCapture(timeoutMs);
  let modal = null;
  try {
    try {
      await chrome.runtime.sendMessage({ type: "ARM_APPLY_CAPTURE", timeoutMs });
    } catch (e) {
      log("failed to arm apply capture", e);
    }
    button.click();

    modal = await waitForModal(3000);
    if (modal) {
      const continueBtn = findContinueButton(modal);
      if (continueBtn) {
        const href = continueBtn.tagName === "A" ? continueBtn.getAttribute("href") : null;
        if (href && /^https?:\/\//.test(href)) {
          capture.cancel();
          return href;
        }
        continueBtn.click();
      } else {
        log("apply modal appeared but no Continue control found");
      }
    }

    return await capture.promise;
  } finally {
    // Always run, whichever branch returned: close the modal that opened
    // (if any) and sweep for any dialog left open so the next card isn't blocked.
    if (modal) closeModal(modal);
    await sleep(200);
    closeAnyOpenModal();
  }
}

function extractJobInfo(jobId, listInfo) {
  const detailTitle = textOf(document, SELECTORS.jobTitle);
  const detailCompany = textOf(document, SELECTORS.companyName);
  const detailLocation = textOf(document, SELECTORS.location);
  // The list card's own "Easy Apply" text is the reliable signal (confirmed
  // in a live DOM dump); the detail-pane button search is only needed to
  // locate the actual clickable control for offsite jobs.
  const applyType = listInfo.isEasyApply ? "easy_apply" : "offsite";
  const button = applyType === "offsite" ? findApplyButtonAndType().button : null;
  return {
    jobId,
    title: detailTitle || listInfo.title,
    company: detailCompany || listInfo.company,
    location: detailLocation || listInfo.location,
    jobUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
    applyType,
    applyUrl: null,
    _applyButton: button,
  };
}

function getNextPageButton() {
  // Confirmed from a live DOM dump: the visible/hidden next-page button uses
  // a stable data-testid regardless of CSS build. The "-hidden" variant
  // means there genuinely is no next page (last page reached).
  const visible = firstMatch(document, SELECTORS.nextPageButton);
  if (visible) {
    if (visible.disabled || visible.getAttribute("aria-disabled") === "true") return null;
    return visible;
  }
  if (firstMatch(document, SELECTORS.nextPageButtonHidden)) return null;

  // Fallback: a clickable element labeled "next" that's actually inside a
  // pagination-looking control. Matching "next" anywhere on the page is
  // dangerous — LinkedIn has other "Next" buttons (carousels, tours,
  // "similar jobs" widgets) that aren't the job-list pagination at all,
  // and clicking those instead silently derails the whole scrape.
  const btn =
    Array.from(document.querySelectorAll("button, a")).find((el) => {
      const label = labelOf(el);
      if (!/\bnext\b/.test(label) || label.includes("nextgen")) return false;
      return !!el.closest('[class*="pagination" i], nav[aria-label*="pagination" i]');
    }) || null;
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
  return btn;
}

log("content script loaded on", location.href);

let running = false;
let seenIds = new Set();
let results = [];
let cardLog = [];

async function logCardEvent(entry) {
  cardLog.push({ ...entry, t: Date.now() });
  if (cardLog.length > 20) cardLog = cardLog.slice(-20);
  await chrome.storage.local.set({ liScraperCardLog: cardLog });
}

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
    const idPreview = cards.map((c) => getJobIdFromCard(c));
    await chrome.storage.local.set({
      liScraperDiagnostics: {
        pageIndex,
        url: location.href,
        listContainerFound: !!getListContainer(),
        cardsFound: cards.length,
        idPreview,
        nextButtonFound: !!nextBtnPreview,
        updatedAt: Date.now(),
      },
    });

    for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
      const card = cards[cardIndex];
      if (!running) break;
      const jobId = getJobIdFromCard(card);
      if (!jobId) {
        await logCardEvent({ cardIndex, jobId: null, action: "skip-no-id" });
        continue;
      }
      if (seenIds.has(jobId)) {
        await logCardEvent({ cardIndex, jobId, action: "skip-duplicate" });
        continue;
      }
      seenIds.add(jobId);

      try {
        const listInfo = extractListInfo(card);

        // The list card's own "Easy Apply" text tells us this without ever
        // opening the detail pane — skip the click entirely for speed.
        if (options.skipEasyApply && listInfo.isEasyApply) {
          await logCardEvent({ cardIndex, jobId, action: "skip-easy-apply" });
          await sleep(options.betweenJobsDelayMs);
          continue;
        }

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
          const rawApplyUrl = await captureApplyLink(applyButton);
          info.applyUrl = rawApplyUrl ? unwrapLinkedInRedirect(rawApplyUrl) : rawApplyUrl;
        }

        results.push(info);
        await chrome.storage.local.set({ liScraperSeenIds: Array.from(seenIds) });
        await persist();
        await logCardEvent({ cardIndex, jobId, action: "processed", applyType: info.applyType });
      } catch (e) {
        log("error scraping card", jobId, e);
        await logCardEvent({ cardIndex, jobId, action: "error", error: String(e && e.message ? e.message : e) });
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
    cardLog = [];
    chrome.storage.local.set({
      liScraperResults: [],
      liScraperSeenIds: [],
      liScraperStatus: "stopped",
      liScraperCardLog: [],
      liScraperDiagnostics: null,
    });
    sendResponse({ ok: true });
    return false;
  }
});

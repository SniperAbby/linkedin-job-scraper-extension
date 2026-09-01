// Watches for the tab that LinkedIn's "Apply" button opens, waits for it to
// settle (LinkedIn routes external applies through a tracking redirect first),
// captures the final URL, then closes the tab so we don't litter the user's
// browser with dozens of ATS tabs.

let armed = null; // { linkedinTabId, newTabId, timer, onCreated, onUpdated }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ARM_APPLY_CAPTURE") {
    arm(sender.tab.id, msg.timeoutMs || 12000);
    sendResponse({ armed: true });
    return false;
  }
});

function arm(linkedinTabId, timeoutMs) {
  disarm();

  const state = {
    linkedinTabId,
    newTabId: null,
  };

  const finish = (result) => {
    if (armed !== state) return;
    clearTimeout(state.timer);
    clearTimeout(state.settleTimer);
    chrome.tabs.onCreated.removeListener(state.onCreated);
    chrome.tabs.onUpdated.removeListener(state.onUpdated);
    if (state.newTabId != null) {
      chrome.tabs.remove(state.newTabId).catch(() => {});
    }
    armed = null;
    chrome.tabs
      .sendMessage(linkedinTabId, { type: "APPLY_URL_CAPTURED", ...result })
      .catch(() => {});
  };

  state.onCreated = (tab) => {
    if (armed === state && tab.openerTabId === linkedinTabId) {
      state.newTabId = tab.id;
    }
  };

  // Some apply flows hop through more than one redirect (LinkedIn tracking
  // link -> ATS login/redirect -> final posting), each firing its own
  // "complete" status. Debounce: every "complete" event (re)starts a settle
  // timer, and we only read the URL once nothing has changed for a bit —
  // finalizing on the first "complete" was grabbing an intermediate hop.
  state.onUpdated = (tabId, changeInfo, tab) => {
    if (armed !== state || tabId !== state.newTabId) return;
    if (changeInfo.status === "complete" && tab.url && tab.url !== "about:blank") {
      clearTimeout(state.settleTimer);
      state.settleTimer = setTimeout(async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          finish({ ok: true, url: t.url });
        } catch {
          finish({ ok: true, url: tab.url });
        }
      }, 1800);
    }
  };

  state.timer = setTimeout(() => {
    finish({ ok: false, error: "timeout waiting for apply tab" });
  }, timeoutMs);

  chrome.tabs.onCreated.addListener(state.onCreated);
  chrome.tabs.onUpdated.addListener(state.onUpdated);
  armed = state;
}

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  clearTimeout(armed.settleTimer);
  chrome.tabs.onCreated.removeListener(armed.onCreated);
  chrome.tabs.onUpdated.removeListener(armed.onUpdated);
  armed = null;
}

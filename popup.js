const statusEl = document.getElementById("status");

async function getActiveLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("linkedin.com/jobs")) {
    throw new Error("Open a linkedin.com/jobs search results page first.");
  }
  return tab;
}

function readOptions() {
  return {
    captureApplyLinks: document.getElementById("captureApplyLinks").checked,
    maxPages: Number(document.getElementById("maxPages").value) || 0,
    clickDelayMs: Number(document.getElementById("clickDelayMs").value) || 800,
    betweenJobsDelayMs: Number(document.getElementById("betweenJobsDelayMs").value) || 600,
    betweenPagesDelayMs: Number(document.getElementById("betweenPagesDelayMs").value) || 1500,
  };
}

async function refreshStatus() {
  const data = await chrome.storage.local.get(["liScraperResults", "liScraperStatus"]);
  const results = data.liScraperResults || [];
  const status = data.liScraperStatus || "stopped";
  const easyApply = results.filter((r) => r.applyType === "easy_apply").length;
  const offsite = results.filter((r) => r.applyType === "offsite").length;
  const offsiteWithLink = results.filter((r) => r.applyType === "offsite" && r.applyUrl).length;
  statusEl.textContent =
    `Status: ${status}\n` +
    `Collected: ${results.length}\n` +
    `Easy Apply: ${easyApply}\n` +
    `Offsite: ${offsite} (${offsiteWithLink} with captured link)`;
}

document.getElementById("startBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveLinkedInTab();
    const options = readOptions();
    await chrome.tabs.sendMessage(tab.id, { type: "START_SCRAPE", options });
    statusEl.textContent = "Started...";
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
  }
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveLinkedInTab();
    await chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPE" });
    statusEl.textContent = "Stopping...";
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveLinkedInTab();
    await chrome.tabs.sendMessage(tab.id, { type: "RESET_RESULTS" });
    await refreshStatus();
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
  }
});

function toCsvValue(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById("exportCsvBtn").addEventListener("click", async () => {
  const data = await chrome.storage.local.get("liScraperResults");
  const results = data.liScraperResults || [];
  const header = ["Title", "Company", "Location", "Job URL", "Apply Type", "Apply URL"];
  const rows = results.map((r) =>
    [r.title, r.company, r.location, r.jobUrl, r.applyType, r.applyUrl || ""].map(toCsvValue).join(",")
  );
  const csv = [header.join(","), ...rows].join("\n");
  downloadBlob(csv, `linkedin-jobs-${Date.now()}.csv`, "text/csv");
});

document.getElementById("exportJsonBtn").addEventListener("click", async () => {
  const data = await chrome.storage.local.get("liScraperResults");
  const results = data.liScraperResults || [];
  downloadBlob(JSON.stringify(results, null, 2), `linkedin-jobs-${Date.now()}.json`, "application/json");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.liScraperResults || changes.liScraperStatus)) {
    refreshStatus();
  }
});

refreshStatus();

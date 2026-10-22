"use strict";

const SNAPSHOT_KEY = "storagePorter.snapshot.v1";
const PREFS_KEY = "storagePorter.prefs.v1";
const MAX_RENDER_ITEMS = 250;
const MAX_PREVIEW_CHARS = 5000;

const ACCESS = {
  LOADING: "loading",
  READY: "ready",
  BLOCKED: "blocked",
};

const els = {};
const state = {
  tab: null,
  siteInfo: null,
  access: ACCESS.LOADING,
  isRefreshing: false,
  busy: null,
  snapshot: null,
  activeStore: "localStorage",
  prefs: { clearFirst: false },
  scanId: 0,
  toastTimer: null,
};

const textEncoder = new TextEncoder();
const avatarPalettes = [
  ["#6366f1", "#4338ca"],
  ["#0891b2", "#0e7490"],
  ["#f59e0b", "#b45309"],
  ["#10b981", "#047857"],
  ["#ec4899", "#be185d"],
  ["#8b5cf6", "#6d28d9"],
];

function init() {
  cacheElements();
  bindEvents();

  try {
    els.versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    els.versionLabel.textContent = "v1.0.0";
  }

  setAccess(ACCESS.LOADING);
  syncUi();

  void (async () => {
    await Promise.allSettled([loadStoredState(), refreshCurrent({ initial: true })]);
  })();
}

function cacheElements() {
  const ids = [
    "accessBadge",
    "actionHint",
    "clearFirst",
    "copyBtn",
    "emptyState",
    "localCount",
    "localTab",
    "localTabCount",
    "pasteBtn",
    "pasteTarget",
    "refreshBtn",
    "sessionCount",
    "sessionTab",
    "sessionTabCount",
    "siteAvatar",
    "siteHost",
    "siteNotice",
    "siteTitle",
    "snapshotCard",
    "snapshotHost",
    "snapshotSize",
    "snapshotTime",
    "storageList",
    "toast",
    "toastIcon",
    "toastText",
    "versionLabel",
  ];

  for (const id of ids) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  els.copyBtn.addEventListener("click", () => {
    void handleCopy();
  });

  els.pasteBtn.addEventListener("click", () => {
    void handlePaste();
  });

  els.refreshBtn.addEventListener("click", () => {
    if (!state.busy && !state.isRefreshing) {
      void refreshCurrent({ manual: true });
    }
  });

  els.localTab.addEventListener("click", () => selectStore("localStorage"));
  els.sessionTab.addEventListener("click", () => selectStore("sessionStorage"));

  els.localTab.addEventListener("keydown", handleTabKeydown);
  els.sessionTab.addEventListener("keydown", handleTabKeydown);

  els.clearFirst.addEventListener("change", () => {
    state.prefs = { ...state.prefs, clearFirst: els.clearFirst.checked };
    syncUi();
    void savePrefs();
  });
}

/* ---------- Stored state ---------- */

async function loadStoredState() {
  try {
    const stored = await chrome.storage.local.get([SNAPSHOT_KEY, PREFS_KEY]);
    state.prefs = normalizePrefs(stored[PREFS_KEY]);
    state.snapshot = normalizeSnapshot(stored[SNAPSHOT_KEY]);

    if (
      state.snapshot &&
      state.snapshot.localStorage.length === 0 &&
      state.snapshot.sessionStorage.length > 0
    ) {
      state.activeStore = "sessionStorage";
    }

    els.clearFirst.checked = state.prefs.clearFirst;
    renderSnapshot();
  } catch (error) {
    showToast(`读取暂存数据失败：${friendlyError(error)}`, "error", 4200);
  } finally {
    syncUi();
  }
}

async function savePrefs() {
  try {
    await chrome.storage.local.set({ [PREFS_KEY]: state.prefs });
  } catch {
    // A failed preference write should never block the main workflow.
  }
}

function normalizePrefs(raw) {
  return { clearFirst: Boolean(raw && raw.clearFirst) };
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1) {
    return null;
  }

  const localStorageItems = normalizeItems(raw.localStorage);
  const sessionStorageItems = normalizeItems(raw.sessionStorage);
  const source = raw.source && typeof raw.source === "object" ? raw.source : {};
  const errors = raw.errors && typeof raw.errors === "object" ? raw.errors : {};

  if (localStorageItems.length === 0 && sessionStorageItems.length === 0) {
    return null;
  }

  const snapshot = {
    schema: 1,
    copiedAt: Number.isFinite(Number(raw.copiedAt)) ? Number(raw.copiedAt) : Date.now(),
    source: {
      url: String(source.url || ""),
      origin: String(source.origin || ""),
      host: String(source.host || "未知站点"),
      title: String(source.title || ""),
    },
    localStorage: localStorageItems,
    sessionStorage: sessionStorageItems,
    errors: {
      localStorage: errors.localStorage ? String(errors.localStorage) : null,
      sessionStorage: errors.sessionStorage ? String(errors.sessionStorage) : null,
    },
  };

  snapshot.sizeBytes = Number.isFinite(Number(raw.sizeBytes))
    ? Number(raw.sizeBytes)
    : calculateSnapshotSize(snapshot);

  return snapshot;
}

function normalizeItems(raw) {
  if (!raw) {
    return [];
  }

  let pairs;
  if (Array.isArray(raw)) {
    pairs = raw.map((item) => [item && item.key, item && item.value]);
  } else if (typeof raw === "object") {
    pairs = Object.entries(raw);
  } else {
    return [];
  }

  const items = [];
  for (const [key, value] of pairs) {
    if (key === undefined || key === null) {
      continue;
    }
    items.push({
      key: String(key),
      value: value === undefined || value === null ? "" : String(value),
    });
  }
  return items;
}

/* ---------- Current tab ---------- */

async function refreshCurrent({ manual = false, initial = false } = {}) {
  const scanId = ++state.scanId;
  state.isRefreshing = true;
  hideSiteNotice();
  setAccess(ACCESS.LOADING);
  setCounts(null, null);
  syncUi();

  try {
    const tab = await queryActiveTab();
    const url = tab.url || tab.pendingUrl || "";
    state.tab = tab;
    setSiteIdentity(url, tab.title);

    const blocked = blockedReasonForUrl(url);
    if (blocked) {
      markBlocked(blocked);
      return;
    }

    const data = await readStorageFromTab(tab.id);
    if (scanId !== state.scanId) {
      return;
    }

    const localError = data.localStorage.error;
    const sessionError = data.sessionStorage.error;

    setCounts(
      localError && data.localStorage.items.length === 0 ? null : data.localStorage.items.length,
      sessionError && data.sessionStorage.items.length === 0 ? null : data.sessionStorage.items.length
    );

    if (localError && sessionError) {
      markBlocked(`浏览器阻止了当前页面读取缓存：${shorten(localError, 140)}`);
      return;
    }

    setAccess(ACCESS.READY);

    if (localError || sessionError) {
      const problem = localError ? "localStorage" : "sessionStorage";
      const message = localError || sessionError;
      showSiteNotice(`${problem} 读取失败：${shorten(message, 150)}`, "error");
    }

    if (manual && !initial) {
      showToast("已刷新当前页面缓存数量", "info", 1800);
    }
  } catch (error) {
    if (scanId !== state.scanId) {
      return;
    }

    const message = friendlyError(error);
    markBlocked(message);
    if (!initial) {
      showToast(message, "error", 4200);
    }
  } finally {
    if (scanId === state.scanId) {
      state.isRefreshing = false;
      syncUi();
    }
  }
}

async function queryActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }

  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== "number") {
    throw new Error("没有找到当前标签页，请重新打开扩展。");
  }
  return tab;
}

async function readStorageFromTab(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const readOne = (name) => {
        try {
          const storage = window[name];
          const items = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key === null) {
              continue;
            }
            items.push({ key, value: storage.getItem(key) ?? "" });
          }
          return { items, error: null };
        } catch (error) {
          return {
            items: [],
            error: String((error && error.message) || error || "未知错误"),
          };
        }
      };

      return {
        localStorage: readOne("localStorage"),
        sessionStorage: readOne("sessionStorage"),
      };
    },
  });

  const result = injection && injection[0] && injection[0].result;
  if (!result) {
    throw new Error("没有读取到页面数据，请刷新页面后重试。");
  }

  return {
    localStorage: normalizePageStore(result.localStorage),
    sessionStorage: normalizePageStore(result.sessionStorage),
  };
}

function normalizePageStore(raw) {
  if (!raw || typeof raw !== "object") {
    return { items: [], error: "页面返回了无法识别的缓存数据。" };
  }

  return {
    items: normalizeItems(raw.items),
    error: raw.error ? String(raw.error) : null,
  };
}

function setSiteIdentity(rawUrl, pageTitle) {
  const info = describeUrl(rawUrl);
  const title = String(pageTitle || "").trim() || info.fallbackTitle;

  state.siteInfo = { ...info, title };
  els.siteHost.textContent = info.host;
  els.siteHost.title = rawUrl || info.host;
  els.siteTitle.textContent = title;
  els.siteTitle.title = title;
  els.siteAvatar.textContent = info.avatar;
  els.siteAvatar.style.background = avatarGradient(info.host);

  if (state.snapshot) {
    els.pasteTarget.textContent = info.target;
  }
}

function describeUrl(rawUrl) {
  const raw = String(rawUrl || "");
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    // The URL can be unavailable on browser-internal pages.
  }

  if (!url) {
    return {
      host: "未知页面",
      target: "当前页面",
      avatar: "?",
      fallbackTitle: "无法读取当前页面地址",
    };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    const host = url.hostname || "当前页面";
    return {
      host,
      target: host,
      avatar: avatarLetter(host),
      fallbackTitle: raw,
    };
  }

  if (url.protocol === "file:") {
    let filename = "";
    try {
      filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    } catch {
      filename = url.pathname.split("/").filter(Boolean).pop() || "";
    }
    return {
      host: "本地文件",
      target: filename || "本地文件",
      avatar: "F",
      fallbackTitle: filename || raw,
    };
  }

  if (url.protocol === "chrome:" || url.protocol === "edge:" || url.protocol === "about:") {
    return {
      host: "浏览器内部页面",
      target: "当前页面",
      avatar: "内",
      fallbackTitle: "该页面受浏览器保护",
    };
  }

  if (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") {
    return {
      host: "扩展页面",
      target: "当前页面",
      avatar: "扩",
      fallbackTitle: "扩展页面不允许注入脚本",
    };
  }

  const protocol = url.protocol.replace(":", "").toUpperCase();
  return {
    host: `${protocol || "特殊"} 页面`,
    target: "当前页面",
    avatar: "?",
    fallbackTitle: raw,
  };
}

function avatarLetter(host) {
  const cleaned = String(host || "").replace(/^www\./i, "");
  const first = Array.from(cleaned)[0];
  return first && /[a-z0-9]/i.test(first) ? first.toUpperCase() : "链";
}

function avatarGradient(host) {
  let hash = 0;
  for (const char of String(host || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const palette = avatarPalettes[hash % avatarPalettes.length];
  return `linear-gradient(145deg, ${palette[0]}, ${palette[1]})`;
}

function blockedReasonForUrl(rawUrl) {
  const raw = String(rawUrl || "");
  if (!raw) {
    return "无法读取当前页面地址，请关闭浮窗后重试。";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "无法识别当前页面地址，请切换到普通网页后重试。";
  }

  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    return "浏览器内部页面不允许扩展读写缓存，请切换到普通网页后重试。";
  }

  if (
    url.hostname === "chromewebstore.google.com" ||
    (url.hostname === "chrome.google.com" &&
      (url.pathname === "/webstore" || url.pathname.startsWith("/webstore/"))) ||
    (url.hostname === "microsoftedge.microsoft.com" &&
      (url.pathname === "/addons" || url.pathname.startsWith("/addons/")))
  ) {
    return "Chrome 应用商店页面受浏览器保护，无法读写缓存。请切换到普通网页后重试。";
  }

  return null;
}

/* ---------- Copy ---------- */

async function handleCopy() {
  if (state.busy) {
    return;
  }

  setBusy("copy");
  hideSiteNotice();

  try {
    const tab = await queryActiveTab();
    const url = tab.url || tab.pendingUrl || "";
    state.tab = tab;
    setSiteIdentity(url, tab.title);

    const blocked = blockedReasonForUrl(url);
    if (blocked) {
      markBlocked(blocked);
      showToast(blocked, "error", 4200);
      return;
    }

    const data = await readStorageFromTab(tab.id);
    const localItems = data.localStorage.items;
    const sessionItems = data.sessionStorage.items;
    const localError = data.localStorage.error;
    const sessionError = data.sessionStorage.error;
    const total = localItems.length + sessionItems.length;

    if (localError && sessionError) {
      const message = `没能读取当前页面的缓存：${shorten(localError, 120)}`;
      markBlocked(message);
      showToast(message, "error", 4600);
      return;
    }

    if (total === 0) {
      if (localError || sessionError) {
        const message = `没有可复制的数据：${shorten(localError || sessionError, 140)}`;
        setAccess(ACCESS.READY);
        setCounts(null, null);
        showSiteNotice(message, "error");
        showToast(message, "info", 4200);
      } else {
        setAccess(ACCESS.READY);
        setCounts(0, 0);
        showToast("当前页面的 localStorage 和 sessionStorage 都是空的", "info", 3600);
      }
      return;
    }

    const snapshot = buildSnapshot(url, tab.title, data);
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });

    state.snapshot = snapshot;
    state.activeStore = snapshot.localStorage.length > 0 ? "localStorage" : "sessionStorage";
    setCounts(
      localError && localItems.length === 0 ? null : localItems.length,
      sessionError && sessionItems.length === 0 ? null : sessionItems.length
    );
    setAccess(ACCESS.READY);
    renderSnapshot();

    // The popup viewport is short; bring the freshly copied data into view.
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      els.snapshotCard.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    });

    const clipboardOk = await writeClipboard(buildClipboardText(snapshot));
    const partial = Boolean(localError || sessionError);
    let message = `已暂存 ${total} 项缓存${clipboardOk ? "，并写入剪贴板" : ""}`;
    if (partial) {
      message += "（部分缓存读取失败）";
    } else if (!clipboardOk) {
      message += "（剪贴板不可用）";
    }

    showToast(message, partial || !clipboardOk ? "info" : "success", 3400);
  } catch (error) {
    const message = friendlyError(error);
    if (isAccessError(error)) {
      markBlocked(message);
    } else {
      showSiteNotice(message, "error");
    }
    showToast(message, "error", 4400);
  } finally {
    setBusy(null);
  }
}

function buildSnapshot(rawUrl, pageTitle, data) {
  const info = describeUrl(rawUrl);
  let origin = "";
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    origin = "";
  }

  const snapshot = {
    schema: 1,
    copiedAt: Date.now(),
    source: {
      url: String(rawUrl || ""),
      origin,
      host: info.host,
      title: String(pageTitle || "").trim(),
    },
    localStorage: data.localStorage.items,
    sessionStorage: data.sessionStorage.items,
    errors: {
      localStorage: data.localStorage.error,
      sessionStorage: data.sessionStorage.error,
    },
  };

  snapshot.sizeBytes = calculateSnapshotSize(snapshot);
  return snapshot;
}

function calculateSnapshotSize(snapshot) {
  return utf8Size(
    JSON.stringify({
      localStorage: snapshot.localStorage,
      sessionStorage: snapshot.sessionStorage,
    })
  );
}

function buildClipboardText(snapshot) {
  const payload = {
    source: snapshot.source.url,
    title: snapshot.source.title || undefined,
    copiedAt: new Date(snapshot.copiedAt).toISOString(),
    localStorage: itemsToObject(snapshot.localStorage),
    sessionStorage: itemsToObject(snapshot.sessionStorage),
  };
  return JSON.stringify(payload, null, 2);
}

function itemsToObject(items) {
  const output = Object.create(null);
  for (const item of items) {
    output[item.key] = item.value;
  }
  return output;
}

async function writeClipboard(text) {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------- Paste ---------- */

async function handlePaste() {
  if (state.busy || !state.snapshot) {
    return;
  }

  setBusy("paste");
  hideSiteNotice();

  try {
    const tab = await queryActiveTab();
    const url = tab.url || tab.pendingUrl || "";
    state.tab = tab;
    setSiteIdentity(url, tab.title);

    const blocked = blockedReasonForUrl(url);
    if (blocked) {
      markBlocked(blocked);
      showToast(blocked, "error", 4200);
      return;
    }

    const snapshot = state.snapshot;
    const result = await applyStorageToTab(tab.id, snapshot, state.prefs.clearFirst);
    const localStats = result.localStorage;
    const sessionStats = result.sessionStorage;
    const outcome = summarizePaste(result);

    if (outcome.errorCount === 2 && outcome.written === 0) {
      const message = "当前页面阻止了缓存写入，请换一个普通网页后重试。";
      markBlocked(message);
      showToast(message, "error", 4400);
      return;
    }

    setAccess(ACCESS.READY);
    setCounts(
      localStats && localStats.ok ? localStats.total : null,
      sessionStats && sessionStats.ok ? sessionStats.total : null
    );

    if (outcome.errorCount > 0) {
      const detail = outcome.errors[0] || "页面拒绝写入部分缓存。";
      showSiteNotice(detail, "error");
      showToast(
        `已写入 ${outcome.written} 项，但${outcome.errorCount === 2 ? "有一类存储" : "部分数据"}写入失败；暂存数据已保留`,
        "error",
        4800
      );
    } else if (outcome.failedCount > 0) {
      const first = outcome.failures[0];
      const detail = first
        ? `${first.store} 中有 ${outcome.failedCount} 项写入失败：${shorten(first.message, 140)}`
        : `有 ${outcome.failedCount} 项缓存写入失败。`;
      showSiteNotice(detail, "error");
      showToast(
        `已写入 ${outcome.written} 项，${outcome.failedCount} 项失败；暂存数据已保留`,
        "error",
        4800
      );
    } else {
      const verb = state.prefs.clearFirst ? "已替换" : "已写入";
      const cleared = await clearStoredSnapshot();
      if (cleared) {
        showToast(`${verb} ${outcome.written} 项缓存，暂存区已清空`, "success", 3400);
      } else {
        showToast(
          `${verb} ${outcome.written} 项缓存，但暂存区清除失败`,
          "error",
          4400
        );
      }
    }
  } catch (error) {
    const message = friendlyError(error);
    if (isAccessError(error)) {
      markBlocked(message);
    } else {
      showSiteNotice(message, "error");
    }
    showToast(message, "error", 4400);
  } finally {
    setBusy(null);
  }
}

async function clearStoredSnapshot() {
  try {
    await chrome.storage.local.remove(SNAPSHOT_KEY);
    state.snapshot = null;
    state.activeStore = "localStorage";
    renderSnapshot();
    return true;
  } catch {
    return false;
  }
}

async function applyStorageToTab(tabId, snapshot, clearFirst) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    args: [snapshot.localStorage, snapshot.sessionStorage, Boolean(clearFirst)],
    func: (localItems, sessionItems, shouldClear) => {
      const applyOne = (name, incoming) => {
        const stats = {
          ok: false,
          written: 0,
          cleared: 0,
          failed: [],
          failedCount: 0,
          error: null,
          total: 0,
        };

        try {
          const storage = window[name];
          if (shouldClear) {
            stats.cleared = storage.length;
            storage.clear();
          }

          for (const item of incoming) {
            try {
              storage.setItem(item.key, item.value);
              stats.written += 1;
            } catch (error) {
              stats.failedCount += 1;
              if (stats.failed.length < 8) {
                stats.failed.push({
                  key: item.key,
                  message: String((error && error.message) || error || "写入失败"),
                });
              }
            }
          }

          stats.ok = true;
          stats.total = storage.length;
        } catch (error) {
          stats.error = String((error && error.message) || error || "写入失败");
        }

        return stats;
      };

      return {
        localStorage: applyOne("localStorage", localItems),
        sessionStorage: applyOne("sessionStorage", sessionItems),
      };
    },
  });

  const result = injection && injection[0] && injection[0].result;
  if (!result) {
    throw new Error("没有收到页面的写入结果，请刷新页面后重试。");
  }

  return {
    localStorage: result.localStorage || null,
    sessionStorage: result.sessionStorage || null,
  };
}

function summarizePaste(result) {
  const stores = [
    ["localStorage", result.localStorage],
    ["sessionStorage", result.sessionStorage],
  ];

  const summary = {
    written: 0,
    cleared: 0,
    failedCount: 0,
    failures: [],
    errors: [],
    errorCount: 0,
  };

  for (const [storeName, stats] of stores) {
    if (!stats || stats.error) {
      summary.errorCount += 1;
      summary.errors.push(
        `${storeName} 写入失败：${shorten((stats && stats.error) || "页面未返回结果", 150)}`
      );
      continue;
    }

    summary.written += Number(stats.written) || 0;
    summary.cleared += Number(stats.cleared) || 0;
    summary.failedCount += Number(stats.failedCount) || 0;

    for (const failure of stats.failed || []) {
      if (summary.failures.length < 8) {
        summary.failures.push({
          store: storeName,
          key: String(failure.key || ""),
          message: String(failure.message || "写入失败"),
        });
      }
    }
  }

  return summary;
}

/* ---------- Snapshot rendering ---------- */

function renderSnapshot() {
  const snapshot = state.snapshot;

  if (!snapshot) {
    els.snapshotCard.hidden = true;
    els.emptyState.hidden = false;
    els.pasteBtn.disabled = true;
    syncUi();
    return;
  }

  els.snapshotCard.hidden = false;
  els.emptyState.hidden = true;
  els.snapshotHost.textContent = snapshot.source.host || "未知站点";
  els.snapshotHost.title = snapshot.source.url || snapshot.source.host || "";
  els.pasteTarget.textContent = (state.siteInfo && state.siteInfo.target) || "当前页面";
  els.snapshotSize.textContent = formatBytes(snapshot.sizeBytes);
  els.snapshotTime.textContent = formatTimestamp(snapshot.copiedAt);
  els.snapshotTime.title = formatFullTimestamp(snapshot.copiedAt);
  els.localTabCount.textContent = formatCount(snapshot.localStorage.length);
  els.sessionTabCount.textContent = formatCount(snapshot.sessionStorage.length);

  updateTabs();
  renderStorageList();
  syncUi();
}

function updateTabs() {
  const localActive = state.activeStore === "localStorage";
  els.localTab.classList.toggle("is-active", localActive);
  els.sessionTab.classList.toggle("is-active", !localActive);
  els.localTab.setAttribute("aria-selected", String(localActive));
  els.sessionTab.setAttribute("aria-selected", String(!localActive));
  els.localTab.tabIndex = localActive ? 0 : -1;
  els.sessionTab.tabIndex = localActive ? -1 : 0;
  els.storageList.setAttribute("aria-labelledby", localActive ? "localTab" : "sessionTab");
}

function selectStore(store) {
  if (store !== "localStorage" && store !== "sessionStorage") {
    return;
  }
  if (state.activeStore === store) {
    return;
  }

  state.activeStore = store;
  updateTabs();
  renderStorageList();
}

function handleTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  let next = state.activeStore;

  if (event.key === "Home") {
    next = "localStorage";
  } else if (event.key === "End") {
    next = "sessionStorage";
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = state.activeStore === "localStorage" ? "sessionStorage" : "localStorage";
  }

  selectStore(next);
  (next === "localStorage" ? els.localTab : els.sessionTab).focus();
}

function renderStorageList() {
  const snapshot = state.snapshot;
  els.storageList.replaceChildren();

  if (!snapshot) {
    return;
  }

  const storeName = state.activeStore;
  const items = snapshot[storeName] || [];
  const storeError = snapshot.errors && snapshot.errors[storeName];

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = storeError ? "list-empty is-error" : "list-empty";

    const title = document.createElement("strong");
    title.textContent = storeError ? `${storeName} 读取失败` : `${storeName} 是空的`;

    const description = document.createElement("span");
    description.textContent = storeError
      ? shorten(storeError, 180)
      : "复制时这个存储中没有可读取的内容。";

    empty.append(title, description);
    els.storageList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items.slice(0, MAX_RENDER_ITEMS)) {
    fragment.append(createEntry(item));
  }

  if (items.length > MAX_RENDER_ITEMS) {
    const note = document.createElement("div");
    note.className = "list-more";
    note.textContent = `共 ${items.length} 项，仅预览前 ${MAX_RENDER_ITEMS} 项；粘贴时会写入全部数据。`;
    fragment.append(note);
  }

  if (storeError) {
    const note = document.createElement("div");
    note.className = "list-more is-error";
    note.textContent = `读取时有错误：${shorten(storeError, 180)}`;
    fragment.append(note);
  }

  els.storageList.append(fragment);
  els.storageList.scrollTop = 0;
}

function createEntry(item) {
  const value = String(item.value ?? "");
  const isLong = value.length > 170 || countNewlines(value, 3) >= 2;
  const row = document.createElement(isLong ? "button" : "div");
  row.className = "entry";

  if (isLong) {
    row.type = "button";
    row.classList.add("is-expandable");
    row.setAttribute("aria-expanded", "false");
  }

  const head = document.createElement("span");
  head.className = "entry-head";

  const key = document.createElement("span");
  key.className = "entry-key";
  key.textContent = item.key === "" ? "（空键名）" : item.key;
  key.title = item.key;
  head.append(key);

  const size = document.createElement("span");
  size.className = "entry-size";
  size.textContent = formatCharacterCount(value.length);
  head.append(size);

  if (isLong) {
    head.append(createChevron());
    row.addEventListener("click", () => {
      if (String(window.getSelection() || "")) {
        return;
      }
      const expanded = row.classList.toggle("is-expanded");
      row.setAttribute("aria-expanded", String(expanded));
    });
  }

  const valueElement = document.createElement("span");
  valueElement.className = "entry-value";

  if (value === "") {
    valueElement.classList.add("is-empty");
    valueElement.textContent = "空字符串";
  } else if (value.length > MAX_PREVIEW_CHARS) {
    valueElement.textContent = `${value.slice(0, MAX_PREVIEW_CHARS)}\n\n… 仅展示前 ${MAX_PREVIEW_CHARS} 个字符，完整内容已暂存。`;
  } else {
    valueElement.textContent = value;
  }

  row.append(head, valueElement);
  return row;
}

function createChevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("entry-chevron");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  svg.append(path);
  return svg;
}

function countNewlines(value, limit) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      count += 1;
      if (count >= limit) {
        break;
      }
    }
  }
  return count;
}

/* ---------- UI state ---------- */

function setAccess(status) {
  state.access = status;
  const labels = {
    [ACCESS.LOADING]: "读取中",
    [ACCESS.READY]: "可读写",
    [ACCESS.BLOCKED]: "受限",
  };
  const classes = {
    [ACCESS.LOADING]: "access-badge is-loading",
    [ACCESS.READY]: "access-badge is-ready",
    [ACCESS.BLOCKED]: "access-badge is-blocked",
  };

  els.accessBadge.textContent = labels[status] || "读取中";
  els.accessBadge.className = classes[status] || "access-badge is-loading";
}

function setCounts(localCount, sessionCount) {
  els.localCount.textContent = formatCount(localCount);
  els.sessionCount.textContent = formatCount(sessionCount);
  els.localCount.title = localCount === null ? "读取失败" : `${localCount} 项`;
  els.sessionCount.title = sessionCount === null ? "读取失败" : `${sessionCount} 项`;
}

function setBusy(kind) {
  state.busy = kind;
  syncUi();
}

function syncUi() {
  const accessReady = state.access === ACCESS.READY;
  const working = Boolean(state.busy) || state.isRefreshing;
  const hasSnapshot = Boolean(state.snapshot);

  els.copyBtn.disabled = !accessReady || working;
  els.pasteBtn.disabled = !accessReady || !hasSnapshot || working;
  els.refreshBtn.disabled = working;

  els.copyBtn.classList.toggle("is-busy", state.busy === "copy");
  els.pasteBtn.classList.toggle("is-busy", state.busy === "paste");
  els.refreshBtn.classList.toggle("is-spinning", state.isRefreshing);

  setButtonLabel(els.copyBtn, state.busy === "copy" ? "正在复制…" : "复制缓存数据");
  setButtonLabel(els.pasteBtn, state.busy === "paste" ? "正在粘贴…" : "粘贴缓存数据");

  els.copyBtn.setAttribute("aria-busy", String(state.busy === "copy"));
  els.pasteBtn.setAttribute("aria-busy", String(state.busy === "paste"));

  els.copyBtn.title = accessReady ? "复制当前页面的 localStorage 与 sessionStorage" : "当前页面不可读写";
  if (!accessReady) {
    els.pasteBtn.title = "当前页面不可读写";
  } else if (!hasSnapshot) {
    els.pasteBtn.title = "暂存区为空，请先复制缓存";
  } else if (state.prefs.clearFirst) {
    els.pasteBtn.title = "清空当前页面存储后，写入上次复制的缓存";
  } else {
    els.pasteBtn.title = "把上次复制的缓存写入当前页面";
  }

  let hint;
  let warning = false;

  if (state.access === ACCESS.BLOCKED) {
    hint = "当前页面受浏览器保护，请切换到普通网页后使用。";
    warning = true;
  } else if (state.access === ACCESS.LOADING || state.isRefreshing) {
    hint = "正在读取当前页面的缓存…";
  } else if (state.busy === "copy") {
    hint = "正在抓取并暂存当前页面的缓存…";
  } else if (state.busy === "paste") {
    hint = "正在把暂存内容写入当前页面…";
  } else if (hasSnapshot) {
    const total = state.snapshot.localStorage.length + state.snapshot.sessionStorage.length;
    hint = `暂存区有 ${total} 项缓存，切换到其他页面后点击「粘贴」。`;
  } else {
    hint = "复制会把当前站点缓存暂存到本机，并写入剪贴板。";
  }

  els.actionHint.textContent = hint;
  els.actionHint.classList.toggle("is-warn", warning);
}

function setButtonLabel(button, label) {
  const element = button.querySelector(".btn-label");
  if (element) {
    element.textContent = label;
  }
}

function showSiteNotice(message, tone = "warn") {
  els.siteNotice.textContent = message;
  els.siteNotice.dataset.tone = tone;
  els.siteNotice.hidden = false;
}

function hideSiteNotice() {
  els.siteNotice.hidden = true;
  els.siteNotice.textContent = "";
  delete els.siteNotice.dataset.tone;
}

function markBlocked(message) {
  setAccess(ACCESS.BLOCKED);
  setCounts(null, null);
  showSiteNotice(message, "warn");
  syncUi();
}

function showToast(message, tone = "success", duration = 3000) {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }

  els.toast.hidden = false;
  els.toast.dataset.tone = tone;
  els.toastIcon.textContent = tone === "error" ? "!" : tone === "info" ? "i" : "✓";
  els.toastText.textContent = message;

  els.toast.style.animation = "none";
  void els.toast.offsetWidth;
  els.toast.style.animation = "";

  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
    state.toastTimer = null;
  }, duration);
}

/* ---------- Errors and formatting ---------- */

function friendlyError(error) {
  const raw = String((error && error.message) || error || "").trim();
  if (!raw) {
    return "操作失败，请重试。";
  }

  if (/[\u3400-\u9fff]/.test(raw)) {
    return raw;
  }

  if (/file:\/\//i.test(raw) || (state.tab && String(state.tab.url || "").startsWith("file:"))) {
    if (/cannot access|denied|permission|insecure/i.test(raw)) {
      return "无法访问本地文件。请在 chrome://extensions 中打开本扩展详情，启用「允许访问文件网址」后重试。";
    }
  }

  if (
    /cannot access contents|cannot access a chrome|extensions gallery cannot be scripted|manifest must request permission|cannot access the page|receiving end does not exist/i.test(
      raw
    )
  ) {
    return "当前页面受浏览器保护，无法读写缓存。请切换到普通网页后重试。";
  }

  if (/no tab with id|tab was closed|invalid tab id|frame with id/i.test(raw)) {
    return "标签页已关闭或刚刚跳转，请重新打开扩展后再试。";
  }

  if (/quota|quota_bytes|quotaexceeded/i.test(raw)) {
    return "缓存容量超出限制，部分数据未能写入。请减少缓存内容后重试。";
  }

  if (/securityerror|operation is insecure|access is denied/i.test(raw)) {
    return "浏览器阻止了当前页面对本地缓存的访问。";
  }

  return `操作失败：${shorten(raw.replace(/\s+/g, " "), 160)}`;
}

function isAccessError(error) {
  const raw = String((error && error.message) || error || "");
  return /cannot access|cannot access a chrome|extensions gallery cannot be scripted|manifest must request permission|no tab with id|tab was closed|file:\/\//i.test(
    raw
  );
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

  if (isSameDate(date, now)) {
    return `今天 ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDate(date, yesterday)) {
    return `昨天 ${time}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatFullTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "medium",
  }).format(date);
}

function isSameDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatBytes(bytes) {
  const count = Number(bytes);
  if (!Number.isFinite(count) || count <= 0) {
    return "0 B";
  }
  if (count < 1024) {
    return `${count} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = count / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatCount(count) {
  if (count === null || count === undefined) {
    return "—";
  }
  const number = Number(count);
  if (!Number.isFinite(number)) {
    return "—";
  }
  if (number >= 10000) {
    return `${Math.round(number / 1000)}k`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }
  return String(number);
}

function formatCharacterCount(count) {
  if (count >= 10000) {
    return `${Math.round(count / 1000)}k 字`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k 字`;
  }
  return `${count} 字`;
}

function utf8Size(value) {
  return textEncoder.encode(String(value)).length;
}

function shorten(value, length) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

init();

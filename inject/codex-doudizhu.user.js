(() => {
  "use strict";

  const VERSION = "1.0.0";
  const SOURCE_HASH = window.__CODEX_DOUDIZHU_SOURCE_HASH__ || "development";
  const GAME_URL = String(window.__CODEX_DOUDIZHU_URL__ || "");
  const BOOTSTRAP_HTML = String(window.__CODEX_DOUDIZHU_BOOTSTRAP_HTML__ || "");
  const AUTO_OPEN = window.__CODEX_DOUDIZHU_AUTO_OPEN__ !== false;
  const SENTINEL = "__codexDoudizhuInjection__";
  const ENTRY_ID = "codex-doudizhu-entry";
  const PAGE_ID = "codex-doudizhu-page";
  const FRAME_ID = "codex-doudizhu-frame";
  const STATUS_ID = "codex-doudizhu-status";
  const DRAG_ID = "codex-doudizhu-drag-region";
  const STYLE_ID = "codex-doudizhu-style";
  const OWNED = "data-codex-doudizhu-owned";
  const HIDDEN = "data-codex-doudizhu-hidden";
  const HOST = "data-codex-doudizhu-host";
  const NATIVE_SELECTED = "data-codex-doudizhu-native-selected";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_LABELS = [
    "新建任务", "新对话", "new task", "new chat", "拉取请求", "pull requests",
    "站点", "sites", "已安排", "scheduled", "插件", "plugins",
  ];

  const previous = window[SENTINEL];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  previous?.destroy?.();

  let entry = null;
  let entryLabel = null;
  let page = null;
  let frame = null;
  let status = null;
  let dragRegion = null;
  let frameOrigin = "";
  let frameNonce = "";
  let frameReady = false;
  let active = false;
  let destroyed = false;
  let lastFocused = null;
  let observer = null;
  let refreshTimer = null;
  let autoOpenTimer = null;
  let frameProbeTimer = null;
  let frameInitTimer = null;
  let frameBlobUrl = "";
  const mutedNative = new Map();

  function text(chinese, english) {
    const lang = String(document.documentElement.lang || navigator.language || "en").toLowerCase();
    return lang.startsWith("zh") ? chinese : english;
  }

  function normalized(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function randomNonce() {
    const secureRandom = globalThis.crypto?.randomUUID;
    if (typeof secureRandom === "function") return secureRandom.call(globalThis.crypto);
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (!bytes.some(Boolean)) for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function buttonMatches(button, labels) {
    return Boolean(button && labels.includes(normalized(button.textContent || button.getAttribute("aria-label"))));
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] { background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent)); }
      #${ENTRY_ID}:focus-visible { outline: 2px solid var(--color-token-border, Highlight); outline-offset: 2px; }
      [${HOST}="true"] { position: relative !important; z-index: 31 !important; pointer-events: none !important; }
      [${HIDDEN}="true"] { visibility: hidden !important; pointer-events: none !important; }
      [${NATIVE_SELECTED}="true"] { background-color: transparent !important; }
      #${PAGE_ID} { position: absolute; inset: 0; z-index: 1; min-width: 0; min-height: 0; overflow: hidden; background: #081d17; pointer-events: auto; }
      #${PAGE_ID}[hidden], #${FRAME_ID}[hidden], #${STATUS_ID}[hidden], #${DRAG_ID}[hidden] { display: none !important; }
      #${FRAME_ID} { display: flex; width: 100%; height: 100%; border: 0; background: #081d17; }
      #${STATUS_ID} { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 24px; background: #081d17; color: var(--color-token-text-secondary, #9ca3af); font: 13px/1.5 system-ui, sans-serif; text-align: center; }
      #${STATUS_ID} button { margin-top: 10px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 7px; padding: 5px 10px; background: var(--color-token-main-surface-secondary, Canvas); color: var(--color-token-foreground, CanvasText); cursor: pointer; }
      #${DRAG_ID} { position: absolute; top: 0; left: 0; right: 0; height: 28px; z-index: 4; pointer-events: none; -webkit-app-region: drag; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;
    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const top = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const children = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return children.length >= 3 && element.getBoundingClientRect().top < top;
    });
    const group = groups.sort((a, b) => b.children.length - a.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `<rect x="4" y="3" width="16" height="18" rx="2.5"></rect><path d="M8 7h8M8 11h8M8 15h4"></path>`;
  }

  function syncEntry() {
    if (!entry) return;
    entry.setAttribute("aria-label", text("打开斗地主", "Open Dou Dizhu"));
    entry.setAttribute("title", text("斗地主", "Dou Dizhu"));
    if (entryLabel) entryLabel.textContent = text("斗地主", "Dou Dizhu");
  }

  function syncState() {
    if (!entry) return;
    if (active) entry.setAttribute("aria-current", "page");
    else entry.removeAttribute("aria-current");
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    entryLabel = button.querySelector(".text-fade-truncate") || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    replaceIcon(button);
    syncEntry();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) reference.after(entry);
    syncEntry();
    syncState();
  }

  function findMount() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) {
      const viewport = direct.closest("[data-app-shell-main-content-layout]");
      return { frameHost: direct, surface: viewport?.parentElement };
    }
    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const frameHost = Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8 && rect.height >= viewportRect.height * 0.7;
    });
    return frameHost ? { frameHost, surface: viewport.parentElement } : null;
  }

  function muteNativeSelection() {
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]').forEach((node) => {
      if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
      if (!mutedNative.has(node)) mutedNative.set(node, node.getAttribute("aria-current"));
      node.removeAttribute("aria-current");
      node.setAttribute(NATIVE_SELECTED, "true");
    });
  }

  function restoreNativeSelection() {
    mutedNative.forEach((value, node) => {
      if (node.isConnected) node.setAttribute("aria-current", value);
      node.removeAttribute(NATIVE_SELECTED);
    });
    mutedNative.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED}="true"]`).forEach((node) => node.removeAttribute(NATIVE_SELECTED));
  }

  function hideNativeContent() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]').forEach((surface) => {
      Array.from(surface.children).forEach((child) => child.setAttribute(HIDDEN, "true"));
    });
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    document.querySelectorAll(`[${HOST}="true"]`).forEach((node) => node.removeAttribute(HOST));
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", text("斗地主", "Dou Dizhu"));
    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    section.append(status);
    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED, "true");
    section.append(dragRegion);
    return section;
  }

  function renderStatus(message, retry = false) {
    if (!status) return;
    status.replaceChildren(document.createTextNode(message));
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text("重新加载", "Reload");
      button.addEventListener("click", () => open(), { once: true });
      status.appendChild(button);
    }
    status.hidden = false;
    if (frame && !isWebviewFrame()) frame.hidden = true;
  }

  function revealReadyFrame() {
    frameReady = true;
    if (status) status.hidden = true;
    if (frame) frame.hidden = false;
  }

  function isWebviewFrame() {
    return frame?.tagName === "WEBVIEW" && typeof frame.executeJavaScript === "function";
  }

  function scheduleFrameProbe(delay = 180) {
    if (!isWebviewFrame() && !frameBlobUrl) return;
    if (frameProbeTimer !== null) window.clearTimeout(frameProbeTimer);
    frameProbeTimer = window.setTimeout(probeWebviewFrame, delay);
  }

  async function probeWebviewFrame() {
    frameProbeTimer = null;
    if (!frame?.isConnected) return;
    if (frameBlobUrl) {
      try {
        const bridge = frame.contentWindow?.__codexDoudizhuBridge__;
        if (bridge) {
          frame.dataset.codexDoudizhuBridge = "true";
          if (active) bridge.resume?.();
          else bridge.pause?.();
          if (bridge.ready === true) {
            stopFrameInit();
            revealReadyFrame();
            return;
          }
        }
      } catch (_) {
        // The blob document is still navigating.
      }
      scheduleFrameProbe(250);
      return;
    }
    if (!isWebviewFrame()) return;
    try {
      const state = await frame.executeJavaScript(`(() => {
        const bridge = window.__codexDoudizhuBridge__;
        return { bridge: Boolean(bridge), ready: bridge?.ready === true, scene: bridge?.scene || "" };
      })()`, true);
      if (state?.bridge) {
        frame.dataset.codexDoudizhuBridge = "true";
        void frame.executeJavaScript(`window.__codexDoudizhuBridge__?.${active ? "resume" : "pause"}?.()`, true).catch(() => {});
      }
      if (state?.ready) {
        revealReadyFrame();
        return;
      }
    } catch (_) {
      // The guest may still be navigating; retry until its Cocos bridge exists.
    }
    scheduleFrameProbe(250);
  }

  function sendVisibility(visible) {
    if (frameBlobUrl) {
      try {
        const bridge = frame?.contentWindow?.__codexDoudizhuBridge__;
        if (bridge) {
          if (visible) bridge.resume?.();
          else bridge.pause?.();
          return;
        }
      } catch (_) {}
    }
    if (isWebviewFrame()) {
      if (frame.dataset.codexDoudizhuLoaded !== "true") return;
      try {
        void Promise.resolve(frame.executeJavaScript(`window.__codexDoudizhuBridge__?.${visible ? "resume" : "pause"}?.()`, true)).catch(() => {});
      } catch (_) {}
      return;
    }
    if (frame?.contentWindow && frameOrigin && frameNonce) {
      const targetOrigin = frameBlobUrl ? "*" : frameOrigin;
      frame.contentWindow.postMessage({ source: "codex-doudizhu", type: visible ? "resume" : "pause", nonce: frameNonce }, targetOrigin);
    }
  }

  function stopFrameInit() {
    if (frameInitTimer !== null) window.clearTimeout(frameInitTimer);
    frameInitTimer = null;
  }

  function sendFrameInit() {
    stopFrameInit();
    if (!frame || isWebviewFrame() || frameReady || !frame.contentWindow || !frameOrigin || !frameNonce) return;
    try {
      const targetOrigin = frameBlobUrl ? "*" : frameOrigin;
      frame.contentWindow.postMessage({ source: "codex-doudizhu", type: "init", nonce: frameNonce, visible: active }, targetOrigin);
    } catch (_) {}
    frameInitTimer = window.setTimeout(sendFrameInit, 400);
  }

  function createFrame() {
    if (!GAME_URL || !page) return;
    frame?.remove();
    if (frameBlobUrl) URL.revokeObjectURL(frameBlobUrl);
    frameBlobUrl = "";
    frameReady = false;
    frameNonce = randomNonce();
    frameOrigin = new URL(GAME_URL).origin;
    const webview = document.createElement("webview");
    const useWebview = false;
    frame = useWebview ? webview : document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.title = text("斗地主", "Dou Dizhu");
    const url = new URL(GAME_URL);
    url.hash = `bridge=${encodeURIComponent(frameNonce)}`;
    if (useWebview) {
      frame.hidden = false;
      frame.setAttribute("partition", "codex-doudizhu");
      frame.setAttribute("webpreferences", "sandbox=yes,contextIsolation=yes,nodeIntegration=no");
      const loaded = () => {
        frame.dataset.codexDoudizhuLoaded = "true";
        scheduleFrameProbe(80);
      };
      frame.addEventListener("dom-ready", loaded);
      frame.addEventListener("did-finish-load", loaded);
      frame.addEventListener("did-fail-load", (event) => {
        if (event.errorCode === -3) return;
        frame.dataset.codexDoudizhuError = "true";
        renderStatus(`${text("斗地主加载失败", "Dou Dizhu failed to load")} (${event.errorCode || "unknown"})`, true);
      });
      frame.addEventListener("render-process-gone", () => {
        frame.dataset.codexDoudizhuError = "true";
        renderStatus(text("斗地主进程已退出", "Dou Dizhu process exited"), true);
      });
    } else {
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("allow", "autoplay");
      frame.referrerPolicy = "no-referrer";
      frame.addEventListener("load", () => {
        frame.dataset.codexDoudizhuLoaded = "true";
        sendFrameInit();
      });
      frame.addEventListener("error", () => {
        frame.dataset.codexDoudizhuError = "true";
        renderStatus(text("斗地主加载失败", "Dou Dizhu failed to load"), true);
      });
    }
    if (useWebview) {
      page.appendChild(frame);
      frame.src = url.href;
    } else if (BOOTSTRAP_HTML) {
      const base = `<base href="${GAME_URL.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
      const html = BOOTSTRAP_HTML.replace(/<head([^>]*)>/i, `<head$1>${base}`);
      frameBlobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      frameOrigin = window.location.origin;
      frame.src = `${frameBlobUrl}#bridge=${encodeURIComponent(frameNonce)}`;
      page.appendChild(frame);
      sendFrameInit();
    } else {
      frame.src = url.href;
      page.appendChild(frame);
      sendFrameInit();
    }
  }

  function mountPage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findMount();
    if (!mount?.surface || !mount.surface.closest("main")) return;
    if (page.parentElement !== mount.surface) {
      restoreNativeContent();
      mount.surface.appendChild(page);
    }
    mount.surface.setAttribute(HOST, "true");
    Array.from(mount.surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
    });
    hideNativeContent();
    muteNativeSelection();
    page.hidden = false;
    if (dragRegion) dragRegion.hidden = false;
    document.documentElement.setAttribute("data-codex-doudizhu-open", "true");
  }

  function close(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    active = false;
    sendVisibility(false);
    if (page) page.hidden = true;
    if (dragRegion) dragRegion.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-doudizhu-open");
    syncState();
    if (restoreFocus) lastFocused?.focus?.();
    lastFocused = null;
  }

  function open() {
    if (destroyed || !GAME_URL) return;
    if (!active) lastFocused = document.activeElement;
    active = true;
    ensureEntry();
    mountPage();
    syncState();
    if (!frame) createFrame();
    else sendVisibility(true);
    if (status && !frameReady) renderStatus(text("正在启动斗地主…", "Starting Dou Dizhu…"));
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.source !== "codex-doudizhu" || message.nonce !== frameNonce) return;
    if (!frameBlobUrl && event.origin !== frameOrigin) return;
    if (message.type === "bridge-boot") {
      frame.dataset.codexDoudizhuBoot = "true";
      sendFrameInit();
      return;
    }
    if (message.type === "bridge-ready") {
      stopFrameInit();
      frame.dataset.codexDoudizhuBridge = "true";
      frame.contentWindow.postMessage({ source: "codex-doudizhu", type: active ? "resume" : "pause", nonce: frameNonce }, frameOrigin);
      return;
    }
    if (message.type === "ready") {
      stopFrameInit();
      revealReadyFrame();
      return;
    }
    if (message.type === "error") renderStatus(message.message || text("游戏启动失败", "Game startup failed"), true);
  }

  function isNativeNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    return buttonMatches(clickable, NATIVE_LABELS) || Boolean(clickable.closest("[data-app-action-sidebar-thread-id],[data-app-action-sidebar-project-row],[data-app-action-sidebar-project-id]"));
  }

  function scheduleRefresh() {
    if (refreshTimer !== null || destroyed) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      ensureEntry();
      mountPage();
    }, 160);
  }

  function refresh() {
    ensureEntry();
    mountPage();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    if (autoOpenTimer !== null) window.clearTimeout(autoOpenTimer);
    if (frameProbeTimer !== null) window.clearTimeout(frameProbeTimer);
    stopFrameInit();
    if (frameBlobUrl) URL.revokeObjectURL(frameBlobUrl);
    frameBlobUrl = "";
    observer?.disconnect();
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("click", onNativeClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("resize", scheduleRefresh);
    close(false);
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
  }

  function onClick(event) {
    if (event.target?.closest?.(`#${ENTRY_ID}`)) return;
  }

  function onNativeClick(event) {
    if (active && isNativeNavigation(event.target)) close(false);
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer) return;
    ensureEntry();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-theme", "data-color-theme", "aria-label", "aria-current"] });
    if (AUTO_OPEN) autoOpenTimer = window.setTimeout(open, 300);
  }

  const api = { version: VERSION, sourceHash: SOURCE_HASH, open, close, refresh, destroy, get ready() { return frameReady; } };
  window[SENTINEL] = api;
  window.addEventListener("message", onFrameMessage);
  document.addEventListener("click", onClick, true);
  document.addEventListener("click", onNativeClick, true);
  window.addEventListener("resize", scheduleRefresh);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();

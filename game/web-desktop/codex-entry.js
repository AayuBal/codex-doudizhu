(() => {
  "use strict";

  const SOURCE = "codex-doudizhu";
  const USER_KEY = "userData";
  const GAME_STATE_KEY = "gameState";
  const ROOM_ID = `1_1_codex_${Math.floor(Math.random() * 100000)}`;
  const nonce = new URLSearchParams(window.location.hash.slice(1)).get("bridge") || "";
  let activeSceneName = "";
  let autoStarted = false;
  let readyPending = false;
  let parentOrigin = "";
  let visible = true;
  let paused = false;

  function createGuest() {
    const existing = (() => {
      try {
        return JSON.parse(window.localStorage.getItem(USER_KEY) || "null");
      } catch (_) {
        return null;
      }
    })();
    const ids = new Set();
    const nextId = (candidate, prefix) => {
      let id = String(candidate || "");
      while (!id || ids.has(id)) id = `${prefix}_${Math.floor(Math.random() * 1000000000)}`;
      ids.add(id);
      return id;
    };
    const guestId = nextId(existing?.userId, "codex");
    const rightId = nextId(existing?.rootList?.[0]?.userId, "bot");
    const leftId = nextId(existing?.rootList?.[1]?.userId, "bot");
    const player = {
      userId: guestId,
      userName: existing?.userName || "Codex 玩家",
      roomId: ROOM_ID,
      seatindex: 0,
      avatarUrl: "avatar_1",
      goldcount: 10000,
      rootList: [
        { seatindex: 1, userId: rightId, userName: "AI 右手", avatarUrl: "avatar_2", goldcount: 1000 },
        { seatindex: 2, userId: leftId, userName: "AI 左手", avatarUrl: "avatar_3", goldcount: 1000 },
      ],
      masterUserId: "",
      rate: 1,
      bottom: 1,
    };
    try {
      window.localStorage.setItem(USER_KEY, JSON.stringify(player));
      window.localStorage.setItem(GAME_STATE_KEY, "1");
    } catch (_) {
      // The iframe is expected to have a real loopback origin.
    }
  }

  function post(type, payload = {}) {
    if (!parentOrigin || !nonce) return;
    // Chromium treats the Codex app:// origin as a non-network origin in
    // some embedded builds. The nonce and source checks still pin the
    // recipient; use an explicit origin everywhere else.
    const targetOrigin = parentOrigin.startsWith("app://") || parentOrigin === "null" ? "*" : parentOrigin;
    window.parent?.postMessage({ source: SOURCE, type, nonce, ...payload }, targetOrigin);
  }

  function currentGameScene() {
    const scene = window.cc?.director?.getScene?.();
    if (!scene || scene.name !== "gameScene") return null;
    return scene;
  }

  function prepareGameScene() {
    const scene = currentGameScene();
    if (!scene) return false;
    if (activeSceneName !== scene.name) {
      activeSceneName = scene.name;
      autoStarted = false;
    }

    const backButton = window.cc.find("Canvas/goBack");
    if (backButton) backButton.active = false;
    const canvas = window.cc.find("Canvas");
    const controller = canvas?.getComponent?.("gameScene");
    if (!controller) return false;
    if (!autoStarted && visible && controller.playerNodeList?.length === 3
      && controller.btn_ready?.active && typeof controller.onBtnReadey === "function") {
      autoStarted = true;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          try {
            controller.onBtnReadey(null);
            readyPending = true;
            post("ready");
          } catch (error) {
            autoStarted = false;
            post("error", { message: String(error?.message || error) });
          }
        }, 50);
      }));
    }
    return true;
  }

  function installSceneHooks() {
    if (!window.cc?.director || window.__codexDoudizhuHooksInstalled) return;
    window.__codexDoudizhuHooksInstalled = true;
    window.cc.director.on(window.cc.Director.EVENT_AFTER_SCENE_LAUNCH, () => {
      window.setTimeout(prepareGameScene, 120);
    });
    window.setInterval(prepareGameScene, 500);
    prepareGameScene();
  }

  function applyVisibility(nextVisible) {
    visible = nextVisible;
    if (!window.cc?.game) return;
    if (!visible && !paused) {
      window.cc.audioEngine?.pauseAll?.();
      window.cc.game.pause?.();
      paused = true;
    } else if (visible && paused) {
      window.cc.game.resume?.();
      window.cc.audioEngine?.resumeAll?.();
      paused = false;
      prepareGameScene();
    }
  }

  function handleMessage(event) {
    if (event.source !== window.parent || !event.data || event.data.source !== SOURCE || event.data.nonce !== nonce) return;
    if (event.data.type === "init") {
      if (parentOrigin && parentOrigin !== event.origin) return;
      parentOrigin = event.origin;
      applyVisibility(event.data.visible !== false);
      post("bridge-ready");
      if (readyPending) post("ready");
      return;
    }
    if (!parentOrigin || event.origin !== parentOrigin) return;
    if (event.data.type === "pause") {
      applyVisibility(false);
    } else if (event.data.type === "resume") {
      applyVisibility(true);
    }
  }

  createGuest();
  window.addEventListener("message", handleMessage);
  if (nonce) window.parent?.postMessage({ source: SOURCE, type: "bridge-boot", nonce }, "*");
  const hookTimer = window.setInterval(() => {
    if (window.cc?.director) {
      window.clearInterval(hookTimer);
      installSceneHooks();
    }
  }, 50);
  window.__codexDoudizhuBridge__ = {
    pause: () => applyVisibility(false),
    resume: () => applyVisibility(true),
    get ready() { return readyPending; },
    get scene() { return currentGameScene()?.name || ""; },
  };
})();

// hoptell's own small Telegram Mini App shim (design 7.4, section 6). It follows Telegram's event
// contract (core.telegram.org/api/web-events) and does only this: it reads the launch data from
// the URL fragment, posts the listed events (and only those the client's version allows), and
// passes the listed incoming events to the page. No other Telegram feature is used.
(() => {
  "use strict";
  const WEB_ORIGIN = "https://web.telegram.org";
  const frag = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  const parseObject = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const version = frag.get("tgWebAppVersion") || "0";
  const atLeast = (want) => {
    const a = version.split(".").map((x) => Number.parseInt(x, 10) || 0);
    const b = want.split(".").map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
  };
  // The events the page may post, with the client version each needs. Nothing else is ever sent.
  const OUT = Object.freeze({
    web_app_ready: "6.0",
    web_app_expand: "6.0",
    web_app_request_theme: "6.0",
    web_app_request_viewport: "6.0",
    web_app_setup_back_button: "6.1",
    web_app_close: "6.0",
    web_app_request_safe_area: "8.0",
    web_app_request_content_safe_area: "8.0",
  });
  const IN = Object.freeze(["theme_changed", "viewport_changed", "safe_area_changed", "content_safe_area_changed", "back_button_pressed"]);
  const handlers = new Map(IN.map((t) => [t, []]));

  function post(type, data) {
    if (!Object.hasOwn(OUT, type) || !atLeast(OUT[type])) return false;
    const payload = data === undefined ? null : data;
    try {
      const proxy = window.TelegramWebviewProxy;
      if (proxy && typeof proxy.postEvent === "function") {
        proxy.postEvent(type, payload === null ? "" : JSON.stringify(payload));
        return true;
      }
      const ext = window.external;
      if (ext && typeof ext.notify === "function") {
        ext.notify(JSON.stringify({ eventType: type, eventData: payload }));
        return true;
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(JSON.stringify({ eventType: type, eventData: payload }), WEB_ORIGIN);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function receive(type, data) {
    if (typeof type !== "string" || !handlers.has(type)) return;
    if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data))) return;
    for (const fn of handlers.get(type)) {
      try {
        fn(data || {});
      } catch {
        // one handler's failure never stops the others
      }
    }
  }

  // Native clients call window.Telegram.WebView.receiveEvent(type, data).
  Object.defineProperty(window, "Telegram", { value: Object.freeze({ WebView: Object.freeze({ receiveEvent: receive }) }), writable: false, configurable: false });
  // Telegram Web sends {eventType, eventData} as a message, only from its own origin.
  window.addEventListener("message", (ev) => {
    if (ev.origin !== WEB_ORIGIN) return;
    const d = typeof ev.data === "string" ? parseObject(ev.data) : null;
    if (!d || typeof d.eventType !== "string") return;
    receive(d.eventType, d.eventData);
  });

  Object.defineProperty(window, "hoptellTg", {
    value: Object.freeze({
      initData: frag.get("tgWebAppData") || "",
      theme: parseObject(frag.get("tgWebAppThemeParams") || "") || {},
      version,
      platform: frag.get("tgWebAppPlatform") || "unknown",
      supported: atLeast("6.1"),
      atLeast,
      post,
      on(type, fn) {
        if (handlers.has(type) && typeof fn === "function") handlers.get(type).push(fn);
      },
    }),
    writable: false,
    configurable: false,
  });
})();

// The hoptell app in Telegram (design 7.4, sections 7 and 8). It shows your agents, favourites,
// open questions and agent teams (read-only, design 8, 3.2), and proposes: a message becomes a confirmation in the chat (sent only by your tap
// there), a settings change shows up in the chat with Undo. It keeps nothing on the phone; every
// text from the bridge is put into the page as text, never as markup.
(() => {
  "use strict";
  const tg = window.hoptellTg;
  const TEXT_MAX = 3500;
  const ALIAS_MAX = 24;
  const T = Object.freeze({
    updateTelegram: "Please update Telegram to use this app.",
    notYou: "Only the bot owner can use this app. Open it from the bot chat. If you're the owner and it won't open, wait five minutes and try again.",
    justChanged: "Please wait a minute, then open the app again.",
    reopen: "Please close and open the app again.",
    loading: "Loading…",
    agents: "Agents",
    questions: "Questions",
    teams: "Teams",
    noTeams: "No teams yet. A team shows up here once its lead's session reports it.",
    teamHead: (team, lead) => `Team ${team} · led by ${lead}`,
    teamWhere: (status, machine) => [...(status === "up" ? [] : [status]), ...(machine ? [`on ${machine}`] : [])].join(" · "),
    memberSub: (role, cli, model, effort) => `${role} · ${cli} · model ${model}, effort ${effort} (at launch)`,
    memberWhere: (state, branch, online) => [state, ...(branch ? [branch] : []), online ? "🟢 online" : "⚪ away"].join(" · "),
    teamMore: (n) => `${n} more not shown`,
    teamReview: (who, waiting) => `🔎 Review of ${who}'s work: waiting for ${waiting}`,
    teamsMore: (n) => `${n} more ${n === 1 ? "team" : "teams"} not shown.`,
    teamsReadOnly: "Read-only. The teams report this themselves.",
    search: "Search agents or computers",
    favourites: "Favourites",
    other: "Other",
    online: "🟢 online",
    away: "⚪ away",
    hidden: "hidden",
    talked: (when) => `last message ${when}`,
    noAgents: "No agents yet. They appear here once they are online.",
    noMatch: "No agents match.",
    hiddenCount: (n) => `${n} hidden. Search to find ${n === 1 ? "it" : "them"}.`,
    detailOnline: "🟢 Online",
    detailAway: "⚪ Away",
    detailOn: (m) => `on ${m}`,
    detailNotTalked: "no messages yet",
    favAdd: "☆ Add favourite",
    favRemove: "★ Remove favourite",
    nameLabel: (plain) => `Custom name for ${plain}`,
    save: "Save name",
    removeName: "Use original name",
    hide: "Hide and skip notes",
    unhide: "Show agent again",
    write: "Write a message",
    saving: "Check the chat to see whether the change was saved.",
    to: (full) => `To: ${full}`,
    change: "Change",
    placeholder: "Your message",
    count: (n) => `${n.toLocaleString("en-US")} / ${TEXT_MAX.toLocaleString("en-US")}`,
    sendForConfirmation: "Review in chat",
    checkChat: "Open the chat to confirm your message.",
    writeFirst: "Write a message first.",
    waiting: (n) => `⏳ Waiting for you: ${n}`,
    noQuestions: "No questions are waiting for you.",
    questionHead: (n, who, age) => `Question ${n} · ${who} · ${age}`,
    answerInChat: "Show in chat",
    uncertain: "I'm not sure this went through. Check the chat before you try again.",
    tooMany: "Too many requests. Wait a moment, then try again.",
    offline: "Can't reach your hoptell bot right now. Check your connection, then try again.",
    outdated: "This list was out of date. Here's the updated list.",
  });

  const $ = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  };
  const root = document.getElementById("app");
  // What the owner typed (the message, a name) lives here while the page is open, so a redraw keeps it.
  const view = { screen: "list", tab: "agents", h: null, query: "", list: null, counts: null, details: null, questions: null, teams: null, notice: null, draft: "", alias: null };
  let token = null;
  let opened = false; // a session was opened with this page's initData at least once
  const ops = new Map(); // an action's key -> its op, kept until a clear answer, so a manual retry repeats it

  const newOp = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const opFor = (key) => {
    if (!ops.has(key)) ops.set(key, newOp());
    return ops.get(key);
  };

  // ---- theme, viewport and safe areas --------------------------------------------------------

  const THEME_KEYS = ["bg_color", "text_color", "hint_color", "link_color", "button_color", "button_text_color", "secondary_bg_color", "section_separator_color", "destructive_text_color"];
  function applyTheme(p) {
    const s = document.documentElement.style;
    for (const k of THEME_KEYS) {
      const v = p && typeof p[k] === "string" && /^#[0-9a-fA-F]{6}$/.test(p[k]) ? p[k] : null;
      if (v) s.setProperty(`--tg-theme-${k.replace(/_/g, "-")}`, v);
    }
  }
  const px = (v) => (Number.isFinite(v) && v >= 0 && v < 1000 ? `${v}px` : "0px");
  function applyInsets(prefix, d) {
    const s = document.documentElement.style;
    for (const side of ["top", "bottom", "left", "right"]) s.setProperty(`--${prefix}-${side}`, px(d && d[side]));
  }
  tg.on("theme_changed", (d) => applyTheme(d.theme_params));
  tg.on("viewport_changed", (d) => {
    if (Number.isFinite(d.height) && d.height > 0) document.documentElement.style.setProperty("--tg-viewport-height", `${d.height}px`);
  });
  tg.on("safe_area_changed", (d) => applyInsets("safe", d));
  tg.on("content_safe_area_changed", (d) => applyInsets("content-safe", d));
  tg.on("back_button_pressed", () => back());

  // ---- the API --------------------------------------------------------------------------------

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`api/${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      return { status: 0, json: null };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }

  async function openSession() {
    const r = await call("POST", "session", { init_data: tg.initData });
    if (r.status === 200 && r.json && typeof r.json.token === "string") {
      token = r.json.token;
      opened = true;
      return true;
    }
    fatal(r.json?.error === "just_changed" ? T.justChanged : r.json?.error === "not_you" ? T.notYou : r.status === 429 ? T.tooMany : r.status === 503 || r.status === 0 ? T.offline : T.reopen);
    return false;
  }

  /** A read; an ended session is opened again once from this page's initData (it may be too old by now). */
  async function read(path) {
    let r = await call("GET", path);
    if (r.status === 401 && opened) {
      token = null;
      if (!(await openSession())) return null;
      r = await call("GET", path);
    }
    if (r.status === 401) return fatal(T.reopen), null;
    if (r.status === 429) return notice(T.tooMany), null;
    if (r.status !== 200 || !r.json) return notice(T.offline), null;
    return r.json;
  }

  /**
   * A write: never retried by the page. Without a clear answer it is uncertain, and the same op is
   * kept, so pressing the button again has an effect at most once. Returns the answer or null.
   */
  async function write(key, path, body) {
    const r = await call("POST", path, { ...body, op: opFor(key) });
    if (r.status === 200 && r.json) {
      ops.delete(key);
      return r.json;
    }
    if (r.status === 401) return fatal(T.reopen), null;
    if (r.status === 429) return notice(T.tooMany), null;
    if (r.status === 400) {
      ops.delete(key);
      return notice(T.reopen), null;
    }
    notice(T.uncertain);
    return null;
  }

  // ---- screens --------------------------------------------------------------------------------

  function fatal(text) {
    view.screen = "fatal";
    view.notice = text;
    render();
  }
  function notice(text) {
    view.notice = text;
    render();
  }
  function go(screen, extra = {}) {
    Object.assign(view, { screen, notice: null }, extra);
    tg.post("web_app_setup_back_button", { is_visible: screen === "details" || screen === "compose" });
    render();
  }
  function back() {
    if (view.screen === "compose") return go("details");
    if (view.screen === "details") return showList();
  }

  async function showList(note = null) {
    go("list", { tab: "agents" });
    // The list comes in pages (a long one does not fit one answer), in the order page 0 fixed;
    // rendered once, all read. A newer page 0 elsewhere (another tab) makes it start again, once.
    let list = [];
    const seen = new Set();
    let path = "sessions";
    let restarts = 0;
    for (let i = 0; path && i < 40; i++) {
      const r = await read(path);
      if (!r) return;
      if (r.error === "stale" && path !== "sessions" && restarts++ < 1) {
        [list, path] = [[], "sessions"];
        seen.clear();
        continue;
      }
      if (r.error) return notice(r.text || T.offline);
      for (const x of Array.isArray(r.sessions) ? r.sessions : []) {
        if (seen.has(x.h)) continue;
        seen.add(x.h);
        list.push(x);
      }
      path = typeof r.next === "string" && /^[a-z2-7]{10}\/[0-9]{1,5}$/.test(r.next) ? `sessions/${r.next}` : null;
    }
    view.list = list;
    view.notice = note;
    render();
  }
  async function showDetails(h) {
    if (h !== view.h) Object.assign(view, { draft: "", alias: null });
    go("details", { h, details: null });
    const r = await read(`session/${encodeURIComponent(h)}`);
    if (!r) return;
    if (r.error === "stale") return showList(T.outdated);
    if (r.error) return notice(r.text || T.offline);
    view.details = r;
    render();
  }
  async function showQuestions() {
    go("questions", { tab: "questions", questions: null });
    const r = await read("questions");
    if (!r) return;
    view.questions = Array.isArray(r.questions) ? r.questions : [];
    render();
  }

  async function showTeams() {
    go("teams", { tab: "teams", teams: null });
    const r = await read("teams");
    if (!r) return;
    if (r.error) return notice(r.text || T.offline);
    view.teams = { list: Array.isArray(r.teams) ? r.teams : [], more: Number.isSafeInteger(r.more) ? r.more : 0 };
    render();
  }

  async function setPref(h, set) {
    const key = `prefs:${h}:${JSON.stringify(set)}`;
    const r = await write(key, "prefs", { h, set });
    if (!r) return;
    if (r.error === "stale") return showList(T.outdated);
    if (r.error) return notice(r.text || T.reopen);
    notice(T.saving);
  }
  async function sendDraft(h, text) {
    if (!text.trim()) return notice(T.writeFirst);
    const key = `draft:${h}:${text}`;
    const r = await write(key, "draft", { h, text });
    if (!r) return;
    if (r.error === "stale") return showList(T.outdated);
    if (r.error) return notice(r.text || T.reopen);
    view.draft = "";
    view.notice = T.checkChat;
    view.screen = "done";
    render();
    setTimeout(() => tg.post("web_app_close", {}), 1200);
  }
  async function showInChat(n) {
    const r = await write(`show:${n}`, "questions/show", { n });
    if (!r) return;
    if (r.error) return notice(r.text || T.reopen);
    tg.post("web_app_close", {});
  }

  // ---- rendering --------------------------------------------------------------------------------

  function tabs() {
    const bar = $("nav", "tabs");
    for (const [tab, label, fn] of [
      ["agents", T.agents, () => showList()],
      ["questions", T.questions, () => showQuestions()],
      ["teams", T.teams, () => showTeams()],
    ]) {
      const b = $("button", tab === view.tab ? "tab on" : "tab", label);
      b.type = "button";
      b.addEventListener("click", fn);
      bar.append(b);
    }
    return bar;
  }
  const button = (label, fn, cls = "btn") => {
    const b = $("button", cls, label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };
  const sub = (s) => [s.online ? T.online : T.away, ...(s.hidden ? [T.hidden] : []), ...(s.last_talked ? [T.talked(s.last_talked)] : [])].join(" · ");

  function row(s) {
    const b = $("button", "row");
    b.type = "button";
    b.append($("span", "label", s.label), $("span", s.online ? "sub on" : "sub", sub(s)));
    b.addEventListener("click", () => showDetails(s.h));
    return b;
  }

  function listScreen(main) {
    const box = $("input", "search");
    box.type = "search";
    box.placeholder = T.search;
    box.value = view.query;
    box.maxLength = 64;
    box.addEventListener("input", () => {
      view.query = box.value;
      renderRows(rows);
    });
    const rows = $("div", "rows");
    main.append(box, rows);
    renderRows(rows);
  }
  function renderRows(rows) {
    rows.replaceChildren();
    if (!view.list) return rows.append($("p", "hint", T.loading));
    const q = view.query.trim().toLowerCase();
    const match = (s) => [s.label, s.full, s.logical, s.machine || ""].some((x) => String(x).toLowerCase().includes(q));
    const shown = view.list.filter((s) => (q ? match(s) : !s.hidden));
    if (!view.list.length) return rows.append($("p", "hint", T.noAgents));
    if (!shown.length) rows.append($("p", "hint", T.noMatch));
    const section = (title, list) => {
      if (!list.length) return;
      rows.append($("h2", "section", title));
      const sorted = [...list].sort((a, b) => Number(b.online) - Number(a.online));
      for (const s of sorted) rows.append(row(s));
    };
    section(T.favourites, shown.filter((s) => s.fav));
    const machines = new Map();
    for (const s of shown.filter((x) => !x.fav)) {
      const m = s.machine || "";
      if (!machines.has(m)) machines.set(m, []);
      machines.get(m).push(s);
    }
    for (const m of [...machines.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))) section(m, machines.get(m));
    if (machines.has("")) section(T.other, machines.get(""));
    const hidden = view.list.filter((s) => s.hidden).length;
    if (!q && hidden) rows.append($("p", "hint", T.hiddenCount(hidden)));
  }

  function detailsScreen(main) {
    const d = view.details;
    if (!d) return main.append($("p", "hint", T.loading));
    main.append($("h1", "title", d.full));
    main.append($("p", "hint", [d.online ? T.detailOnline : T.detailAway, ...(d.machine ? [T.detailOn(d.machine)] : []), d.last_talked ? T.talked(d.last_talked) : T.detailNotTalked].join(" · ")));
    if (d.warning) main.append($("p", "warning", d.warning));
    main.append(button(T.write, () => go("compose"), "btn primary"));
    main.append(button(d.fav ? T.favRemove : T.favAdd, () => setPref(d.h, { fav: !d.fav })));
    const label = $("label", "field", T.nameLabel(d.logical));
    const input = $("input", "name");
    input.type = "text";
    input.maxLength = ALIAS_MAX;
    input.value = view.alias ?? (d.alias || "");
    input.addEventListener("input", () => (view.alias = input.value));
    label.append(input);
    main.append(label);
    const names = $("div", "pair");
    names.append(button(T.save, () => setPref(d.h, { alias: input.value })));
    if (d.alias) names.append(button(T.removeName, () => setPref(d.h, { alias: null })));
    main.append(names);
    main.append(button(d.hidden ? T.unhide : T.hide, () => setPref(d.h, { hidden: !d.hidden })));
  }

  function composeScreen(main) {
    const d = view.details;
    if (!d) return showList();
    const head = $("div", "to");
    head.append($("span", "label", T.to(d.full)), button(T.change, () => showList(), "btn small"));
    const text = $("textarea", "text");
    text.placeholder = T.placeholder;
    text.maxLength = TEXT_MAX;
    text.rows = 8;
    text.value = view.draft;
    const count = $("p", "hint count", T.count(view.draft.length));
    text.addEventListener("input", () => {
      view.draft = text.value;
      count.textContent = T.count(text.value.length);
    });
    main.append(head, text, count, button(T.sendForConfirmation, () => sendDraft(d.h, text.value), "btn primary"));
  }

  function questionsScreen(main) {
    const qs = view.questions;
    if (!qs) return main.append($("p", "hint", T.loading));
    main.append($("h1", "title", qs.length ? T.waiting(qs.length) : T.noQuestions));
    for (const q of qs) {
      const card = $("div", "question");
      card.append($("p", "sub", T.questionHead(q.n, q.asker, q.age)), $("p", "qtext", q.text));
      card.append(button(T.answerInChat, () => showInChat(q.n), "btn primary"));
      main.append(card);
    }
  }

  /** Teams as their leads report them: text only, nothing to tap. */
  function teamsScreen(main) {
    const v = view.teams;
    if (!v) return main.append($("p", "hint", T.loading));
    if (!v.list.length) main.append($("p", "hint", T.noTeams));
    const list = (x) => (Array.isArray(x) ? x : []);
    for (const t of v.list) {
      main.append($("h2", "section", T.teamHead(t.team, t.lead)));
      const where = T.teamWhere(t.status, t.machine);
      if (where) main.append($("p", "hint", where));
      for (const m of list(t.members)) {
        const card = $("div", "member");
        card.append($("p", "label", m.label), $("p", "sub", T.memberSub(m.role, m.cli, m.model, m.effort)), $("p", m.online ? "sub on" : "sub", T.memberWhere(m.state, m.branch, m.online)));
        main.append(card);
      }
      if (t.more) main.append($("p", "hint", T.teamMore(t.more)));
      for (const r of list(t.reviews)) main.append($("p", "sub", T.teamReview(r.member, list(r.waiting).join(", "))));
    }
    if (v.more) main.append($("p", "hint", T.teamsMore(v.more)));
    main.append($("p", "hint", T.teamsReadOnly));
  }

  function render() {
    const main = $("main", `screen ${view.screen}`);
    if (view.screen === "fatal" || view.screen === "done") {
      main.append($("p", "message", view.notice));
      return root.replaceChildren(main);
    }
    if (view.screen === "list" || view.screen === "questions" || view.screen === "teams") root.replaceChildren(tabs(), main);
    else root.replaceChildren(main);
    if (view.notice) main.append($("p", "notice", view.notice));
    if (view.screen === "list") listScreen(main);
    else if (view.screen === "details") detailsScreen(main);
    else if (view.screen === "compose") composeScreen(main);
    else if (view.screen === "questions") questionsScreen(main);
    else if (view.screen === "teams") teamsScreen(main);
  }

  // ---- start ----------------------------------------------------------------------------------

  applyTheme(tg.theme);
  if (!tg.supported) return fatal(T.updateTelegram);
  tg.post("web_app_ready", {});
  tg.post("web_app_expand", {});
  tg.post("web_app_request_theme", {});
  tg.post("web_app_request_viewport", {});
  tg.post("web_app_request_safe_area", {});
  tg.post("web_app_request_content_safe_area", {});
  render();
  openSession().then((ok) => (ok ? showList() : undefined));
})();

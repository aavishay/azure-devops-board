/* DevOps Team Board — browser app. Talks only to this server's /api endpoints. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const WS = window.WORKSTREAMS || { ORDER: ["Other"], OVERRIDES: {}, RULES: [] };
  const DAY = 864e5;
  const store = {
    get(k, d) { try { const v = localStorage.getItem("devops-board:" + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("devops-board:" + k, v); } catch {} },
  };

  let BOARD = null;       // last load_board payload
  let ALL = [];           // every card
  let T = [];             // cards minus hidden people's
  let PARENTS = {};
  const f = { q: "", owner: store.get("owner", "") || null, preset: null, ws: WS.ORDER.includes(store.get("ws", "")) ? store.get("ws", "") : null, types: new Set((() => { try { const v = JSON.parse(store.get("types", "[]")); return Array.isArray(v) ? v : []; } catch { return []; } })()), group: store.get("group", "ws") === "owner" ? "owner" : "ws" };
  // Filters in the order they were turned on, so Escape can take off the latest one.
  const fOrder = [...[...f.types].map((ty) => `type:${ty}`), ...(f.ws ? ["ws"] : []), ...(f.owner !== null ? ["owner"] : [])];
  const fOn = (k, on) => { const i = fOrder.indexOf(k); if (i >= 0) fOrder.splice(i, 1); if (on) fOrder.push(k); };
  let me = store.get("me", "");
  // People whose tickets are left off the board ("—" is Unassigned), remembered across restarts.
  const hidden = new Set((() => { try { const v = JSON.parse(store.get("hidden", "[]")); return Array.isArray(v) ? v : []; } catch { return []; } })());
  const visible = () => ALL.filter((t) => !hidden.has(t.owner || "—"));
  function setHidden(name, on) {
    if (name === null) hidden.clear(); else if (on) hidden.add(name); else hidden.delete(name);
    store.set("hidden", JSON.stringify([...hidden]));
    if (on && f.owner === name) { f.owner = null; saveFilters(); }
    T = visible();
    render();
  }

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (n) => (n ? n.slice(0, 2).toUpperCase() : "?");
  function colorFor(n) { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 42%)`; }
  function fmt(ts) {
    try {
      return new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: BOARD?.timeZone || undefined });
    } catch { return new Date(ts).toLocaleString(); }
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: BOARD?.timeZone || undefined }); }
    catch { return new Date(ts).toLocaleTimeString(); }
  }
  function guessWs(id, parent, title) {
    if (WS.OVERRIDES[id]) return WS.OVERRIDES[id];
    if (parent && WS.OVERRIDES[parent]) return WS.OVERRIDES[parent];
    for (const [name, re] of WS.RULES) if (re.test(title)) return name;
    return "Other";
  }
  const label = (o) => (o ? (o === me ? "You" : o) : "Unassigned");

  /* ---------- data → cards ---------- */
  function compose(snap) {
    const now = Date.now();
    PARENTS = snap.parents || {};
    const items = snap.items || [];
    // Items Azure DevOps links as duplicates fold into their original's card (following chains, guarding loops).
    const byId = new Map(items.map((it) => [it.id, it]));
    const rootOf = (it) => {
      const seen = new Set();
      while (it.duplicateOf && byId.has(it.duplicateOf) && !seen.has(it.id)) { seen.add(it.id); it = byId.get(it.duplicateOf); }
      return it;
    };
    const dups = new Map();
    for (const it of items) {
      const root = rootOf(it);
      if (root !== it) dups.set(root.id, [...(dups.get(root.id) || []), it]);
    }
    return items.filter((it) => rootOf(it) === it).map((it) => ({
      ...it,
      dups: dups.get(it.id) || [],
      committed: it.rawState === "Committed",
      ws: guessWs(it.id, it.parent, it.title),
      isNew: !!it.firstSeen && now - it.firstSeen < DAY,
      orphan: it.type === "Task" && !it.parent,
    }));
  }

  /* ---------- filters ---------- */
  const presets = {
    mine: { n: (t) => !!me && t.owner === me, label: "Assigned to you" },
    inc: { n: (t) => t.type === "Incident", label: "Open incidents", cls: "crit" },
    p1: { n: (t) => t.p === 1, label: "Priority 1", cls: "warn" },
    unas: { n: (t) => !t.owner, label: "Unassigned", cls: "warn" },
    fresh: { n: (t) => t.isNew, label: "Added (24 h)" },
  };
  // Tags matching the search, to match on and to show on the card.
  const tagHits = (x, q) => (q ? (x.tags || []).filter((g) => g.toLowerCase().includes(q)) : []);
  function match(t) {
    if (f.owner !== null && (t.owner || "—") !== f.owner) return false;
    if (f.preset && !presets[f.preset].n(t)) return false;
    if (f.ws && t.ws !== f.ws) return false;
    if (f.types.size && !f.types.has(t.type)) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const hit = (x) => x.title.toLowerCase().includes(q) || String(x.id).includes(q) || tagHits(x, q).length;
      if (!hit(t) && !t.dups.some(hit)) return false;
    }
    return true;
  }
  const fActive = (k) => (k === "q" ? !!f.q : k === "owner" ? f.owner !== null : k === "preset" ? !!f.preset : k === "ws" ? !!f.ws : f.types.has(k.slice(5)));
  /** Takes off the filter turned on last; false when none is on. */
  function clearLastFilter() {
    while (fOrder.length && !fActive(fOrder[fOrder.length - 1])) fOrder.pop();
    const k = fOrder.pop();
    if (!k) return false;
    if (k === "q") { f.q = ""; $("q").value = ""; }
    else if (k === "owner") f.owner = null;
    else if (k === "preset") f.preset = null;
    else if (k === "ws") f.ws = null;
    else f.types.delete(k.slice(5));
    saveFilters();
    render();
    return true;
  }
  const saveFilters = () => { store.set("types", JSON.stringify([...f.types])); store.set("ws", f.ws || ""); store.set("owner", f.owner || ""); };
  const rank = (t) => (t.p === 1 ? 0 : 10) + (t.type === "Incident" ? 0 : 5) + (me && t.owner === me ? 0 : 1);

  /* ---------- rendering ---------- */
  function card(t) {
    const kind = { Incident: "incident", PBI: "pbi", Task: "task", Bug: "bug" }[t.type] || "other";
    const mine = !!me && t.owner === me;
    const flags =
      (t.committed ? `<span class="flag">Committed</span>` : "") +
      (t.orphan ? `<span class="flag" title="Task without a parent PBI">No parent</span>` : "") +
      (t.isNew ? `<span class="flag fresh" title="Appeared on the board in the last 24 hours">Added</span>` : "");
    const owner = t.owner
      ? `<span class="owner${mine ? " me" : ""}" title="${esc(t.ownerFull || t.owner)}"><span class="av" style="background:${colorFor(t.owner)}">${esc(initials(t.owner))}</span>${esc(label(t.owner))}</span>`
      : `<span class="owner unassigned"><span class="av none">?</span>Unassigned</span>`;
    const creator = t.creator
      ? `<span class="by${t.creator === me ? " me" : ""}" title="Created by ${esc(t.creatorFull || t.creator)}">by ${esc(t.creator === me ? "you" : t.creator)}</span>`
      : "";
    const par = t.parent ? PARENTS[t.parent] : null;
    const parentLine = t.parent
      ? `<div class="parent">↳ <a href="${esc(par?.url || "#")}" target="_blank" rel="noopener" data-ticket="${esc(t.parent)}">#${esc(t.parent)}</a> ${esc(par?.title || "Parent PBI")}${par?.state ? ` <span class="ps">(${esc(par.state)})</span>` : ""}</div>`
      : "";
    const dupLines = t.dups.map((d) =>
      `<div class="dup" title="Linked in Azure DevOps as a duplicate of #${esc(t.id)}">Duplicate <a href="${esc(d.url)}" target="_blank" rel="noopener" data-ticket="${esc(d.id)}">#${esc(d.id)}</a> ${esc(d.title)}${d.rawState !== t.rawState ? ` <span class="ps">(${esc(d.rawState)})</span>` : ""}</div>`).join("");
    const open = TK?.id === t.id && $("ticket").open;
    const hits = tagHits(t, f.q.toLowerCase());
    const tags = hits.length ? `<div class="tags">${hits.map((g) => `<span class="tag">${esc(g)}</span>`).join(" ")}</div>` : "";
    return `<article class="card k-${kind}${t.p === 1 ? " p1" : ""}${mine ? " mine" : ""}${open ? " is-open" : ""}" data-ticket="${esc(t.id)}" tabindex="0" aria-label="Open #${esc(t.id)}: ${esc(t.title)}">
      <div class="tab"><a class="id" href="${esc(t.url)}" target="_blank" rel="noopener" data-ticket="${esc(t.id)}" title="Open here; Cmd/Ctrl-click opens Azure DevOps">${esc(t.id)}</a><span class="kind">${esc(t.type)}</span>${flags}<span class="pri${t.p === 1 ? " p1" : ""}" title="Priority ${esc(t.p)}">P${esc(t.p)}</span></div>
      <div class="body">
        <div class="title">${esc(t.title)}</div>
        ${dupLines}${parentLine}
        ${tags}<div class="foot">${owner}${creator}${f.group === "ws" ? "" : `<span class="ws">${esc(t.ws)}</span>`}</div>
      </div>
    </article>`;
  }

  function renderLane(state) {
    const el = $("lane-" + state), cEl = $("c-" + state);
    const items = T.filter((t) => t.state === state);
    const shown = items.filter(match);
    cEl.textContent = shown.length === items.length ? `${items.length}` : `${shown.length} of ${items.length}`;
    if (!shown.length) { el.innerHTML = `<div class="empty">${items.length ? "No tickets match these filters." : "Nothing here."}</div>`; return; }
    let html = "";
    if (f.group === "owner") {
      const owners = [...new Set(shown.map((t) => t.owner || ""))].sort((a, b) => {
        const k = (n) => (n === me && n ? "0" : n === "" ? "~" : "1" + n);
        return k(a).localeCompare(k(b));
      });
      for (const o of owners) {
        const g = shown.filter((t) => (t.owner || "") === o).sort((a, b) => rank(a) - rank(b) || WS.ORDER.indexOf(a.ws) - WS.ORDER.indexOf(b.ws) || b.id - a.id);
        html += `<div class="group-label"><span>${esc(label(o || null))}</span><span>${g.length}</span></div><div class="cards">${g.map(card).join("")}</div>`;
      }
    } else {
      const order = [...WS.ORDER, ...new Set(shown.map((t) => t.ws).filter((w) => !WS.ORDER.includes(w)))];
      for (const ws of order) {
        const g = shown.filter((t) => t.ws === ws).sort((a, b) => rank(a) - rank(b) || b.id - a.id);
        if (!g.length) continue;
        html += `<div class="group-label"><span>${esc(ws)}</span><span>${g.length}</span></div><div class="cards">${g.map(card).join("")}</div>`;
      }
    }
    el.innerHTML = html;
  }

  function renderStats() {
    const keys = [me ? "mine" : "fresh", "inc", "p1", "unas"];
    const tiles = [
      ...(BOARD?.newLane ? [`<div class="stat" style="cursor:default"><span class="n">${T.filter((t) => t.state === "new").length}</span><span class="l">New</span></div>`] : []),
      `<div class="stat" style="cursor:default"><span class="n">${T.filter((t) => t.state === "todo").length}</span><span class="l">To Do &amp; Committed</span></div>`,
      `<div class="stat" style="cursor:default"><span class="n">${T.filter((t) => t.state === "doing").length}</span><span class="l">In Progress</span></div>`,
      ...keys.map((k) => { const p = presets[k]; return `<button class="stat ${p.cls || ""}" type="button" data-preset="${k}" aria-pressed="${f.preset === k}"><span class="n">${T.filter(p.n).length}</span><span class="l">${p.label}</span></button>`; }),
    ];
    $("stats").innerHTML = tiles.join("");
  }

  function renderLoad() {
    const names = [...new Set(T.map((t) => t.owner || "—"))];
    const data = names.map((n) => {
      const mine = T.filter((t) => (t.owner || "—") === n);
      return { n, inc: mine.filter((t) => t.type === "Incident").length, fresh: mine.filter((t) => t.state === "new" && t.type !== "Incident").length, todo: mine.filter((t) => t.state === "todo" && t.type !== "Incident").length, doing: mine.filter((t) => t.state === "doing" && t.type !== "Incident").length, total: mine.length };
    }).sort((a, b) => b.total - a.total);
    const max = Math.max(1, ...data.map((d) => d.total));
    const w = (v) => `${(v / max) * 100}%`;
    $("load").innerHTML = data.map((d) => {
      const lb = d.n === "—" ? "Unassigned" : label(d.n);
      return `<div class="row-wrap"><button class="row" type="button" data-owner="${esc(d.n)}" aria-pressed="${f.owner === d.n}" title="${esc(lb)}: ${d.inc} incidents, ${d.fresh} other new, ${d.todo} other to do, ${d.doing} in progress">
        <span class="who">${esc(lb)}</span>
        <span class="bar"><span style="width:${w(d.inc)};background:var(--crit)"></span><span class="new" style="width:${w(d.fresh)}"></span><span style="width:${w(d.todo)};background:var(--todo)"></span><span style="width:${w(d.doing)};background:var(--doing)"></span></span>
        <span class="c">${d.total}</span></button><button class="hide-btn" type="button" data-hide="${esc(d.n)}" aria-label="Hide ${esc(lb)}'s tickets" title="Hide ${esc(lb)}'s tickets from the board">Hide</button></div>`;
    }).join("");
    const hid = [...hidden].filter((n) => ALL.some((t) => (t.owner || "—") === n)).sort();
    $("hiddenOwners").hidden = !hid.length;
    $("hiddenOwners").innerHTML = hid.length
      ? `<span>Hidden:</span>${hid.map((n) => { const lb = n === "—" ? "Unassigned" : label(n); return `<button class="chip" type="button" data-unhide="${esc(n)}" aria-label="Show ${esc(lb)}'s tickets again" title="Show ${esc(lb)}'s tickets again">${esc(lb)} ×</button>`; }).join("")}${hid.length > 1 ? `<button class="clear" type="button" data-unhide="">Show all</button>` : ""}`
      : "";
  }

  function renderChips() {
    const types = [["", "All types"], ["Incident", "Incidents"], ["PBI", "PBIs"]];
    if (T.some((t) => t.type === "Bug")) types.push(["Bug", "Bugs"]);
    if (T.some((t) => t.type === "Task")) types.push(["Task", "Tasks"]);
    for (const t of new Set(T.map((x) => x.type))) if (!types.some(([k]) => k === t)) types.push([t, t + "s"]);
    const seg = `<div class="seg" role="group" aria-label="Work item type">${types.map(([k, l]) => {
      const n = k ? T.filter((t) => t.type === k).length : T.length;
      return `<button type="button" data-chip="type:${esc(k)}" aria-pressed="${k ? f.types.has(k) : !f.types.size}">${esc(l)} <span class="n">${n}</span></button>`;
    }).join("")}</div>`;
    const grp = `<div class="seg" role="group" aria-label="Group cards by"><button type="button" disabled style="cursor:default;color:var(--muted)">Group by</button>${[["ws", "Workstream"], ["owner", "Person"]].map(([k, l]) => `<button type="button" data-group="${k}" aria-pressed="${f.group === k}">${l}</button>`).join("")}</div>`;
    const chips = [["fresh", "Added"], ...WS.ORDER.map((w) => ["ws:" + w, w])];
    $("typeChips").innerHTML = seg + grp + chips.map(([k, l]) => {
      const on = k.startsWith("ws:") ? f.ws === k.slice(3) : f.preset === k;
      return `<button class="chip" type="button" data-chip="${esc(k)}" aria-pressed="${on}">${esc(l)}</button>`;
    }).join("");
  }

  function renderMe() {
    const sel = $("me");
    const owners = [...new Set(ALL.map((t) => t.owner).filter(Boolean))].sort();
    if (me && !owners.includes(me)) owners.unshift(me);
    sel.innerHTML = `<option value="">—</option>` + owners.map((o) => `<option value="${esc(o)}"${o === me ? " selected" : ""}>${esc(o)}</option>`).join("");
  }

  function renderHistory() {
    const h = BOARD?.history || [];
    $("historyBox").hidden = !h.length;
    $("historyCount").textContent = h.length;
    const what = (c) =>
      c.kind === "added" ? `Appeared in ${esc(c.to)}`
      : c.kind === "removed" ? `Left the board (was ${esc(c.from)})`
      : c.kind === "state" ? `${esc(c.from)} → ${esc(c.to)}`
      : c.kind === "owner" ? `${esc(c.from || "Unassigned")} → ${esc(c.to || "Unassigned")}`
      : "";
    $("history").innerHTML = h.map((c) => {
      return `<li><time>${esc(fmt(c.at))}</time>${ticketLink(c.id, undefined, "hid")}<span class="what ${esc(c.kind)}">${what(c)}</span><span class="tt" title="${esc(c.title)}">${esc(c.title)}</span></li>`;
    }).join("");
  }

  function renderStatus() {
    const s = BOARD?.snapshot;
    const err = BOARD?.lastError;
    if (!s) {
      $("stamp").textContent = err ? "Could not load from Azure DevOps" : "Loading from Azure DevOps…";
      $("dot").className = err ? "dot err" : "dot stale";
    } else {
      const ts = Date.parse(s.updatedAt);
      const next = BOARD.nextAutoAt ? ` · next auto ${fmtTime(BOARD.nextAutoAt)}` : "";
      $("stamp").textContent = `Updated ${fmt(ts)}${next}`;
      const stale = Date.now() - ts > Math.max(3, BOARD.refreshMinutes * 3) * 60e3;
      $("dot").className = err && Date.parse(err.at) > ts ? "dot err" : stale ? "dot stale" : "dot";
    }
    $("scope").textContent = `Shows tickets touched in the last ${BOARD?.lookbackDays ?? 60} days`;
    if (err && (!s || Date.parse(err.at) > Date.parse(s.updatedAt))) {
      notice("err", `<b>Last refresh failed</b> at ${esc(fmt(err.at))}: ${esc(err.message)}${s ? " The board shows the last good data." : ""}`, "err");
    }
  }

  function render() {
    renderStatus(); renderMe(); renderStats(); renderLoad(); renderChips();
    $("laneNew").hidden = !BOARD?.newLane;
    $("board").classList.toggle("three", !!BOARD?.newLane);
    if (BOARD?.newLane) renderLane("new");
    renderLane("todo"); renderLane("doing"); renderHistory();
  }

  let noticeKey = "";
  function notice(kind, html, key = "") {
    const n = $("notice"); n.className = "notice " + kind; n.hidden = false; noticeKey = key;
    n.innerHTML = `<div>${html}</div><button class="x" type="button" aria-label="Dismiss">×</button>`;
    n.querySelector(".x").onclick = () => { n.hidden = true; };
  }
  function clearErrorNotice() { if (noticeKey === "err") $("notice").hidden = true; }

  // A ticket number that opens the ticket in the drawer; Cmd/Ctrl-click opens Azure DevOps.
  function ticketUrl(id) { return ALL.find((t) => t.id === id)?.url || (BOARD?.boardUrl || "").replace(/_boards.*$/, "") + "_workitems/edit/" + id; }
  function ticketLink(id, url = ticketUrl(id), cls = "") { return `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" target="_blank" rel="noopener" data-ticket="${esc(id)}">#${esc(id)}</a>`; }

  function changesHtml(changes) {
    const n = (c) => `<b>${ticketLink(c.id)}</b>`;
    const t = (c) => c.kind === "added" ? `${n(c)} appeared: ${esc(c.title)}`
      : c.kind === "removed" ? `${n(c)} left the board: ${esc(c.title)}`
      : c.kind === "state" ? `${n(c)} ${esc(c.from)} → ${esc(c.to)}`
      : `${n(c)} owner ${esc(c.from || "unassigned")} → ${esc(c.to || "unassigned")}`;
    return `<ul>${changes.slice(0, 12).map((c) => `<li>${t(c)}</li>`).join("")}</ul>${changes.length > 12 ? `…and ${changes.length - 12} more` : ""}`;
  }

  /* ---------- server bridge: POST /api/<command> to the local azure-devops-board server ---------- */
  // The command opens /#t=<token>. The token is kept in this origin's storage (browsers keep
  // that per port, unlike cookies), dropped from the address bar, and sent with every call.
  let TOKEN = store.get("token", "");
  function takeToken() {
    const m = location.hash.match(/^#t=([\w-]+)$/);
    if (!m) return false;
    TOKEN = m[1];
    store.set("token", TOKEN);
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  }
  takeToken();
  // The same address opened again in this tab only changes the fragment, without a reload.
  window.addEventListener("hashchange", () => { if (takeToken()) location.reload(); });
  // Failures reject with the server's message string, which the callers show as is.
  async function invoke(cmd, args) {
    let res;
    try {
      res = await fetch(`/api/${cmd}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Board": TOKEN },
        body: JSON.stringify(args || {}),
      });
    } catch {
      throw "The board isn't running. Start it again by running azure-devops-board in a terminal.";
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw j.error || `Request failed (HTTP ${res.status}).`;
    return j;
  }

  /* ---------- data loading ---------- */
  let AUTH = null;
  let autoTimer = null, nextAutoAt = 0, refreshing = false;

  async function load({ announce = false } = {}) {
    const prevTs = BOARD?.snapshot?.updatedAt;
    BOARD = await invoke("load_board");
    BOARD.nextAutoAt = nextAutoAt ? new Date(nextAutoAt).toISOString() : null;
    document.title = BOARD.title;
    $("title").textContent = BOARD.title;
    $("subtitle").textContent = BOARD.subtitle;
    $("adoLink").href = BOARD.boardUrl;
    if (!store.get("me", "") && BOARD.user) { me = BOARD.user.split(/\s+/)[0]; store.set("me", me); }
    ALL = BOARD.snapshot ? compose(BOARD.snapshot) : [];
    T = visible();
    // A remembered person with nothing on the board would leave both lanes empty.
    if (BOARD.snapshot && f.owner !== null && !T.some((t) => (t.owner || "—") === f.owner)) f.owner = null;
    if (BOARD.snapshot && (!BOARD.lastError || Date.parse(BOARD.lastError.at) < Date.parse(BOARD.snapshot.updatedAt))) clearErrorNotice();
    const ch = BOARD.snapshot?.changes || [];
    if (announce && prevTs && prevTs !== BOARD.snapshot?.updatedAt && ch.length) {
      notice("ok", `<b>Board updated.</b> ${ch.length} change${ch.length > 1 ? "s" : ""}:${changesHtml(ch)}`);
    }
    render();
    if (!BOARD.snapshot) renderWelcome();
  }

  function renderWelcome() {
    const signedIn = AUTH?.signedIn;
    const msg = !BOARD?.configured
      ? `<h2>Set up the board</h2><p>Enter your Azure DevOps organization and project.</p><button class="btn primary" type="button" data-open="settings">Open settings</button>`
      : !signedIn
      ? `<h2>Sign in to Azure DevOps</h2><p>Use your Microsoft account or a Personal Access Token.</p><button class="btn primary" type="button" data-open="signin">Sign in</button>`
      : refreshing ? `<h2>Loading tickets…</h2>` : `<h2>No data yet</h2><p>Press Refresh to load the board.</p>`;
    $("lane-todo").innerHTML = `<div class="welcome">${msg}</div>`;
    $("lane-new").innerHTML = $("lane-doing").innerHTML = "";
  }

  let refreshAgain = null; // a refresh asked for while one runs, that must not be dropped
  async function refresh(reason = "manual") {
    if (refreshing) { if (reason === "created" || reason === "edited") refreshAgain = reason; return; }
    refreshing = true;
    const btn = $("refresh");
    btn.disabled = true; btn.classList.add("busy"); $("refreshLabel").textContent = "Refreshing…";
    if (!BOARD?.snapshot) renderWelcome();
    try {
      const j = await invoke("refresh_board", { reason });
      if (!j.ok) {
        const needsLogin = /sign|PAT|Unauthorized|token/i.test(j.error || "");
        notice("err", `<b>Refresh failed.</b> ${esc(j.error)}${BOARD?.snapshot ? " The board still shows the last good data." : ""}${needsLogin ? ` <button class="linkbtn" type="button" data-open="signin">Sign in</button>` : ""}`, "err");
      } else if (j.skipped) {
        // ignore double clicks
      } else if (reason === "manual") {
        notice("ok", j.changes?.length ? `<b>Refreshed.</b> ${j.changes.length} change${j.changes.length > 1 ? "s" : ""}:${changesHtml(j.changes)}` : "<b>Refreshed.</b> No changes since the last update.");
      } else if (j.changes?.length && reason === "auto") {
        notice("ok", `<b>Board updated.</b> ${j.changes.length} change${j.changes.length > 1 ? "s" : ""}:${changesHtml(j.changes)}`);
      }
      await refreshAuth();
      await load();
    } catch (e) {
      notice("err", `<b>Refresh failed.</b> ${esc(e?.message || e)}`, "err");
    } finally {
      refreshing = false;
      btn.disabled = false; btn.classList.remove("busy"); $("refreshLabel").textContent = "Refresh";
      scheduleAuto();
      renderStatus();
      if (refreshAgain) { const r = refreshAgain; refreshAgain = null; refresh(r); }
    }
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    const mins = BOARD?.refreshMinutes || 10;
    nextAutoAt = Date.now() + mins * 60e3;
    if (BOARD) BOARD.nextAutoAt = new Date(nextAutoAt).toISOString();
    autoTimer = setTimeout(() => { if (AUTH?.signedIn) refresh("auto"); else scheduleAuto(); }, mins * 60e3);
  }

  /* ---------- account ---------- */
  async function refreshAuth() {
    try { AUTH = await invoke("auth_status"); } catch { AUTH = null; }
    const name = AUTH?.user || BOARD?.user;
    $("accountLabel").textContent = AUTH?.signedIn ? (name || (AUTH.mode === "pat" ? "Signed in (token)" : "Signed in")) : "Sign in";
    $("acctDot").className = "acct-dot" + (AUTH?.signedIn ? " on" : "");
    $("accountBtn").title = AUTH?.signedIn ? `Signed in${name ? " as " + name : ""} with ${AUTH.mode === "pat" ? "a Personal Access Token" : "Microsoft"}` : "Sign in to Azure DevOps";
  }

  function showErr(id, msg) { const el = $(id); el.textContent = msg || ""; el.hidden = !msg; }

  async function openSignIn() {
    await refreshAuth();
    const s = await invoke("get_settings").catch(() => null);
    $("signinOrg").textContent = s ? `Organization: ${s.org || "—"}` : "";
    $("msHint").hidden = !!AUTH?.microsoftReady;
    $("msBtn").disabled = !AUTH?.microsoftReady;
    $("msWaiting").hidden = true;
    $("signOutBtn").hidden = !(AUTH?.hasPat || AUTH?.hasMicrosoft);
    $("pat").value = "";
    showErr("signinErr", "");
    if (!$("signin").open) $("signin").showModal();
  }

  async function signInMicrosoft() {
    showErr("signinErr", "");
    $("msBtn").disabled = true; $("msWaiting").hidden = false;
    try {
      AUTH = await invoke("sign_in_microsoft");
      $("signin").close();
      notice("ok", `<b>Signed in${AUTH.user ? " as " + esc(AUTH.user) : ""}.</b>`);
      await refreshAuth();
      refresh("startup");
    } catch (e) {
      showErr("signinErr", String(e?.message || e));
    } finally {
      $("msBtn").disabled = !AUTH?.microsoftReady; $("msWaiting").hidden = true;
    }
  }

  async function savePat() {
    showErr("signinErr", "");
    const btn = $("patBtn"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      AUTH = await invoke("save_pat", { pat: $("pat").value });
      $("pat").value = "";
      $("signin").close();
      notice("ok", `<b>Signed in${AUTH.user ? " as " + esc(AUTH.user) : ""}</b> with a Personal Access Token.`);
      await refreshAuth();
      refresh("startup");
    } catch (e) {
      showErr("signinErr", String(e?.message || e));
    } finally { btn.disabled = false; btn.textContent = "Save token"; }
  }

  async function signOut() {
    AUTH = await invoke("sign_out");
    await refreshAuth();
    $("signOutBtn").hidden = true;
    notice("ok", "Signed out. Your saved token or Microsoft sign-in was removed from this computer.");
  }

  /* ---------- new ticket ---------- */
  let TYPES = null; // the project's creatable work item types, loaded on first use
  const DEFAULT_TYPES = ["Product Backlog Item", "User Story", "Requirement", "Issue"];
  const REPRO = "Microsoft.VSTS.TCM.ReproSteps";
  // "Alex Doe (Contractor)" and "Alex Doe <alex@…>" are both Alex Doe, as the server cleans owners.
  const plainName = (n) => String(n || "").replace(/[(<][^)>]*[)>]/g, "").replace(/\s+/g, " ").trim();

  /** [value, label] pairs: Unassigned, you, then everyone on the board, by the sign-in
   *  name that assigns to them unambiguously. `extra` ({name, unique}) is added if missing. */
  function peopleOptions(extra) {
    const people = new Map();
    for (const t of ALL) if (t.ownerFull) people.set(t.ownerFull, t.ownerUnique || t.ownerFull);
    if (extra?.name && !people.has(extra.name)) people.set(extra.name, extra.unique || extra.name);
    const mine = plainName(BOARD?.user);
    const meValue = people.get(mine) || BOARD?.user || "";
    people.delete(mine);
    return [["", "Unassigned"], ...(meValue ? [[meValue, `Me (${mine})`]] : []),
      ...[...people].sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => [v, n])];
  }

  /* ---------- pickers: type to find a person, or an iteration ---------- */
  // Markup: a text box the user types in, a hidden input holding the chosen value
  // ("" is Unassigned for people), and the suggestion list. initPicker() wires it up
  // with a source of choices: {list(), remote?(q), cache?, free?(text), empty?, ready?}.
  // With `pick(value)` the picker adds to a list instead of holding a value: choosing
  // hands the value over and empties the box, and only an exact name counts as a match.
  let pickN = 0;
  const pickerHtml = (hidden, value, label, placeholder = "Unassigned · type a name or email") => {
    const id = `pick${++pickN}`;
    return `<div class="pick"><input type="text" class="pick-in" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(label)}">`
      + `<input type="hidden" ${hidden} value="${esc(value)}" data-was="${esc(value)}"><ul class="pick-list" id="${id}" role="listbox" hidden></ul></div>`;
  };
  const norm = (x) => String(x || "").toLowerCase();
  const SEARCHED = new Map(); // query -> people found in the organization
  const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  // People: everyone on the board, then whoever the organization search finds; an email is taken as typed.
  const peopleSource = (extra) => ({
    list: () => peopleOptions(extra).map(([value, label]) => ({ value, label, note: value && norm(value) !== norm(label) && !label.startsWith("Me (") ? value : "" })),
    cache: SEARCHED,
    remote: async (q) => (await invoke("search_people", { query: q })).map((p) => ({ value: p.unique, label: p.name, note: p.unique })),
    free: (t) => EMAIL.test(t),
    empty: true,
    none: "No one found",
  });
  function initPicker(root, src) {
    const input = root.querySelector(".pick-in"), hidden = root.querySelector("input[type=hidden]"), list = root.querySelector(".pick-list");
    let shown = [], active = -1, timer = 0, label = input.value;
    // Every word typed has to appear somewhere in the name, value or note.
    const candidates = (q) => {
      const all = src.list();
      for (const p of src.cache?.get(norm(q)) || []) if (!all.some((x) => norm(x.value) === norm(p.value))) all.push(p);
      const words = norm(q).split(/\s+/).filter(Boolean);
      if (!words.length) return all;
      return all.filter((x) => { const hay = norm(`${x.label} ${x.value} ${x.note || ""}`); return x.value && words.every((w) => hay.includes(w)); });
    };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
    const paint = () => {
      const q = input.value.trim() === label ? "" : input.value.trim();
      shown = candidates(q).slice(0, 60);
      if (src.pick && q && src.free?.(q) && !shown.some((x) => norm(x.value) === norm(q))) shown.push({ value: q, label: q, note: "new tag" });
      if (!shown.length) {
        const msg = src.failed ? src.failed : src.loading ? "Loading…" : !src.remote || q.length < 2 ? "No match" : src.cache.has(norm(q)) ? src.none : "Searching…";
        list.innerHTML = `<li class="pick-none">${esc(msg)}</li>`;
      }
      else list.innerHTML = shown.map((x, i) => `<li role="option" id="${list.id}-${i}" data-i="${i}"${i === active ? ` class="on" aria-selected="true"` : ""}${x.value === hidden.value ? ` data-cur` : ""}>${esc(x.label)}${x.note ? ` <span class="muted">${esc(x.note)}</span>` : ""}</li>`).join("");
      list.hidden = false; input.setAttribute("aria-expanded", "true");
      if (active >= 0) { input.setAttribute("aria-activedescendant", `${list.id}-${active}`); list.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }
    };
    const choose = (x) => {
      if (src.pick) { if (x.value) src.pick(x.value); input.value = label = ""; active = -1; return paint(); }
      label = x.value ? x.label : "";
      input.value = label;
      if (hidden.value !== x.value) { hidden.value = x.value; hidden.dispatchEvent(new Event("change", { bubbles: true })); }
      close();
    };
    // What a typed text means when the user leaves the box without picking from the list.
    const settle = () => {
      const t = input.value.trim();
      if (t === label) return;
      if (!t) { if (src.empty) choose({ value: "", label: "" }); else input.value = label; return; }
      const found = candidates(t).filter((x) => x.value);
      const hit = found.find((x) => norm(x.label) === norm(t) || norm(x.value) === norm(t)) || (found.length === 1 && !src.pick ? found[0] : null);
      if (hit) return choose(hit);
      if (src.free?.(t)) return choose({ value: t, label: t });
      input.value = label; // nothing matches: keep what was there
    };
    const search = (q) => {
      clearTimeout(timer);
      if (!src.remote || q.length < 2 || src.cache.has(norm(q))) return;
      timer = setTimeout(async () => {
        try { src.cache.set(norm(q), await src.remote(q)); } catch { src.cache.set(norm(q), []); }
        if (document.activeElement === input && input.value.trim() === q) paint();
      }, 250);
    };
    input.addEventListener("focus", () => {
      input.select(); active = -1; paint();
      src.ready?.then(() => { if (document.activeElement === input) paint(); });
    });
    input.addEventListener("input", () => {
      // Adding to a list: a comma or semicolon (typed or pasted) ends each entry.
      if (src.pick && /[;,]/.test(input.value)) {
        const parts = input.value.split(/[;,]/);
        input.value = parts.pop();
        for (const v of parts.map((x) => x.trim()).filter(Boolean)) src.pick(v);
      }
      active = -1; paint(); search(input.value.trim());
    });
    input.addEventListener("blur", () => { settle(); close(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) paint();
        if (shown.length) { active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length; paint(); }
      } else if (e.key === "Enter") {
        // Enter picks the highlighted choice; otherwise it settles what was typed (and a form may submit).
        if (!list.hidden && active >= 0 && shown[active]) { e.preventDefault(); choose(shown[active]); }
        else { if (!list.hidden) e.preventDefault(); settle(); close(); }
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault(); e.stopPropagation(); input.value = label; close();
      } else if (src.pick && (e.key === "," || e.key === ";")) {
        e.preventDefault(); settle();
      } else if (src.pick && e.key === "Backspace" && !input.value && src.unpick) {
        e.preventDefault(); src.unpick(); paint();
      }
    });
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
    list.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) choose(shown[Number(li.dataset.i)]); });
    root.pickSet = (value) => {
      const x = candidates("").find((c) => norm(c.value) === norm(value)) || { value, label: value };
      label = x.value ? x.label : ""; input.value = label; hidden.value = value;
    };
  }

  // Iterations: loaded once, listed current sprint first, then the coming ones, then the
  // rest (undated ones in tree order, past sprints latest first).
  // Area and iteration paths: each list is loaded once, the first time a picker needs it.
  const NODES = {}, NODE_LOAD = {};
  function nodeSource(cmd, cur, shape) {
    const src = {
      list: () => {
        const all = (NODES[cmd] || []).map(shape);
        if (cur && !all.some((x) => x.value === cur)) all.unshift({ value: cur, label: cur, note: "" });
        return all;
      },
      loading: !NODES[cmd],
    };
    if (!NODES[cmd]) {
      src.ready = (NODE_LOAD[cmd] ||= invoke(cmd).then((v) => { NODES[cmd] = cmd === "iterations" ? sortIters(v) : v; }).finally(() => { delete NODE_LOAD[cmd]; }))
        .then(() => { src.loading = false; }, (e) => { src.loading = false; src.failed = `Couldn't load the ${cmd}: ${e?.message || e}`; });
    }
    return src;
  }
  // Iterations: current sprint first, then the coming ones, then the rest (undated ones
  // in tree order, past sprints latest first). Areas: in tree order.
  const iterSource = (cur) => nodeSource("iterations", cur, (i) => ({ value: i.path, label: i.path, note: iterNote(i) }));
  const areaSource = (cur) => nodeSource("areas", cur, (a) => ({ value: a, label: a, note: BOARD?.areaPath && onBoard(a) ? "on this board" : "" }));
  // Tags: the project's, plus any on the board, minus the ticket's own; new ones allowed.
  const tagSource = () => {
    const src = nodeSource("tags", "", (n) => ({ value: n, label: n }));
    const project = src.list;
    src.list = () => {
      const seen = new Set(tkTags.map(norm)), out = [];
      for (const g of [...project().map((x) => x.value), ...ALL.flatMap((t) => t.tags || [])]) if (!seen.has(norm(g))) { seen.add(norm(g)); out.push({ value: g, label: g }); }
      return out.sort((a, b) => a.label.localeCompare(b.label));
    };
    src.free = (t) => !/[;,]/.test(t);
    src.pick = (g) => tkSetTags([...tkTags, g]);
    src.unpick = () => tkSetTags(tkTags.slice(0, -1));
    return src;
  };
  // The board shows its area path and everything under it.
  const onBoard = (a) => { const b = norm(BOARD?.areaPath); return !b || norm(a) === b || norm(a).startsWith(`${b}\\`); };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  function iterNote(i) {
    if (!i.start || !i.finish) return "";
    const now = today();
    return `${day(i.start)} – ${day(i.finish)}${i.start <= now && now <= i.finish ? " · current" : ""}`;
  }
  function sortIters(v) {
    const now = today();
    const when = (i) => (!i.start || !i.finish ? 2 : i.finish < now ? 3 : i.start <= now ? 0 : 1);
    return v.map((i, n) => ({ ...i, n })).sort((a, b) => when(a) - when(b)
      || (when(a) === 1 ? a.start.localeCompare(b.start) : when(a) === 3 ? b.start.localeCompare(a.start) : a.n - b.n));
  }

  function fillTypes() {
    const sel = $("newForm").elements.namedItem("type");
    const want = [store.get("newType", ""), ...DEFAULT_TYPES].find((n) => TYPES.some((t) => t.name === n)) || TYPES[0]?.name;
    sel.innerHTML = TYPES.map((t) => `<option${t.name === want ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    sel.disabled = false;
    typeChanged();
  }

  function typeChanged() {
    const form = $("newForm");
    const ty = TYPES?.find((t) => t.name === form.elements.namedItem("type").value);
    $("descLabel").textContent = ty?.descriptionField === REPRO ? "Repro steps" : "Description";
    form.elements.namedItem("priority").disabled = ty ? !ty.hasPriority : false;
  }

  async function openNewTicket() {
    if (!BOARD?.configured) return openSettings();
    if (!AUTH?.signedIn) return openSignIn();
    const form = $("newForm");
    showErr("newErr", "");
    $("newWhere").textContent = `It goes to ${BOARD.subtitle.replace(/ · Azure Boards$/, "")}, so it shows on this board.`;

    const opts = peopleOptions();
    const lastWho = store.get("newAssignee", "");
    const was = opts.find(([v]) => v && v === lastWho);
    $("newWho").innerHTML = pickerHtml(`name="assignedTo"`, was ? was[0] : "", was ? was[1] : "");
    initPicker($("newWho").querySelector(".pick"), peopleSource());

    $("parentList").innerHTML = ALL.filter((t) => t.type !== "Task").sort((a, b) => b.id - a.id)
      .map((t) => `<option value="${esc(t.id)}">${esc(t.type)} · ${esc(t.title)}</option>`).join("");

    if (TYPES) fillTypes();
    else {
      const sel = form.elements.namedItem("type");
      sel.innerHTML = "<option>Loading…</option>"; sel.disabled = true;
    }
    if (!$("newTicket").open) $("newTicket").showModal();
    form.elements.namedItem("title").focus();
    if (!TYPES) {
      try { TYPES = await invoke("ticket_types"); fillTypes(); }
      catch (e) { showErr("newErr", `Could not load the work item types. ${e?.message || e}`); }
    }
  }

  async function createTicket(ev) {
    ev.preventDefault();
    const form = $("newForm");
    const v = (k) => form.elements.namedItem(k).value;
    const parent = v("parent").trim();
    if (parent && !/^\d+$/.test(parent)) return showErr("newErr", "Parent takes a ticket number, like 1234.");
    if (!TYPES?.length) return showErr("newErr", "The work item types haven't loaded. Close this and try again.");
    const ty = TYPES.find((t) => t.name === v("type"));
    const ticket = {
      type: v("type"), title: v("title"), description: v("description"), assignedTo: v("assignedTo"),
      priority: ty?.hasPriority ? parseInt(v("priority"), 10) : null, parent: parent ? Number(parent) : null,
    };
    const btn = $("newSave"); btn.disabled = true; btn.textContent = "Creating…";
    showErr("newErr", "");
    try {
      const c = await invoke("create_ticket", { ticket });
      store.set("newType", ticket.type); store.set("newAssignee", ticket.assignedTo);
      $("newTicket").close();
      form.reset();
      notice("ok", `<b>Created ${ticketLink(c.id, c.url)}</b> ${esc(c.title)}`);
      refresh("created");
    } catch (e) {
      showErr("newErr", String(e?.message || e));
    } finally { btn.disabled = false; btn.textContent = "Create"; }
  }

  /* ---------- ticket panel ---------- */
  // Azure DevOps rich text is HTML written by anyone with access to the project, so only
  // plain formatting is rebuilt from it: no attributes but link targets, no images (the
  // page's policy blocks other sites' images anyway; they become links), no scripts or forms.
  const RICH = new Set(["P", "BR", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "SUB", "SUP", "UL", "OL", "LI",
    "CODE", "PRE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "HR"]);
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "FRAME", "OBJECT", "EMBED", "SVG", "MATH", "FORM",
    "INPUT", "BUTTON", "SELECT", "TEXTAREA", "LINK", "META", "TITLE", "HEAD", "AUDIO", "VIDEO", "CANVAS"]);
  function webUrl(u) {
    try { const x = new URL(u || "", "invalid:/"); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
  }
  function rich(html) {
    // A DOMParser document is inert: nothing in it runs or loads.
    const src = new DOMParser().parseFromString(String(html || ""), "text/html").body;
    const out = document.createDocumentFragment();
    const link = (href, fill) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; fill(a); return a; };
    const walk = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) { to.append(n.textContent); continue; }
        if (n.nodeType !== Node.ELEMENT_NODE || DROP.has(n.tagName)) continue;
        const tag = n.tagName;
        if (tag === "A") { const href = webUrl(n.getAttribute("href")); if (href) to.append(link(href, (a) => walk(n, a))); else walk(n, to); }
        else if (tag === "IMG") { const href = webUrl(n.getAttribute("src")); if (href) to.append(link(href, (a) => { a.textContent = `[image${n.alt ? ": " + n.alt : ""}]`; })); }
        else if (/^H[1-6]$/.test(tag)) { const d = document.createElement("div"); d.className = "rh"; walk(n, d); to.append(d); }
        else if (RICH.has(tag)) {
          const el = document.createElement(tag);
          for (const k of ["colspan", "rowspan"]) { const v = parseInt(n.getAttribute(k), 10); if (v > 1 && v < 100) el.setAttribute(k, v); }
          walk(n, el); to.append(el);
        } else walk(n, to); // unknown tags keep their text
      }
    };
    walk(src, out);
    return out;
  }

  /* ---------- Markdown: rendered to HTML text here, then cleaned by rich() like any other HTML ---------- */
  const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const MD_BLOCK = /^\s{0,3}(```|~~~|#{1,6}\s|>|([-*_])(\s*\2){2,}\s*$)/;
  function mdInline(text) {
    const codes = [];
    let t = esc(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, (_, pre, url) => `${pre}<a href="${url}">${url}</a>`)
      .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)__(?=\S)([^_\n]+?)__(?!\w)/g, "$1<strong>$2</strong>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(?=\S)([^~\n]+?)~~/g, "<del>$1</del>");
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
  }
  function mdList(lines) {
    const items = [];
    for (const raw of lines) {
      const m = MD_LIST.exec(raw);
      if (m) items.push({ ind: m[1].replace(/\t/g, "    ").length, ord: /\d/.test(m[2]), text: m[3] });
      else if (items.length) items[items.length - 1].text += "\n" + raw.trim();
    }
    const item = (text) => {
      const task = /^\[([ xX])\]\s+/.exec(text);
      const body = text.slice(task ? task[0].length : 0).split("\n").map(mdInline).join("<br>");
      return (task ? (task[1] === " " ? "☐ " : "☑ ") : "") + body;
    };
    const build = (i) => {
      const { ind, ord } = items[i];
      let h = "";
      while (i < items.length && items[i].ind >= ind) {
        const it = items[i++];
        let sub = "";
        while (i < items.length && items[i].ind > ind) { const [x, j] = build(i); sub += x; i = j; }
        h += `<li>${item(it.text)}${sub}</li>`;
      }
      return [ord ? `<ol>${h}</ol>` : `<ul>${h}</ul>`, i];
    };
    let h = "";
    for (let i = 0; i < items.length;) { const [x, j] = build(i); h += x; i = j; }
    return h;
  }
  function md(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => mdInline(c.trim()));
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if ((m = /^\s{0,3}(```|~~~)/.exec(l))) {
        const buf = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) buf.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)[\s#]*$/.exec(l))) {
        out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); i++;
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push("<hr>"); i++;
      } else if (/^\s{0,3}>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`);
      } else if (MD_LIST.test(l)) {
        const buf = [];
        while (i < lines.length && (MD_LIST.test(lines[i]) || (/^\s+\S/.test(lines[i]) && !MD_BLOCK.test(lines[i])))) buf.push(lines[i++]);
        out.push(mdList(buf));
      } else if (l.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || "")) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      } else {
        const buf = [];
        while (i < lines.length && lines[i].trim() && !MD_BLOCK.test(lines[i]) && !(buf.length && MD_LIST.test(lines[i]))) buf.push(lines[i++]);
        out.push(`<p>${buf.map((x) => mdInline(x.trim())).join("<br>")}</p>`);
      }
    }
    return out.join("");
  }
  // Markdown typed into an ordinary (HTML) field arrives as plain text: render it too. Real
  // formatting (bold, lists, links made in the editor) means it's HTML, and stays as it is.
  function looksLikeMarkdown(html) {
    const body = new DOMParser().parseFromString(String(html || ""), "text/html").body;
    if ([...body.querySelectorAll("*")].some((e) => !/^(DIV|P|BR|SPAN)$/.test(e.nodeName))) return false;
    const t = commentText(html, true);
    return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s+\S|\d+[.)]\s+\S|>\s?\S|```)/.test(t) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/|`[^`\n]+`/.test(t);
  }
  // A field or comment as cleaned DOM nodes, rendering Markdown where there is some.
  function richText(text, markdown) {
    return rich(markdown ? md(text) : looksLikeMarkdown(text) ? md(commentText(text, true)) : text);
  }

  let TK = null;           // the ticket on show
  const tkHist = [];        // tickets viewed since the panel opened, for Back/Forward (Cmd/Ctrl + ←/→)
  let tkAt = -1;            // where in tkHist the panel is
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const tkNav = () => {
    const b = tkHist[tkAt - 1], n = tkHist[tkAt + 1];
    return (b != null ? `<button class="btn" type="button" data-tk="back" title="Back to #${esc(b)} (${MOD}←)">← #${esc(b)}</button>` : "")
      + (n != null ? `<button class="btn" type="button" data-tk="fwd" title="Forward to #${esc(n)} (${MOD}→)">#${esc(n)} →</button>` : "");
  };
  /** Back (-1) or forward (1) through the tickets viewed in the panel. */
  function tkGo(step) {
    const id = tkHist[tkAt + step];
    if (id != null && $("ticket").open) openTicket(id, { step });
  }
  const tkKind = (type) => ({ Incident: "incident", "Product Backlog Item": "pbi", PBI: "pbi", Task: "task", Bug: "bug" }[type] || "other");
  const tkLink = (l) => `<li><button class="linkbtn" type="button" data-ticket="${esc(l.id)}">#${esc(l.id)}</button> <span class="tk-kind">${esc(l.type)}</span> ${esc(l.title)}${l.state ? ` <span class="ps">(${esc(l.state)})</span>` : ""}</li>`;

  let tkOpener = null;      // what had focus before the drawer opened, to return to
  // Unsaved quick edits are only thrown away with the user's say-so.
  function tkLeave() {
    const n = Object.keys(tkChanges()).length + [...$("tk").querySelectorAll(".tk-c-edit textarea")].filter((x) => x.value !== x.defaultValue).length;
    return !n || confirm(`Discard your unsaved change${n > 1 ? "s" : ""} to #${TK.id}?`);
  }
  function markOpen(id) {
    for (const c of document.querySelectorAll("article.card.is-open")) c.classList.remove("is-open");
    if (id) for (const c of document.querySelectorAll(`article.card[data-ticket="${id}"]`)) c.classList.add("is-open");
  }
  function closeTicket() { if ($("ticket").open && tkLeave()) $("ticket").close(); }

  // Opening a ticket from the board or a link adds it after the current one, dropping any
  // you had gone back from, as a browser does; `step` moves through that list instead.
  async function openTicket(id, { step = 0 } = {}) {
    const dlg = $("ticket");
    if (dlg.open && TK?.id === id) return;
    if (dlg.open && !tkLeave()) return;
    if (step) tkAt += step;
    else if (!dlg.open) { tkHist.splice(0, tkHist.length, id); tkAt = 0; }
    else { tkHist.splice(tkAt + 1, Infinity, id); tkAt = tkHist.length - 1; }
    TK = { id, loading: true };
    $("tk").innerHTML = `<div class="tk-top">${tkNav()}<span class="tk-id">#${esc(id)}</span><span style="flex:1"></span><button class="btn icon" type="button" data-tk="close" aria-label="Close">×</button></div><p class="muted">Loading #${esc(id)} from Azure DevOps…</p>`;
    $("tk").scrollTop = 0;
    if (!dlg.open) {
      tkOpener = document.activeElement;
      dlg.show();
      document.body.classList.add("drawer-open");
    }
    markOpen(id);
    try {
      const t = await invoke("ticket", { id });
      if (TK?.id === id) renderTicket(t);
    } catch (e) {
      if (TK?.id !== id) return;
      const url = ALL.find((x) => x.id === id)?.url;
      $("tk").querySelector("p").outerHTML = `<p class="err">Could not open #${esc(id)}. ${esc(e?.message || e)}</p>${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">Open it in Azure DevOps ↗</a></p>` : ""}`;
    }
  }

  function renderTicket(t, note = "") {
    TK = t;
    const states = t.states.map((s) => `<option${s.name === t.state ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    const curWho = t.assignedTo ? t.assignedTo.unique || t.assignedTo.name : "";
    const prio = [1, 2, 3, 4].map((p) => `<option value="${p}"${p === t.priority ? " selected" : ""}>${p}</option>`).join("");
    const when = (at) => (at ? esc(fmt(at)) : "");
    const meta = [
      ["Created", `${esc(t.createdBy || "")}${t.createdAt ? " · " + when(t.createdAt) : ""}`],
      ["Changed", `${esc(t.changedBy || "")}${t.changedAt ? " · " + when(t.changedAt) : ""}`],
    ];
    const hist = t.history.map((h) => `<li><time>${when(h.at)}</time><span class="who">${esc(h.by)}</span><span>${h.created ? "Created it"
      : h.changes.map((c) => `${esc(c.field)}: ${esc(c.from ?? "—")} → ${esc(c.to ?? "—")}`).join("; ")}</span></li>`).join("");
    $("tk").innerHTML = `
      <div class="tk-top">
        ${tkNav()}
        <span class="tk-kind k-${tkKind(t.type)}">${esc(t.type)}</span><span class="tk-id">#${esc(t.id)}</span>
        <span style="flex:1"></span>
        <a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open in Azure DevOps ↗</a>
        <button class="btn icon" type="button" data-tk="close" aria-label="Close">×</button>
      </div>
      <h2 class="tk-title" id="tkTitle">${esc(t.title)}</h2>
      <div class="tk-edit">
        <label>State<select data-f="state">${states}</select></label>
        <label class="who">Assigned to${pickerHtml(`data-f="assignedTo"`, curWho, t.assignedTo?.name || "")}</label>
        <label class="area">Area${pickerHtml(`data-f="area"`, t.area, t.area, "Type an area name")}</label>
        <label class="iter">Iteration${pickerHtml(`data-f="iteration"`, t.iteration, t.iteration, "Type a sprint name")}</label>
        ${t.hasPriority ? `<label>Priority<select data-f="priority">${t.priority == null ? `<option value="" selected>—</option>` : ""}${prio}</select></label>` : ""}
        ${t.numbers.map((n) => `<label class="num">${esc(n.label)}<input type="number" min="0" step="any" inputmode="decimal" data-n="${esc(n.field)}" value="${n.value ?? ""}" placeholder="—"></label>`).join("")}
        <div class="tk-tags"><span class="lbl" id="tkTagsLbl">Tags</span><div class="tk-taglist" id="tkTagList"></div>${pickerHtml(`data-tagin aria-hidden="true"`, "", "", "Add a tag")}</div>
        <div class="tk-save" hidden><button class="btn primary" type="button" data-tk="save">Save changes</button><button class="linkbtn" type="button" data-tk="discard">Discard</button></div>
      </div>
      <p class="hint" id="tkAreaHint" role="status" hidden></p>
      <p class="err" id="tkErr" role="alert" hidden></p>
      ${note ? `<p class="tk-note" role="status">${esc(note)}</p>` : ""}
      ${t.missing.length ? `<p class="hint">Couldn't load ${esc(t.missing.join(", "))} from Azure DevOps.</p>` : ""}
      <dl class="tk-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v || "—"}</dd></div>`).join("")}</dl>
      <div id="tkSections"></div>
      ${t.parent ? `<h3>Parent</h3><ul class="tk-links">${tkLink(t.parent)}</ul>` : ""}
      ${t.children.length ? `<h3>Children <span class="n">${t.children.length}</span></h3><ul class="tk-links">${t.children.map(tkLink).join("")}</ul>` : ""}
      <h3>Discussion <span class="n">${t.comments.length || ""}</span></h3>
      <div class="tk-comment"><textarea id="tkComment" rows="3" placeholder="Add a comment"></textarea><button class="btn" type="button" data-tk="comment">Comment</button></div>
      <ul class="tk-comments" id="tkComments"></ul>
      ${hist ? `<h3>History</h3><ul class="tk-history">${hist}</ul>` : ""}`;
    // Rich text goes in as rebuilt nodes, never as HTML strings.
    const sec = $("tkSections");
    for (const s of t.sections) {
      const h = document.createElement("h3"); h.textContent = s.label;
      const d = document.createElement("div"); d.className = "rich"; d.append(richText(s.html, s.markdown));
      sec.append(h, d);
    }
    if (!t.sections.length) sec.innerHTML = `<p class="muted">No description.</p>`;
    const cl = $("tkComments");
    for (const c of t.comments) {
      const li = document.createElement("li");
      li.dataset.comment = c.id;
      li.innerHTML = `<div class="tk-c-head"><b>${esc(c.author)}</b><time>${when(c.at)}</time>${c.edited ? `<span class="muted">edited</span>` : ""}${c.mine ? `<button class="linkbtn tk-c-editbtn" type="button" data-tk="edit-comment" aria-label="Edit your comment from ${when(c.at)}">Edit</button>` : ""}</div>`;
      const d = document.createElement("div"); d.className = "rich"; d.append(richText(c.html, c.markdown));
      li.append(d); cl.append(li);
    }
    initPicker($("tk").querySelector(".who .pick"), peopleSource(t.assignedTo));
    initPicker($("tk").querySelector(".area .pick"), areaSource(t.area));
    initPicker($("tk").querySelector(".tk-tags .pick"), tagSource());
    $("tk").querySelector(".tk-tags .pick-in").setAttribute("aria-labelledby", "tkTagsLbl");
    tkSetTags(t.tags, false);
    initPicker($("tk").querySelector(".iter .pick"), iterSource(t.iteration));
    $("ticket").setAttribute("aria-labelledby", "tkTitle");
  }

  const tkField = (f) => $("tk").querySelector(`[data-f="${f}"]`);
  // The tags as edited in the panel; saved as the ticket's whole new set.
  let tkTags = [];
  function tkSetTags(tags, dirty = true) {
    const out = [];
    for (const g of tags.map((x) => String(x).trim()).filter(Boolean)) if (!out.some((o) => norm(o) === norm(g))) out.push(g);
    tkTags = out;
    $("tkTagList").innerHTML = out.map((g, i) => `<span class="tag">${esc(g)}<button type="button" class="tag-x" data-tk="untag" data-i="${i}" aria-label="Remove tag ${esc(g)}">×</button></span>`).join("")
      || `<span class="muted">No tags</span>`;
    if (dirty) tkDirty();
  }
  const sameTags = (a, b) => a.length === b.length && a.every((g) => b.some((h) => norm(h) === norm(g)));
  function tkChanges() {
    if (!TK || TK.loading) return {};
    const out = {};
    const st = tkField("state")?.value;
    if (st && st !== TK.state) out.state = st;
    const who = tkField("assignedTo");
    if (who && who.value !== who.dataset.was) out.assignedTo = who.value; // hidden inputs have no separate default
    if (!sameTags(tkTags, TK.tags || [])) out.tags = tkTags;
    const ar = tkField("area");
    if (ar && ar.value && ar.value !== ar.dataset.was) out.area = ar.value;
    const it = tkField("iteration");
    if (it && it.value && it.value !== it.dataset.was) out.iteration = it.value;
    const p = tkField("priority");
    if (p && p.value && Number(p.value) !== TK.priority) out.priority = Number(p.value);
    // Estimates: a changed number is sent, a cleared one is sent as null (removed).
    const nums = {};
    for (const n of TK.numbers || []) {
      const el = $("tk").querySelector(`[data-n="${CSS.escape(n.field)}"]`);
      if (!el) continue;
      const v = el.value.trim() === "" ? null : Number(el.value);
      if (v !== (n.value ?? null) && !(v !== null && Number.isNaN(v))) nums[n.field] = v;
    }
    if (Object.keys(nums).length) out.numbers = nums;
    return out;
  }
  function tkDirty() {
    const ch = tkChanges();
    $("tk").querySelector(".tk-save").hidden = !Object.keys(ch).length;
    // Moving a ticket to an area outside the board takes it off the board.
    const hint = $("tkAreaHint");
    if (hint) {
      const off = !!ch.area && !onBoard(ch.area);
      hint.hidden = !off;
      hint.textContent = off ? `After saving, #${TK.id} leaves this board, which shows ${BOARD.areaPath} and the areas under it.` : "";
    }
  }

  async function tkSave() {
    const changes = tkChanges();
    if (!Object.keys(changes).length) return;
    const btn = $("tk").querySelector('[data-tk="save"]'); btn.disabled = true; btn.textContent = "Saving…";
    showErr("tkErr", "");
    try {
      renderTicket(await invoke("update_ticket", { edit: { id: TK.id, rev: TK.rev, ...changes } }), "Saved.");
      refresh("edited");
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith("Someone changed")) {
        try { renderTicket(await invoke("ticket", { id: TK.id })); } catch {}
      } else { btn.disabled = false; btn.textContent = "Save changes"; }
      showErr("tkErr", msg);
      // "Azure DevOps needs Effort filled in…": take the user to that field.
      const need = /^Azure DevOps needs (.+?) filled in/.exec(msg)?.[1];
      const n = need && (TK.numbers || []).find((x) => x.label.toLowerCase() === need.toLowerCase());
      if (n) $("tk").querySelector(`[data-n="${CSS.escape(n.field)}"]`)?.focus();
    }
  }

  // Re-render the panel with a fresh ticket, keeping quick edits the user hasn't saved yet.
  function tkRerender(t, note) {
    const { numbers = {}, tags, ...fields } = tkChanges();
    renderTicket(t, note);
    if (tags) tkSetTags(tags, false);
    for (const [k, v] of Object.entries(fields)) { const el = tkField(k); if (el?.closest(".pick")) el.closest(".pick").pickSet(String(v)); else if (el) el.value = String(v); }
    for (const [k, v] of Object.entries(numbers)) { const el = $("tk").querySelector(`[data-n="${CSS.escape(k)}"]`); if (el) el.value = v ?? ""; }
    tkDirty();
  }

  // A comment as plain text for editing: line breaks kept, markup dropped. With `keep`,
  // runs of spaces stay too (indents in Markdown).
  function commentText(html, keep = false) {
    const body = new DOMParser().parseFromString(String(html || ""), "text/html").body;
    let out = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += keep ? c.nodeValue.replace(/\u00a0/g, " ").replace(/\n/g, " ") : c.nodeValue.replace(/\s+/g, " ");
        else if (c.nodeName === "BR") out += "\n";
        else if (c.nodeType === 1) {
          const block = /^(DIV|P|LI|H[1-6]|TR|BLOCKQUOTE|PRE|UL|OL|TABLE)$/.test(c.nodeName);
          if (block && out && !out.endsWith("\n")) out += "\n";
          walk(c);
          if (block && !out.endsWith("\n")) out += "\n";
        }
      }
    };
    walk(body);
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return keep ? out.replace(/^\n+|\s+$/g, "") : out.trim();
  }
  // True when editing as plain text would drop something: formatting, links, mentions, images.
  const commentHasMarkup = (html) => [...new DOMParser().parseFromString(String(html || ""), "text/html").body.querySelectorAll("*")].some((e) => !/^(DIV|P|BR|SPAN)$/.test(e.nodeName) || e.attributes.length);

  function tkEditComment(li) {
    const c = TK.comments.find((x) => String(x.id) === li.dataset.comment);
    if (!c || li.querySelector(".tk-c-edit")) return;
    const box = document.createElement("div");
    box.className = "tk-c-edit";
    box.innerHTML = `<textarea rows="4" aria-label="Edit your comment"></textarea>
      ${!c.markdown && commentHasMarkup(c.html) ? `<p class="hint">Saving here keeps the text only: this comment's formatting, links or mentions will be removed. To keep them, edit it in Azure DevOps.</p>` : ""}
      <div class="tk-c-actions"><button class="btn primary" type="button" data-tk="save-comment">Save</button><button class="linkbtn" type="button" data-tk="cancel-comment">Cancel</button></div>`;
    const ta = box.querySelector("textarea");
    ta.value = ta.defaultValue = c.markdown ? c.html : commentText(c.html, looksLikeMarkdown(c.html));
    li.querySelector(".rich").hidden = true;
    li.querySelector(".tk-c-editbtn").hidden = true;
    li.append(box);
    ta.focus();
  }
  function tkCancelComment(li) {
    li.querySelector(".tk-c-edit")?.remove();
    li.querySelector(".rich").hidden = false;
    li.querySelector(".tk-c-editbtn").hidden = false;
  }
  async function tkSaveComment(li) {
    const ta = li.querySelector(".tk-c-edit textarea"), text = ta.value.trim();
    if (!text) { showErr("tkErr", "A comment can't be empty. To remove it, delete it in Azure DevOps."); return ta.focus(); }
    if (text === ta.defaultValue.trim()) return tkCancelComment(li);
    const btn = li.querySelector('[data-tk="save-comment"]'); btn.disabled = true; btn.textContent = "Saving…";
    showErr("tkErr", "");
    try {
      const c = TK.comments.find((x) => String(x.id) === li.dataset.comment);
      tkRerender(await invoke("edit_comment", { id: TK.id, commentId: Number(li.dataset.comment), text, markdown: !!c?.markdown }), "Comment updated.");
    } catch (e) {
      showErr("tkErr", String(e?.message || e));
      btn.disabled = false; btn.textContent = "Save";
    }
  }

  async function tkComment() {
    const box = $("tkComment"), text = box.value.trim();
    if (!text) return box.focus();
    const btn = $("tk").querySelector('[data-tk="comment"]'); btn.disabled = true; btn.textContent = "Posting…";
    showErr("tkErr", "");
    try {
      tkRerender(await invoke("add_comment", { id: TK.id, text }), "Comment added."); // a pending edit survives
    } catch (e) {
      showErr("tkErr", String(e?.message || e));
      btn.disabled = false; btn.textContent = "Comment";
    }
  }

  /* ---------- settings ---------- */
  async function openSettings() {
    const s = await invoke("get_settings");
    const f = $("settingsForm");
    for (const [k, v] of Object.entries(s)) {
      const el = f.elements.namedItem(k);
      if (el) el.value = Array.isArray(v) ? v.join(", ") : v ?? "";
    }
    showErr("settingsErr", "");
    if ($("signin").open) $("signin").close();
    $("settings").showModal();
  }

  async function saveSettings(ev) {
    ev.preventDefault();
    const f = $("settingsForm");
    const cur = await invoke("get_settings");
    const v = (k) => f.elements.namedItem(k).value;
    const next = {
      ...cur,
      org: v("org"), project: v("project"), areaPath: v("areaPath"), boardUrl: v("boardUrl"), adoUrl: v("adoUrl"),
      states: v("states").split(","), doingStates: v("doingStates").split(","), newStates: v("newStates").split(","),
      lookbackDays: parseInt(v("lookbackDays"), 10) || 60, refreshMinutes: parseInt(v("refreshMinutes"), 10) || 10,
      title: v("title"), timeZone: v("timeZone"), tenantId: v("tenantId"), clientId: v("clientId"),
    };
    if (next.timeZone) { try { new Intl.DateTimeFormat("en-GB", { timeZone: next.timeZone }); } catch { return showErr("settingsErr", `“${next.timeZone}” is not a time zone name. Try Europe/London or leave it blank.`); } }
    try {
      await invoke("save_settings", { settings: next });
      TYPES = null; // the project may have changed
      $("settings").close();
      await refreshAuth();
      await load();
      if (AUTH?.signedIn) refresh("manual"); else openSignIn();
    } catch (e) { showErr("settingsErr", String(e?.message || e)); }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-preset]"); if (s) { const k = s.dataset.preset; f.preset = f.preset === k ? null : k; fOn("preset", !!f.preset); render(); return; }
    const gb = e.target.closest("[data-group]"); if (gb) { f.group = gb.dataset.group; store.set("group", f.group); render(); return; }
    const hb = e.target.closest("[data-hide]"); if (hb) { setHidden(hb.dataset.hide, true); return; }
    const ub = e.target.closest("[data-unhide]"); if (ub) { setHidden(ub.dataset.unhide || null, false); return; }
    const o = e.target.closest("[data-owner]"); if (o) { const k = o.dataset.owner; f.owner = f.owner === k ? null : k; fOn("owner", f.owner !== null); saveFilters(); render(); return; }
    const c = e.target.closest("[data-chip]");
    if (c) {
      const k = c.dataset.chip;
      if (k.startsWith("type:")) {
        const ty = k.slice(5);
        if (!ty) f.types.clear(); else if (!f.types.delete(ty)) f.types.add(ty);
        if (ty) fOn(k, f.types.has(ty));
        saveFilters();
      }
      else if (k.startsWith("ws:")) { const w = k.slice(3); f.ws = f.ws === w ? null : w; fOn("ws", !!f.ws); saveFilters(); }
      else { f.preset = f.preset === k ? null : k; fOn("preset", !!f.preset); }
      render();
    }
  });
  $("q").addEventListener("input", (e) => { f.q = e.target.value.trim(); fOn("q", !!f.q); render(); });
  $("clear").addEventListener("click", () => { Object.assign(f, { q: "", owner: null, preset: null, ws: null }); f.types.clear(); fOrder.length = 0; saveFilters(); $("q").value = ""; render(); });
  $("refresh").addEventListener("click", () => refresh("manual"));
  $("me").addEventListener("change", (e) => { me = e.target.value; store.set("me", me); if (!me && f.preset === "mine") f.preset = null; render(); });
  setInterval(renderStatus, 60e3); // keep "stale" indicator honest

  /* ---------- dialogs and account ---------- */
  document.addEventListener("click", (e) => {
    const op = e.target.closest("[data-open]");
    if (op) { e.preventDefault(); op.dataset.open === "settings" ? openSettings() : openSignIn(); }
  }, true);
  $("accountBtn").addEventListener("click", openSignIn);
  $("settingsBtn").addEventListener("click", openSettings);
  $("msBtn").addEventListener("click", signInMicrosoft);
  $("msCancel").addEventListener("click", () => invoke("cancel_sign_in"));
  $("msToSettings").addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
  $("patBtn").addEventListener("click", savePat);
  $("pat").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); savePat(); } });
  $("signOutBtn").addEventListener("click", signOut);
  $("settingsForm").addEventListener("submit", (e) => { if (e.submitter?.value === "save") saveSettings(e); });
  $("newBtn").addEventListener("click", openNewTicket);
  $("newCancel").addEventListener("click", () => $("newTicket").close()); // keeps what was typed for next time
  $("newForm").elements.namedItem("type").addEventListener("change", typeChanged);
  $("newForm").addEventListener("submit", createTicket);
  // N opens "New ticket", unless typing somewhere or a modal dialog is open (the ticket drawer isn't one).
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest?.("input,textarea,select,[contenteditable]") || document.querySelector("dialog:modal")) return;
    e.preventDefault();
    openNewTicket();
  });
  // A card or #number opens the ticket here. Cmd/Ctrl/Shift-click keeps the link's own
  // behaviour, opening Azure DevOps; so does selecting text on a card.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-ticket]");
    if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = e.target.closest("a");
    if (a && a !== el && !a.dataset.ticket) return; // some other link inside a card
    if (!a && String(getSelection()).trim()) return;
    e.preventDefault();
    openTicket(Number(el.dataset.ticket));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.("article.card[data-ticket]")) { e.preventDefault(); openTicket(Number(e.target.dataset.ticket)); }
    if (e.key !== "Escape" || document.querySelector("dialog:modal")) return;
    // The drawer isn't modal, so Escape doesn't close it by itself.
    if ($("ticket").open) { e.preventDefault(); closeTicket(); }
    // In the search box Escape empties it; elsewhere on the board it takes off the latest filter.
    else if (e.target.id === "q" && f.q) { e.preventDefault(); e.target.value = ""; f.q = ""; fOn("q", false); render(); }
    else if (e.target.id === "q" || !e.target.closest?.("input,textarea,select,[contenteditable]")) { if (clearLastFilter()) e.preventDefault(); }
  });
  /* ---------- drawer width: drag its left edge (or arrow keys on it); remembered ---------- */
  const DRAWER_MIN = 380;
  const drawerMax = () => Math.max(DRAWER_MIN, window.innerWidth - 280); // leave some board showing
  let drawerW = Number(store.get("drawerW", "")) || 0; // 0: the default width
  function setDrawerW(w, save = true) {
    drawerW = w ? Math.round(Math.min(Math.max(w, DRAWER_MIN), drawerMax())) : 0;
    if (drawerW) document.documentElement.style.setProperty("--drawer-w", `${drawerW}px`);
    else document.documentElement.style.removeProperty("--drawer-w");
    $("tkResize").setAttribute("aria-valuenow", String(drawerW || $("ticket").offsetWidth || 600));
    if (save) store.set("drawerW", drawerW ? String(drawerW) : "");
  }
  setDrawerW(drawerW, false);
  window.addEventListener("resize", () => { if (drawerW) setDrawerW(Number(store.get("drawerW", "")) || drawerW, false); });
  $("tkResize").addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const h = e.currentTarget;
    h.setPointerCapture(e.pointerId);
    document.body.classList.add("tk-resizing");
    const move = (ev) => setDrawerW(window.innerWidth - ev.clientX, false);
    const done = () => {
      h.removeEventListener("pointermove", move);
      document.body.classList.remove("tk-resizing");
      setDrawerW(drawerW);
    };
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", done, { once: true });
    h.addEventListener("pointercancel", done, { once: true });
  });
  $("tkResize").addEventListener("dblclick", () => setDrawerW(0));
  $("tkResize").addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    setDrawerW(($("ticket").offsetWidth || 600) + (e.key === "ArrowLeft" ? 1 : -1) * (e.shiftKey ? 120 : 40));
  });

  $("ticket").addEventListener("close", () => {
    document.body.classList.remove("drawer-open");
    markOpen(null);
    tkHist.length = 0; tkAt = -1;
    if (tkOpener?.isConnected) tkOpener.focus();
    tkOpener = null;
  });
  $("tk").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tk]"); if (!b) return;
    const what = b.dataset.tk;
    if (what === "close") closeTicket();
    else if (what === "back") tkGo(-1);
    else if (what === "fwd") tkGo(1);
    else if (what === "untag") { tkSetTags(tkTags.filter((_, i) => i !== Number(b.dataset.i))); $("tk").querySelector(".tk-tags .pick-in").focus(); }
    else if (what === "save") tkSave();
    else if (what === "discard") renderTicket(TK);
    else if (what === "comment") tkComment();
    else if (what === "edit-comment") tkEditComment(b.closest("li"));
    else if (what === "cancel-comment") tkCancelComment(b.closest("li"));
    else if (what === "save-comment") tkSaveComment(b.closest("li"));
  });
  $("tk").addEventListener("change", (e) => { if (e.target.matches("[data-f],[data-n]")) tkDirty(); });
  $("tk").addEventListener("input", (e) => { if (e.target.matches("[data-n]")) tkDirty(); });
  $("tk").addEventListener("keydown", (e) => {
    if (e.target.id === "tkComment" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); tkComment(); }
    else if (e.target.closest(".tk-c-edit") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); tkSaveComment(e.target.closest("li")); }
    else if (e.target.closest(".tk-c-edit") && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); tkCancelComment(e.target.closest("li")); }
    else if (e.target.matches("[data-n]") && e.key === "Enter") { e.preventDefault(); tkSave(); }
  });
  window.addEventListener("focus", () => { if (AUTH?.signedIn && nextAutoAt && Date.now() > nextAutoAt) refresh("auto"); });

  /* ---------- Cmd/Ctrl + ←/→: back and forward through the tickets viewed in the panel ---------- */
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    if (!$("ticket").open || document.querySelector("dialog:modal")) return;
    if (e.target.closest?.("input,textarea,select,[contenteditable]")) return; // there it moves the cursor
    e.preventDefault();
    tkGo(e.key === "ArrowLeft" ? -1 : 1);
  });

  /* ---------- Cmd/Ctrl + R: refresh from Azure DevOps instead of reloading the page ---------- */
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "r") return;
    e.preventDefault();
    if (!e.repeat) refresh("manual");
  });

  (async () => {
    try {
      await refreshAuth();
      await load();
      if (!BOARD.configured) return openSettings();
      if (!AUTH?.signedIn) return openSignIn();
      refresh("startup");
    } catch (e) {
      notice("err", `<b>Could not start.</b> ${esc(e?.message || e)}`);
    }
  })();
})();

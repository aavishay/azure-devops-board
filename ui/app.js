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
  function match(t) {
    if (f.owner !== null && (t.owner || "—") !== f.owner) return false;
    if (f.preset && !presets[f.preset].n(t)) return false;
    if (f.ws && t.ws !== f.ws) return false;
    if (f.types.size && !f.types.has(t.type)) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const hit = (x) => x.title.toLowerCase().includes(q) || String(x.id).includes(q);
      if (!hit(t) && !t.dups.some(hit)) return false;
    }
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
    return `<article class="card k-${kind}${t.p === 1 ? " p1" : ""}${mine ? " mine" : ""}${open ? " is-open" : ""}" data-ticket="${esc(t.id)}" tabindex="0" aria-label="Open #${esc(t.id)}: ${esc(t.title)}">
      <div class="tab"><a class="id" href="${esc(t.url)}" target="_blank" rel="noopener" data-ticket="${esc(t.id)}" title="Open here; Cmd/Ctrl-click opens Azure DevOps">${esc(t.id)}</a><span class="kind">${esc(t.type)}</span>${flags}<span class="pri${t.p === 1 ? " p1" : ""}" title="Priority ${esc(t.p)}">P${esc(t.p)}</span></div>
      <div class="body">
        <div class="title">${esc(t.title)}</div>
        ${dupLines}${parentLine}
        <div class="foot">${owner}${creator}${f.group === "ws" ? "" : `<span class="ws">${esc(t.ws)}</span>`}</div>
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
      const url = ALL.find((t) => t.id === c.id)?.url || (BOARD.boardUrl.replace(/_boards.*$/, "") + "_workitems/edit/" + c.id);
      return `<li><time>${esc(fmt(c.at))}</time><a class="hid" href="${esc(url)}" target="_blank" rel="noopener" data-ticket="${esc(c.id)}">#${esc(c.id)}</a><span class="what ${esc(c.kind)}">${what(c)}</span><span class="tt" title="${esc(c.title)}">${esc(c.title)}</span></li>`;
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

  function changesHtml(changes) {
    const t = (c) => c.kind === "added" ? `<b>#${esc(c.id)}</b> appeared: ${esc(c.title)}`
      : c.kind === "removed" ? `<b>#${esc(c.id)}</b> left the board: ${esc(c.title)}`
      : c.kind === "state" ? `<b>#${esc(c.id)}</b> ${esc(c.from)} → ${esc(c.to)}`
      : `<b>#${esc(c.id)}</b> owner ${esc(c.from || "unassigned")} → ${esc(c.to || "unassigned")}`;
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
    const who = form.elements.namedItem("assignedTo");
    who.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    const lastWho = store.get("newAssignee", "");
    who.value = opts.some(([v]) => v === lastWho) ? lastWho : "";

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
      notice("ok", `<b>Created <a href="${esc(c.url)}" target="_blank" rel="noopener">#${esc(c.id)}</a></b> ${esc(c.title)}`);
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

  let TK = null;           // the ticket on show
  const tkBack = [];        // ids to go back to, from opening linked tickets
  const tkKind = (type) => ({ Incident: "incident", "Product Backlog Item": "pbi", PBI: "pbi", Task: "task", Bug: "bug" }[type] || "other");
  const tkLink = (l) => `<li><button class="linkbtn" type="button" data-ticket="${esc(l.id)}">#${esc(l.id)}</button> <span class="tk-kind">${esc(l.type)}</span> ${esc(l.title)}${l.state ? ` <span class="ps">(${esc(l.state)})</span>` : ""}</li>`;

  let tkOpener = null;      // what had focus before the drawer opened, to return to
  // Unsaved quick edits are only thrown away with the user's say-so.
  function tkLeave() {
    const n = Object.keys(tkChanges()).length;
    return !n || confirm(`Discard your unsaved change${n > 1 ? "s" : ""} to #${TK.id}?`);
  }
  function markOpen(id) {
    for (const c of document.querySelectorAll("article.card.is-open")) c.classList.remove("is-open");
    if (id) for (const c of document.querySelectorAll(`article.card[data-ticket="${id}"]`)) c.classList.add("is-open");
  }
  function closeTicket() { if ($("ticket").open && tkLeave()) $("ticket").close(); }

  async function openTicket(id, { push = false, back = false } = {}) {
    const dlg = $("ticket");
    if (dlg.open && TK?.id === id) return;
    if (dlg.open && !tkLeave()) return;
    if (back) tkBack.pop();
    else if (push && TK && TK.id !== id) tkBack.push(TK.id);
    else if (!push) tkBack.length = 0;
    TK = { id, loading: true };
    $("tk").innerHTML = `<div class="tk-top"><span class="tk-id">#${esc(id)}</span><span style="flex:1"></span><button class="btn icon" type="button" data-tk="close" aria-label="Close">×</button></div><p class="muted">Loading #${esc(id)} from Azure DevOps…</p>`;
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
    const people = peopleOptions(t.assignedTo);
    const curWho = t.assignedTo ? (people.find(([v, l]) => v === t.assignedTo.unique || l === t.assignedTo.name || l === `Me (${t.assignedTo.name})`)?.[0] ?? "") : "";
    const who = people.map(([v, l]) => `<option value="${esc(v)}"${v === curWho ? " selected" : ""}>${esc(l)}</option>`).join("");
    const prio = [1, 2, 3, 4].map((p) => `<option value="${p}"${p === t.priority ? " selected" : ""}>${p}</option>`).join("");
    const when = (at) => (at ? esc(fmt(at)) : "");
    const meta = [
      ["Area", esc(t.area)], ["Iteration", esc(t.iteration)],
      ...(t.tags.length ? [["Tags", t.tags.map((g) => `<span class="tag">${esc(g)}</span>`).join(" ")]] : []),
      ["Created", `${esc(t.createdBy || "")}${t.createdAt ? " · " + when(t.createdAt) : ""}`],
      ["Changed", `${esc(t.changedBy || "")}${t.changedAt ? " · " + when(t.changedAt) : ""}`],
    ];
    const hist = t.history.map((h) => `<li><time>${when(h.at)}</time><span class="who">${esc(h.by)}</span><span>${h.created ? "Created it"
      : h.changes.map((c) => `${esc(c.field)}: ${esc(c.from ?? "—")} → ${esc(c.to ?? "—")}`).join("; ")}</span></li>`).join("");
    $("tk").innerHTML = `
      <div class="tk-top">
        ${tkBack.length ? `<button class="btn" type="button" data-tk="back" title="Back to #${esc(tkBack[tkBack.length - 1])}">← #${esc(tkBack[tkBack.length - 1])}</button>` : ""}
        <span class="tk-kind k-${tkKind(t.type)}">${esc(t.type)}</span><span class="tk-id">#${esc(t.id)}</span>
        <span style="flex:1"></span>
        <a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open in Azure DevOps ↗</a>
        <button class="btn icon" type="button" data-tk="close" aria-label="Close">×</button>
      </div>
      <h2 class="tk-title" id="tkTitle">${esc(t.title)}</h2>
      <div class="tk-edit">
        <label>State<select data-f="state">${states}</select></label>
        <label>Assigned to<select data-f="assignedTo">${who}</select></label>
        ${t.hasPriority ? `<label>Priority<select data-f="priority">${t.priority == null ? `<option value="" selected>—</option>` : ""}${prio}</select></label>` : ""}
        <div class="tk-save" hidden><button class="btn primary" type="button" data-tk="save">Save changes</button><button class="linkbtn" type="button" data-tk="discard">Discard</button></div>
      </div>
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
      const d = document.createElement("div"); d.className = "rich"; d.append(rich(s.html));
      sec.append(h, d);
    }
    if (!t.sections.length) sec.innerHTML = `<p class="muted">No description.</p>`;
    const cl = $("tkComments");
    for (const c of t.comments) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="tk-c-head"><b>${esc(c.author)}</b><time>${when(c.at)}</time></div>`;
      const d = document.createElement("div"); d.className = "rich"; d.append(rich(c.html));
      li.append(d); cl.append(li);
    }
    $("ticket").setAttribute("aria-labelledby", "tkTitle");
  }

  const tkField = (f) => $("tk").querySelector(`[data-f="${f}"]`);
  function tkChanges() {
    if (!TK || TK.loading) return {};
    const out = {};
    const st = tkField("state")?.value;
    if (st && st !== TK.state) out.state = st;
    const who = tkField("assignedTo");
    const was = [...who.options].find((o) => o.defaultSelected)?.value ?? "";
    if (who.value !== was) out.assignedTo = who.value;
    const p = tkField("priority");
    if (p && p.value && Number(p.value) !== TK.priority) out.priority = Number(p.value);
    return out;
  }
  function tkDirty() { $("tk").querySelector(".tk-save").hidden = !Object.keys(tkChanges()).length; }

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
    }
  }

  async function tkComment() {
    const box = $("tkComment"), text = box.value.trim();
    if (!text) return box.focus();
    const btn = $("tk").querySelector('[data-tk="comment"]'); btn.disabled = true; btn.textContent = "Posting…";
    showErr("tkErr", "");
    try {
      const keep = tkChanges(); // a pending edit survives posting a comment
      renderTicket(await invoke("add_comment", { id: TK.id, text }), "Comment added.");
      for (const [k, v] of Object.entries(keep)) { const el = tkField(k); if (el) el.value = String(v); }
      tkDirty();
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
    const s = e.target.closest("[data-preset]"); if (s) { const k = s.dataset.preset; f.preset = f.preset === k ? null : k; render(); return; }
    const gb = e.target.closest("[data-group]"); if (gb) { f.group = gb.dataset.group; store.set("group", f.group); render(); return; }
    const hb = e.target.closest("[data-hide]"); if (hb) { setHidden(hb.dataset.hide, true); return; }
    const ub = e.target.closest("[data-unhide]"); if (ub) { setHidden(ub.dataset.unhide || null, false); return; }
    const o = e.target.closest("[data-owner]"); if (o) { const k = o.dataset.owner; f.owner = f.owner === k ? null : k; saveFilters(); render(); return; }
    const c = e.target.closest("[data-chip]");
    if (c) {
      const k = c.dataset.chip;
      if (k.startsWith("type:")) {
        const ty = k.slice(5);
        if (!ty) f.types.clear(); else if (!f.types.delete(ty)) f.types.add(ty);
        saveFilters();
      }
      else if (k.startsWith("ws:")) { const w = k.slice(3); f.ws = f.ws === w ? null : w; saveFilters(); }
      else f.preset = f.preset === k ? null : k;
      render();
    }
  });
  $("q").addEventListener("input", (e) => { f.q = e.target.value.trim(); render(); });
  $("clear").addEventListener("click", () => { Object.assign(f, { q: "", owner: null, preset: null, ws: null }); f.types.clear(); saveFilters(); $("q").value = ""; render(); });
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
    // Links inside the drawer keep a way back; a card on the board starts afresh.
    openTicket(Number(el.dataset.ticket), { push: !!e.target.closest("#tk") });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.("article.card[data-ticket]")) { e.preventDefault(); openTicket(Number(e.target.dataset.ticket)); }
    // The drawer isn't modal, so Escape doesn't close it by itself.
    if (e.key === "Escape" && $("ticket").open && !document.querySelector("dialog:modal")) { e.preventDefault(); closeTicket(); }
  });
  $("ticket").addEventListener("close", () => {
    document.body.classList.remove("drawer-open");
    markOpen(null);
    tkBack.length = 0;
    if (tkOpener?.isConnected) tkOpener.focus();
    tkOpener = null;
  });
  $("tk").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tk]"); if (!b) return;
    const what = b.dataset.tk;
    if (what === "close") closeTicket();
    else if (what === "back" && tkBack.length) openTicket(tkBack[tkBack.length - 1], { back: true });
    else if (what === "save") tkSave();
    else if (what === "discard") renderTicket(TK);
    else if (what === "comment") tkComment();
  });
  $("tk").addEventListener("change", (e) => { if (e.target.matches("[data-f]")) tkDirty(); });
  $("tk").addEventListener("keydown", (e) => { if (e.target.id === "tkComment" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); tkComment(); } });
  window.addEventListener("focus", () => { if (AUTH?.signedIn && nextAutoAt && Date.now() > nextAutoAt) refresh("auto"); });

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

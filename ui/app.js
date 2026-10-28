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
      ? `<div class="parent">↳ <a href="${esc(par?.url || "#")}" target="_blank" rel="noopener">#${esc(t.parent)}</a> ${esc(par?.title || "Parent PBI")}${par?.state ? ` <span class="ps">(${esc(par.state)})</span>` : ""}</div>`
      : "";
    const dupLines = t.dups.map((d) =>
      `<div class="dup" title="Linked in Azure DevOps as a duplicate of #${esc(t.id)}">Duplicate <a href="${esc(d.url)}" target="_blank" rel="noopener">#${esc(d.id)}</a> ${esc(d.title)}${d.rawState !== t.rawState ? ` <span class="ps">(${esc(d.rawState)})</span>` : ""}</div>`).join("");
    return `<article class="card k-${kind}${t.p === 1 ? " p1" : ""}${mine ? " mine" : ""}">
      <div class="tab"><a class="id" href="${esc(t.url)}" target="_blank" rel="noopener" aria-label="Open #${esc(t.id)} in Azure DevOps">${esc(t.id)}</a><span class="kind">${esc(t.type)}</span>${flags}<span class="pri${t.p === 1 ? " p1" : ""}" title="Priority ${esc(t.p)}">P${esc(t.p)}</span></div>
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
      return `<li><time>${esc(fmt(c.at))}</time><a class="hid" href="${esc(url)}" target="_blank" rel="noopener">#${esc(c.id)}</a><span class="what ${esc(c.kind)}">${what(c)}</span><span class="tt" title="${esc(c.title)}">${esc(c.title)}</span></li>`;
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

  /* ---------- Tauri bridge ---------- */
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI ? TAURI.core.invoke(cmd, args) : Promise.reject(new Error("Run this inside the Azure DevOps Board app."));
  const openExternal = (url) => { if (TAURI?.opener) TAURI.opener.openUrl(url).catch(() => {}); else window.open(url, "_blank", "noopener"); };

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

  async function refresh(reason = "manual") {
    if (refreshing) return;
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

  /* ---------- desktop wiring ---------- */
  document.addEventListener("click", (e) => {
    const op = e.target.closest("[data-open]");
    if (op) { e.preventDefault(); op.dataset.open === "settings" ? openSettings() : openSignIn(); return; }
    const a = e.target.closest("a[href]");
    if (a && /^https?:/i.test(a.getAttribute("href"))) { e.preventDefault(); openExternal(a.href); }
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
  window.addEventListener("focus", () => { if (AUTH?.signedIn && nextAutoAt && Date.now() > nextAutoAt) refresh("auto"); });

  /* ---------- zoom: Cmd/Ctrl + "+" / "-" / "0", remembered across restarts ---------- */
  const ZOOMS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  let zoom = ZOOMS.includes(+store.get("zoom", 1)) ? +store.get("zoom", 1) : 1;
  function applyZoom() {
    const wv = TAURI?.webview?.getCurrentWebview?.();
    const css = () => { document.documentElement.style.zoom = zoom; };
    if (wv) wv.setZoom(zoom).catch(css); else css();
    store.set("zoom", zoom);
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const i = ZOOMS.indexOf(zoom);
    let next;
    if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") next = ZOOMS[Math.min(i + 1, ZOOMS.length - 1)];
    else if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") next = ZOOMS[Math.max(i - 1, 0)];
    else if (e.key === "0" || e.code === "Numpad0") next = 1;
    else return;
    e.preventDefault();
    if (next !== zoom) { zoom = next; applyZoom(); }
  });
  if (zoom !== 1) applyZoom();

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

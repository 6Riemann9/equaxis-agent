/**
 * Companion web app — the visual surface for persistent teammates.
 *
 * Zero build step on purpose: the whole app ships as three strings inside this
 * module, so `companion serve` can hand it to a phone with no toolchain, no
 * bundle and no asset directory. The npm package (`files: ["src/"]`) carries
 * it automatically.
 *
 * Layout: a chat application, not a dashboard.
 *   sidebar  — teammates with status, spend and last activity
 *   chat     — the selected teammate's conversation, with a live "typing"
 *              bubble driven by GET /progress while a task runs
 *   panels   — approvals (high-risk requests), routines, connection settings
 *
 * The app is admin-side: it uses the global webhook credential, kept in
 * localStorage after being pasted once. Static assets never contain it.
 */

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#faf9f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#262624" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>Companion</title>
<style>
  :root {
    --paper: #faf9f5;
    --panel: #f0eee6;
    --card: #ffffff;
    --sunken: #f5f4ee;
    --line: #e6e3da;
    --line-soft: #efede5;
    --ink: #1f1e1d;
    --ink-soft: #3d3c39;
    --dim: #6f6c66;
    --faint: #918d85;
    --accent: #c96442;
    --accent-ink: #a8472b;
    --accent-soft: #f6e8e2;
    --ok: #3f7a4f;
    --warn: #9a6b1f;
    --warn-soft: #f7efdd;
    --bad: #a94a3d;
    --bad-soft: #f8e9e5;
    --radius: 14px;
    --sans: "Styrene B", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Helvetica Neue", sans-serif;
    --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #262624;
      --panel: #1f1e1d;
      --card: #30302e;
      --sunken: #2b2b29;
      --line: #3b3a37;
      --line-soft: #33322f;
      --ink: #f4f3ee;
      --ink-soft: #dedcd5;
      --dim: #a5a29a;
      --faint: #85827a;
      --accent: #d97757;
      --accent-ink: #e7967a;
      --accent-soft: #3a2b25;
      --ok: #7fae8a;
      --warn: #d6a353;
      --warn-soft: #33291a;
      --bad: #e08878;
      --bad-soft: #3a2522;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15.5px;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    letter-spacing: -0.005em;
  }
  button {
    font-family: inherit; font-size: 13.5px; font-weight: 500;
    color: var(--ink-soft); background: transparent;
    border: 1px solid var(--line); border-radius: 999px;
    padding: 7px 14px; cursor: pointer;
    transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  button:hover { background: var(--sunken); border-color: var(--line); color: var(--ink); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary {
    background: var(--accent); border-color: var(--accent); color: #fff;
  }
  button.primary:hover { background: var(--accent-ink); border-color: var(--accent-ink); }
  button.ghost { border-color: transparent; color: var(--dim); }
  button.ghost:hover { background: var(--sunken); color: var(--ink); }
  button.danger { color: var(--bad); border-color: var(--line); }
  button.danger:hover { background: var(--bad-soft); border-color: var(--bad-soft); }
  input, textarea, select {
    width: 100%; font-family: inherit; font-size: 14.5px; color: var(--ink);
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 10px 13px; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--faint); }
  textarea { resize: none; line-height: 1.55; }
  .muted { color: var(--dim); font-size: 13px; }
  a { color: var(--accent-ink); }

  /* ---------- shell ---------- */
  #app { display: flex; height: 100%; }
  #sidebar {
    width: 286px; flex: 0 0 286px; display: flex; flex-direction: column;
    background: var(--panel); border-right: 1px solid var(--line-soft); min-height: 0;
  }
  #sidebar header {
    display: flex; align-items: center; gap: 8px;
    padding: 20px 18px 12px;
  }
  .brand { font-family: var(--serif); font-size: 18px; letter-spacing: -.01em; flex: 1; }
  #conn { font-size: 11.5px; color: var(--faint); letter-spacing: .04em; text-transform: lowercase; }
  #botlist { flex: 1; overflow-y: auto; padding: 2px 10px 12px; min-height: 0; }
  #sidebar footer {
    border-top: 1px solid var(--line-soft); padding: 10px;
    display: grid; gap: 2px;
  }
  #sidebar footer button {
    border: 1px solid transparent; border-radius: 10px; text-align: left;
    padding: 8px 10px; font-size: 13.5px; color: var(--dim);
    display: flex; align-items: center; gap: 8px;
  }
  #sidebar footer button:hover { background: var(--card); color: var(--ink); }

  .bot {
    display: flex; gap: 10px; align-items: center; width: 100%; text-align: left;
    background: transparent; border: 1px solid transparent; border-radius: 11px;
    padding: 9px 10px; margin-bottom: 2px; color: var(--ink);
  }
  .bot:hover { background: var(--sunken); }
  .bot.active { background: var(--card); border-color: var(--line-soft); box-shadow: 0 1px 2px rgba(30,25,20,.04); }
  .avatar {
    width: 30px; height: 30px; flex: 0 0 30px; border-radius: 9px;
    display: grid; place-items: center; font-size: 12.5px; font-weight: 600;
    background: var(--accent-soft); color: var(--accent-ink);
  }
  .avatar.busy { background: var(--warn-soft); color: var(--warn); }
  .bot .who { min-width: 0; flex: 1; }
  .bot .name { font-size: 14px; font-weight: 500; color: var(--ink); display: flex; align-items: baseline; gap: 6px; }
  .bot .preview {
    color: var(--faint); font-size: 12.5px; line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line); flex: 0 0 6px; }
  .dot.busy { background: var(--warn); }
  .dot.live { background: var(--ok); }
  .badge-count {
    background: var(--accent); color: #fff; border-radius: 999px;
    font-size: 11px; font-weight: 600; padding: 1px 7px; margin-left: auto;
  }

  /* ---------- chat ---------- */
  #chatpane { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #chatheader {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 26px; border-bottom: 1px solid var(--line-soft);
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    backdrop-filter: saturate(120%) blur(8px);
  }
  #back { display: none; }
  #chatheader .title { font-family: var(--serif); font-size: 17px; letter-spacing: -.01em; }
  #chatheader .sub { color: var(--faint); font-size: 12.5px; margin-top: 1px; }
  #chatheader .actions { margin-left: auto; display: flex; gap: 4px; }

  #messages { flex: 1; overflow-y: auto; padding: 26px 26px 8px; min-height: 0; }
  .empty { color: var(--faint); text-align: center; margin: 16vh auto 0; max-width: 34rem; font-size: 15px; }

  .row { display: flex; margin-bottom: 22px; }
  .row.me { justify-content: flex-end; }
  .row.bot { justify-content: flex-start; }
  .bubble { max-width: 100%; min-width: 0; }
  .row.me .bubble {
    max-width: min(34rem, 82%);
    background: var(--sunken); border: 1px solid var(--line-soft);
    border-radius: 18px; padding: 11px 16px;
    color: var(--ink); white-space: pre-wrap; word-break: break-word;
    font-size: 15px;
  }
  .row.bot .bubble {
    flex: 1; max-width: 46rem; padding: 0 2px;
    color: var(--ink-soft); font-size: 15.5px;
  }
  .row.bot .bubble .author {
    font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--faint); margin-bottom: 3px;
  }
  .msgtext { white-space: pre-wrap; word-break: break-word; }
  .row.err .bubble .msgtext { color: var(--bad); }
  .meta {
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
    color: var(--faint); font-size: 12px; margin-top: 8px;
  }
  .meta button { padding: 3px 10px; font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip {
    font-size: 12px; color: var(--dim); background: var(--sunken);
    border: 1px solid var(--line-soft); border-radius: 999px; padding: 2px 10px;
  }
  .thinking {
    color: var(--faint); font-size: 13.5px; font-style: italic;
    border-left: 2px solid var(--line); padding-left: 12px; margin: 4px 0 10px;
    white-space: pre-wrap; max-height: 8.5rem; overflow: hidden;
  }
  .tools { margin: 4px 0 10px; font-size: 12.5px; color: var(--dim); }
  .tools div {
    display: flex; gap: 8px; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; padding: 2px 0;
  }
  .typing { display: inline-flex; gap: 3px; align-items: center; vertical-align: middle; }
  .typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); animation: pulse 1.3s infinite; }
  .typing i:nth-child(2) { animation-delay: .16s; }
  .typing i:nth-child(3) { animation-delay: .32s; }
  @keyframes pulse { 0%, 70%, 100% { opacity: .22; } 35% { opacity: 1; } }

  .diff {
    margin-top: 8px; background: var(--sunken); border: 1px solid var(--line-soft);
    border-radius: 12px; padding: 10px 12px; font-family: var(--mono);
    font-size: 12.5px; line-height: 1.5; max-height: 260px; overflow: auto;
    white-space: pre-wrap; color: var(--ink-soft);
  }
  .diff .a { color: var(--ok); } .diff .r { color: var(--bad); } .diff .c { color: var(--faint); }
  .files { margin-top: 10px; }
  .files .card { padding: 6px 10px; box-shadow: none; }
  .files .file {
    display: flex; gap: 10px; align-items: center;
    font-size: 12.5px; color: var(--dim); padding: 4px 0;
  }
  .files .file a { color: var(--accent-ink); text-decoration: none; }
  .files .file a:hover { text-decoration: underline; }

  /* ---------- composer ---------- */
  #composer { padding: 8px 26px 22px; }
  #composer .box {
    display: flex; gap: 10px; align-items: flex-end; max-width: 46rem; margin: 0 auto;
    background: var(--card); border: 1px solid var(--line); border-radius: 20px;
    padding: 8px 8px 8px 16px;
    box-shadow: 0 2px 6px rgba(30,25,20,.05);
  }
  #composer textarea {
    border: 0; background: transparent; padding: 8px 0; max-height: 160px;
    box-shadow: none;
  }
  #composer textarea:focus { border: 0; }
  #composer #send {
    flex: 0 0 auto; width: auto; border-radius: 14px; padding: 9px 16px;
    background: var(--accent); border: 1px solid var(--accent); color: #fff; font-weight: 600;
  }
  #composer #send:hover { background: var(--accent-ink); border-color: var(--accent-ink); }

  /* ---------- panels ---------- */
  #panel { position: fixed; inset: 0; background: rgba(30,25,20,.28); display: flex; justify-content: flex-end; z-index: 20; }
  #panel[hidden] { display: none; }
  #panel .sheet {
    width: min(440px, 100%); background: var(--paper);
    border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0;
    box-shadow: -18px 0 40px rgba(30,25,20,.10);
  }
  #panel .sheet header { display: flex; align-items: center; padding: 18px 20px 12px; }
  #panel .sheet header .title { flex: 1; font-family: var(--serif); font-size: 17px; }
  #panel-body { padding: 4px 20px 24px; overflow-y: auto; }
  .card {
    background: var(--card); border: 1px solid var(--line-soft); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 10px;
  }
  .card .row2 { display: flex; gap: 8px; align-items: center; }
  .card .reason { color: var(--warn); font-size: 13.5px; margin-top: 2px; }
  .card pre {
    margin: 8px 0 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.5;
    color: var(--dim); white-space: pre-wrap; max-height: 150px; overflow: auto;
    background: var(--sunken); border-radius: 10px; padding: 9px 11px;
  }
  .card .actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12.5px; color: var(--dim); margin-bottom: 6px; }

  #toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(6px);
    background: var(--ink); color: var(--paper); padding: 9px 16px; border-radius: 999px;
    font-size: 13px; z-index: 40; opacity: 0; pointer-events: none;
    transition: opacity .16s ease, transform .16s ease;
  }
  #toast.show { opacity: .94; transform: translateX(-50%) translateY(0); }

  @media (max-width: 760px) {
    #sidebar { position: fixed; inset: 0; width: 100%; flex-basis: 100%; z-index: 10; }
    #chatpane { position: fixed; inset: 0; z-index: 5; background: var(--paper); }
    #chatpane[hidden] { display: none; }
    #back { display: inline-block; }
    body.chat-open #sidebar { display: none; }
    #chatheader { padding: 12px 16px; }
    #messages { padding: 18px 16px 8px; }
    #composer { padding: 6px 14px 18px; }
  }
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <header>
      <span class="brand">Companion</span>
      <span id="conn">…</span>
      <button id="refresh" class="ghost" title="refresh">↻</button>
    </header>
    <div id="botlist"><p class="muted" style="padding:10px">loading…</p></div>
    <footer>
      <button id="open-approvals"><span>Approvals</span><span id="approvals-badge" class="badge-count" hidden>0</span></button>
      <button id="open-routines"><span>Routines</span></button>
      <button id="open-settings"><span>Connection</span></button>
    </footer>
  </aside>

  <main id="chatpane" hidden>
    <header id="chatheader">
      <button id="back" class="ghost" title="back">←</button>
      <div>
        <div class="title" id="chat-name">—</div>
        <div class="sub" id="chat-sub"></div>
      </div>
      <div class="actions">
        <button id="chat-log" class="ghost" title="stream log">log</button>
        <button id="chat-reset" class="ghost" title="forget the conversation">reset</button>
      </div>
    </header>
    <div id="messages"></div>
    <div id="composer">
      <div class="box">
        <textarea id="input" rows="1" placeholder="Reply to the teammate…"></textarea>
        <button id="send">Send</button>
      </div>
    </div>
  </main>
</div>

<div id="panel" hidden>
  <div class="sheet">
    <header>
      <span class="title" id="panel-title">Panel</span>
      <button id="panel-close" class="ghost">close</button>
    </header>
    <div id="panel-body"></div>
  </div>
</div>

<div id="toast"></div>
<script src="/app.js"></script>
</body>
</html>
`;
const APP_JS = `/* Companion web app. Talks to the same HTTP API the CLI uses. */
"use strict";

const TOKEN_KEY = "companion-token";
const NAMES_KEY = "companion-open";
const NL = String.fromCharCode(10);
const POLL_MS = 4000;
const LIVE_MS = 1200;

const $ = (id) => document.getElementById(id);
const state = {
  teammate: localStorage.getItem(NAMES_KEY) || "",
  status: null,
  thread: null,
  progress: null,
  panel: "",
  timer: null,
  live: null
};

function token() { return localStorage.getItem(TOKEN_KEY) || ""; }

async function api(path, options) {
  const init = Object.assign({ headers: { authorization: "Bearer " + token() } }, options || {});
  if (init.body) init.headers = { authorization: "Bearer " + token(), "content-type": "application/json" };
  const res = await fetch(path, init);
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: 401 });
  if (!res.ok) {
    let detail = "HTTP " + res.status;
    try { detail = (await res.json()).error || detail; } catch (e) { void e; }
    throw Object.assign(new Error(detail), { code: res.status });
  }
  return res.json();
}

function post(path, body) { return api(path, { method: "POST", body: JSON.stringify(body) }); }

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function when(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
  return Math.floor(ms / 86400000) + "d ago";
}

function money(value) {
  const n = Number(value || 0);
  return "$" + n.toFixed(n < 0.01 ? 5 : 3);
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setConn(kind, text) {
  const el = $("conn");
  el.textContent = text;
  el.style.color = kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--bad)" : "var(--dim)";
}

/* ---------------- sidebar ---------------- */

function initials(name) {
  return String(name).replace(/[^a-z0-9]/gi, " ").trim().split(/\\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function renderBots(status) {
  const host = $("botlist");
  const bots = status.teammateDetails || [];
  if (!bots.length) {
    host.innerHTML = '<p class="muted" style="padding:8px">No teammates yet. Create one with <code>companion create &lt;name&gt;</code>.</p>';
    return;
  }
  host.innerHTML = bots.map((bot) => {
    const running = bot.running;
    const last = bot.lastTask;
    const preview = running
      ? "working: " + running.instruction.slice(0, 42)
      : last
        ? (last.status === "failed" ? "failed: " : "") + String(last.instruction || "").slice(0, 42)
        : (bot.persona || "idle").slice(0, 42);
    const dot = running ? "busy" : "live";
    const active = state.teammate === bot.name ? " active" : "";
    return '<button class="bot' + active + '" data-name="' + esc(bot.name) + '">'
      + '<span class="avatar' + (running ? " busy" : "") + '">' + esc(initials(bot.name)) + "</span>"
      + '<span class="who"><span class="name">' + esc(bot.name)
      + (bot.spend && bot.spend.totalCostUsd ? ' <span class="muted" style="font-weight:400;font-size:11px">' + money(bot.spend.totalCostUsd) + "</span>" : "")
      + '</span><span class="preview">' + esc(preview) + "</span></span>"
      + '<span class="dot ' + dot + '"></span>'
      + "</button>";
  }).join("");
}

/* ---------------- chat ---------------- */

function bubble(turn) {
  const mine = '<div class="row me"><div class="bubble">' + esc(turn.instruction) + "</div></div>";
  if (turn.status === "pending") {
    return mine + '<div class="row bot"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span>'
      + ' <span class="muted">queued</span>'
      + ' <button class="ghost danger cancel-task" data-id="' + esc(turn.id) + '">cancel</button>'
      + "</div></div>";
  }
  const failed = turn.status === "failed";
  const body = turn.result || turn.error || (turn.status === "cancelled" ? "(cancelled)" : "(running…)");
  const meta = []
    ;[turn.status, turn.usage ? (turn.usage.totalTokens ? turn.usage.totalTokens + " tok" : "") : "", turn.usage && turn.usage.costUsd ? money(turn.usage.costUsd) : "", when(turn.finishedAt || turn.createdAt)]
    .filter(Boolean).join(" · ");
  const chips = [];
  if (turn.artifacts && turn.artifacts.counts) chips.push('<span class="chip">' + esc(artifactLabel(turn.artifacts.counts)) + "</span>");
  return mine
    + '<div class="row bot' + (failed ? " err" : "") + '"><div class="bubble">'
    + '<div class="author">' + esc(state.teammate || "teammate") + "</div>"
    + '<div class="msgtext">' + esc(String(body).slice(0, 4000)) + "</div>"
    + '<div class="meta">' + esc(meta)
    + (turn.artifacts && turn.artifacts.counts ? ' <button class="ghost show-files" data-id="' + esc(turn.id) + '">files</button>' : "")
    + "</div>"
    + '<div class="files" id="files-' + esc(turn.id) + '" hidden></div>'
    + (chips.length ? '<div class="chips">' + chips.join("") + "</div>" : "")
    + "</div></div>";
}

function cancelButton(progress) {
  if (!progress || !progress.taskId) return "";
  return ' <button class="ghost danger cancel-task" data-id="' + esc(progress.taskId) + '">stop</button>';
}

function typingBubble(progress) {
  if (!progress) return "";
  const stateText = progress.progress || {};
  const thinking = stateText.thinking ? '<div class="thinking">' + esc(stateText.thinking.slice(-600)) + "</div>" : "";
  const tools = (stateText.tools || []).length
    ? '<div class="tools">' + stateText.tools.slice(-4).map((tool) => "<div>" + (tool.running ? "▸ " : "✓ ") + esc(tool.name) + " " + esc(tool.args) + "</div>").join("") + "</div>"
    : "";
  const text = stateText.text ? '<div class="msgtext">' + esc(stateText.text.slice(-2000)) + "</div>" : "";
  const label = text || thinking || tools ? "" : '<span class="typing"><i></i><i></i><i></i></span> <span class="muted">working…</span>';
  return '<div class="row bot"><div class="bubble">'
    + '<div class="author">' + esc(state.teammate || "teammate") + "</div>"
    + label + text + thinking + tools + cancelButton(progress) + "</div></div>";
}

function renderChat() {
  const host = $("messages");
  const thread = state.thread;
  if (!thread) { host.innerHTML = ""; return; }
  const turns = thread.turns || [];
  if (!turns.length) {
    host.innerHTML = '<div class="empty">Nothing here yet.' + NL + '<span class="muted">Write a message below — it runs in its own workspace, with its own files and memory.</span></div>';
    return;
  }
  const running = turns.find((turn) => turn.status === "running");
  const body = turns.map(bubble).join("");
  const live = running ? typingBubble(state.progress) : "";
  host.innerHTML = body + live + (thread.continuous ? "" : '<p class="muted" style="text-align:center;font-size:12px">cold start: this teammate does not keep context between tasks</p>');
  host.scrollTop = host.scrollHeight;
}

function openTeammate(name) {
  state.teammate = name;
  localStorage.setItem(NAMES_KEY, name);
  $("chatpane").hidden = false;
  document.body.classList.add("chat-open");
  $("chat-name").textContent = "@" + name;
  state.thread = null;
  state.progress = null;
  $("messages").innerHTML = '<div class="empty">loading…</div>';
  refresh();
}

function showList() {
  state.teammate = "";
  localStorage.removeItem(NAMES_KEY);
  document.body.classList.remove("chat-open");
  $("chatpane").hidden = true;
}

/* ---------------- data ---------------- */

async function refresh() {
  if (!token()) { openPanel("settings"); setConn("err", "no token"); return; }
  try {
    const status = await api("/status");
    state.status = status;
    renderBots(status);
    setConn("ok", "live");
    if (state.teammate) {
      const bot = (status.teammateDetails || []).find((entry) => entry.name === state.teammate);
      $("chat-sub").textContent = bot
        ? [bot.model || "default model", "context: " + (bot.context ? "continuous" : "cold start"), bot.spend && bot.spend.totalCostUsd ? money(bot.spend.totalCostUsd) : ""].filter(Boolean).join(" · ")
        : "";
      state.thread = await api("/thread/" + encodeURIComponent(state.teammate) + "?n=30");
      const running = (state.thread.turns || []).find((turn) => turn.status === "running");
      state.progress = running ? await api("/progress/" + encodeURIComponent(running.id)).catch(() => null) : null;
      renderChat();
    }
    const approvals = await api("/approvals").catch(() => ({ pending: [] }));
    const badge = $("approvals-badge");
    badge.hidden = !(approvals.pending || []).length;
    badge.textContent = String((approvals.pending || []).length);
    if (state.panel === "approvals") renderApprovals(approvals);
  } catch (error) {
    if (error.code === 401) { setConn("err", "bad token"); openPanel("settings"); }
    else setConn("err", "offline");
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  clearInterval(state.live);
  state.live = setInterval(async () => {
    if (document.hidden || !state.teammate || !state.thread) return;
    const running = (state.thread.turns || []).find((turn) => turn.status === "running");
    if (!running) return;
    try {
      state.progress = await api("/progress/" + encodeURIComponent(running.id));
      renderChat();
    } catch { /* transient */ }
  }, LIVE_MS);
}

/* ---------------- panels ---------------- */

function openPanel(kind) {
  state.panel = kind;
  const titles = { approvals: "Needs your approval", routines: "Scheduled routines", settings: "Connection", log: "Task log" };
  $("panel-title").textContent = titles[kind] || kind;
  $("panel").hidden = false;
  $("panel-body").innerHTML = '<p class="muted">loading…</p>';
  if (kind === "approvals") loadApprovals();
  else if (kind === "routines") loadRoutines();
  else if (kind === "settings") renderSettings();
  else if (kind === "log") renderLog();
}

function closePanel() {
  state.panel = "";
  $("panel").hidden = true;
}

async function loadApprovals() {
  try { renderApprovals(await api("/approvals")); }
  catch (error) { $("panel-body").innerHTML = '<p class="muted">' + esc(error.message) + "</p>"; }
}

function renderApprovals(payload) {
  const pending = (payload && payload.pending) || [];
  const history = (payload && payload.history) || [];
  const body = $("panel-body");
  if (!pending.length) {
    body.innerHTML = '<p class="muted">Nothing waiting. High-risk teammate actions park here until you decide.</p>'
      + (history.length ? '<h4 class="muted">recent decisions</h4>' + history.slice(0, 8).map((entry) =>
        '<div class="card"><div class="row2"><span>' + esc(entry.requestId.slice(0, 8)) + "</span><span class=\\"muted\\" style=\\"margin-left:auto\\">" + esc(entry.decision) + "</span></div></div>").join("") : "");
    return;
  }
  body.innerHTML = pending.map((request) =>
    '<div class="card"><div class="row2"><strong>' + esc(request.toolName) + "</strong>"
    + '<span class="muted" style="margin-left:auto">' + esc(Math.round((request.ageMs || 0) / 1000)) + "s ago</span></div>"
    + '<div class="reason">' + esc(request.reason) + "</div>"
    + (request.summary ? "<pre>" + esc(String(request.summary).slice(0, 1200)) + "</pre>" : "")
    + '<div class="actions">'
    + '<button class="approve primary" data-id="' + esc(request.requestId) + '">Approve</button>'
    + '<button class="deny danger" data-id="' + esc(request.requestId) + '">Deny</button>'
    + "</div></div>"
  ).join("");
}

async function loadRoutines() {
  const body = $("panel-body");
  const status = state.status || await api("/status").catch(() => ({ routineDetails: [], teammates: [] })).then((value) => value);
  const routines = status.routineDetails || [];
  const teammates = status.teammates || [];
  body.innerHTML = '<div id="routine-form">'
    + '<div class="field"><label>Teammate</label><select id="routine-teammate">' + teammates.map((name) => '<option value="' + esc(name) + '">@' + esc(name) + "</option>").join("") + "</select></div>"
    + '<div class="field"><label>Every</label><select id="routine-every">'
    + '<option value="15m">every 15m</option><option value="30m" selected>every 30m</option>'
    + '<option value="1h">every 1h</option><option value="6h">every 6h</option><option value="1d">every 1d</option>'
    + "</select></div>"
    + '<div class="field"><label>Instruction</label><textarea id="routine-instruction" rows="3" placeholder="What should run on this schedule?"></textarea></div>'
    + '<div class="actions"><button id="routine-save" class="primary">Create routine</button><span id="routine-msg" class="muted"></span></div>'
    + "</div><div id='routines' style='margin-top:14px'></div>"
    + (teammates.length ? "" : '<p class="muted">Create a teammate first.</p>');
  $("routines").innerHTML = routines.length
    ? routines.map((routine) =>
      '<div class="card"><div class="row2"><strong>@' + esc(routine.teammate) + "</strong>"
      + '<span class="muted">every ' + esc(Math.round(routine.everyMs / 60000)) + "m</span>"
      + '<span class="muted" style="margin-left:auto">' + esc(routine.nextRunAt ? "next " + when(routine.nextRunAt) : "due now") + "</span>"
      + '<button class="ghost remove-routine danger" data-id="' + esc(routine.id) + '">remove</button></div>'
      + '<div class="muted" style="margin-top:6px">' + esc(routine.instruction) + "</div></div>").join("")
    : '<p class="muted">No routines.</p>';
}

function renderSettings() {
  $("panel-body").innerHTML = '<div class="card">'
    + '<p class="muted">Paste the bearer token printed by <code>companion serve</code> (it lives in <code>.pi/companion/webhook-token</code>). It stays in this browser only.</p>'
    + '<div class="field"><label>Token</label><input id="token-input" type="password" placeholder="bearer token" value="' + esc(token()) + '"></div>'
    + '<div class="actions"><button id="token-save" class="primary">Save</button></div>'
    + "</div>";
}

async function renderLog() {
  if (!state.teammate) { $("panel-body").innerHTML = '<p class="muted">Open a teammate first.</p>'; return; }
  const turns = (state.thread && state.thread.turns) || [];
  const target = turns.slice().reverse().find((turn) => turn.status === "running") || turns[turns.length - 1];
  if (!target) { $("panel-body").innerHTML = '<p class="muted">No task yet.</p>'; return; }
  try {
    const payload = await api("/log/" + encodeURIComponent(target.id) + "?lines=120");
    $("panel-body").innerHTML = '<p class="muted">' + esc(target.id.slice(0, 8)) + " · " + esc(target.status) + "</p><pre style=\\"margin:0;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;color:#9aa5b5\\">"
      + esc((payload.lines || []).join(NL)) + "</pre>";
  } catch (error) {
    $("panel-body").innerHTML = '<p class="muted">' + esc(error.message) + "</p>";
  }
}

/* ---------------- artifacts ---------------- */

function artifactLabel(counts) {
  const parts = [];
  if (counts.added) parts.push(counts.added + " added");
  if (counts.modified) parts.push(counts.modified + " modified");
  if (counts.deleted) parts.push(counts.deleted + " deleted");
  return parts.join(", ") || "no file changes";
}

async function showFiles(taskId) {
  const host = document.getElementById("files-" + taskId);
  if (!host) return;
  if (!host.hidden) { host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = '<p class="muted">loading…</p>';
  try {
    const manifest = await api("/artifacts/" + encodeURIComponent(taskId));
    const rows = [];
    const add = (kind, item) => {
      rows.push('<div class="file"><span class="muted" style="width:64px">' + esc(kind) + "</span>"
        + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' + esc(item.path) + "</span>"
        + '<a href="/artifact/' + encodeURIComponent(taskId) + '/raw?path=' + encodeURIComponent(item.path) + '">get</a>'
        + (kind !== "deleted" && item.diffable ? ' <button class="ghost diff-btn" data-id="' + esc(taskId) + '" data-path="' + esc(item.path) + '">diff</button>' : "")
        + "</div>");
    };
    (manifest.added || []).forEach((item) => add("added", item));
    (manifest.modified || []).forEach((item) => add("modified", item));
    (manifest.deleted || []).forEach((item) => add("deleted", item));
    host.innerHTML = '<div class="card" style="padding:8px 10px">' + (rows.join("") || '<span class="muted">no file changes</span>') + "</div>"
      + '<div class="actions" style="display:flex;gap:8px;margin-top:8px">'
      + '<a class="chip" href="/patch/' + encodeURIComponent(taskId) + '">patch</a>'
      + '<button class="ghost danger revert-task" data-id="' + esc(taskId) + '">revert task</button>'
      + "</div>"
      + '<div class="diff" id="diff-' + esc(taskId) + '" hidden></div>';
  } catch (error) {
    host.innerHTML = '<p class="muted">' + esc(error.message) + "</p>";
  }
}

async function showDiff(taskId, relPath) {
  const box = document.getElementById("diff-" + taskId);
  if (!box) return;
  box.hidden = false;
  box.textContent = "loading…";
  try {
    const diff = await api("/artifact/" + encodeURIComponent(taskId) + "/diff?path=" + encodeURIComponent(relPath));
    box.innerHTML = (diff.hunks || []).map((hunk) => {
      const cls = hunk.type === "added" ? "a" : hunk.type === "removed" ? "r" : "c";
      const sign = hunk.type === "added" ? "+" : hunk.type === "removed" ? "-" : " ";
      return '<span class="' + cls + '">' + esc(sign + " " + hunk.text) + "</span>";
    }).join(NL);
  } catch (error) {
    box.textContent = error.message;
  }
}

/* ---------------- events ---------------- */

$("botlist").addEventListener("click", (event) => {
  const button = event.target.closest(".bot");
  if (!button) return;
  openTeammate(button.dataset.name);
});

$("send").addEventListener("click", async () => {
  const input = $("input");
  const text = input.value.trim();
  if (!text || !state.teammate) return;
  input.value = "";
  input.style.height = "auto";
  $("send").disabled = true;
  try {
    await post("/task/" + encodeURIComponent(state.teammate), { instruction: text });
    toast(state.status && state.status.queue ? "queued for @" + state.teammate : "queued");
    await refresh();
  } catch (error) {
    toast("send failed: " + error.message);
    input.value = text;
  } finally {
    $("send").disabled = false;
  }
});

$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("send").click();
  }
});
$("input").addEventListener("input", (event) => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = Math.min(140, el.scrollHeight) + "px";
});

$("messages").addEventListener("click", async (event) => {
  const target = event.target;
  if (target.classList.contains("show-files")) { showFiles(target.dataset.id); return; }
  if (target.classList.contains("diff-btn")) { showDiff(target.dataset.id, target.dataset.path); return; }
  if (target.classList.contains("revert-task")) {
    const id = target.dataset.id;
    if (!confirm("Undo every change this task made in its workspace?")) return;
    target.disabled = true;
    try {
      const result = await post("/revert/" + encodeURIComponent(id), {});
      toast("reverted: " + result.restored.length + " restored, " + result.removed.length + " removed");
      await refresh();
    } catch (error) {
      // 409 means newer work touched the same files: surface it instead of
      // silently forcing.
      target.disabled = false;
      toast("revert refused: " + error.message);
    }
    return;
  }
  if (target.classList.contains("cancel-task")) {
    target.disabled = true;
    try {
      const result = await post("/cancel/" + encodeURIComponent(target.dataset.id), {});
      toast(result.state === "cancelling" ? "stop requested — the worker will end it" : "cancelled");
      await refresh();
    } catch (error) { toast("cancel failed: " + error.message); target.disabled = false; }
  }
});

$("panel-body").addEventListener("click", async (event) => {
  const target = event.target;
  if (target.id === "routine-save") {
    const teammate = $("routine-teammate").value;
    const every = $("routine-every").value;
    const instruction = $("routine-instruction").value.trim();
    const msg = $("routine-msg");
    if (!instruction) { msg.textContent = "write an instruction first"; return; }
    target.disabled = true;
    try {
      await post("/routine", { teammate, instruction, every });
      await refresh();
      await loadRoutines();
    } catch (error) {
      msg.textContent = error.message;
      target.disabled = false;
    }
    return;
  }
  if (target.classList.contains("remove-routine")) {
    target.disabled = true;
    try {
      await post("/routine/" + encodeURIComponent(target.dataset.id) + "/remove", {});
      await loadRoutines();
    } catch (error) { toast(error.message); }
    return;
  }
  if (target.id === "token-save") {
    localStorage.setItem(TOKEN_KEY, $("token-input").value.trim());
    closePanel();
    refresh();
    return;
  }
  const decision = target.classList.contains("approve") ? "approve" : target.classList.contains("deny") ? "deny" : null;
  if (decision) {
    target.disabled = true;
    try {
      await post("/approval/" + encodeURIComponent(target.dataset.id), { decision });
      await loadApprovals();
      await refresh();
    } catch (error) { toast(error.message); target.disabled = false; }
  }
});

$("refresh").addEventListener("click", refresh);
$("back").addEventListener("click", showList);
$("panel-close").addEventListener("click", closePanel);
$("panel").addEventListener("click", (event) => { if (event.target.id === "panel") closePanel(); });
$("open-approvals").addEventListener("click", () => openPanel("approvals"));
$("open-routines").addEventListener("click", () => openPanel("routines"));
$("open-settings").addEventListener("click", () => openPanel("settings"));
$("chat-log").addEventListener("click", () => openPanel("log"));
$("chat-reset").addEventListener("click", async () => {
  if (!state.teammate) return;
  try {
    await post("/reset/" + encodeURIComponent(state.teammate), {});
    toast("conversation cleared");
    await refresh();
  } catch (error) { toast(error.message); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

refresh();
startPolling();
if (!state.teammate) showList();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
`;

const SW_JS = `/* Companion service worker: cache the shell, never the API. */
"use strict";

const SHELL = ["/", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("companion-shell-v2").then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== "companion-shell-v2").map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Every API route is network-only: it carries the bearer credential and
  // live data, and a cached reply would be a lie.
  if (
    url.pathname === "/status" || url.pathname === "/feed" || url.pathname === "/healthz"
    || url.pathname.startsWith("/thread/") || url.pathname.startsWith("/progress/")
    || url.pathname.startsWith("/log/") || url.pathname.startsWith("/artifacts/")
    || url.pathname.startsWith("/artifact/") || url.pathname === "/approvals"
  ) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open("companion-shell-v2").then((cache) => cache.put(event.request, copy));
      }
      return res;
    }))
  );
});
`;

const MANIFEST = JSON.stringify(
  {
    name: "Equaxis Companion",
    short_name: "Companion",
    description: "Chat with persistent AI teammates",
    start_url: "/",
    display: "standalone",
    background_color: "#faf9f5",
    theme_color: "#faf9f5",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }]
  },
  null,
  2
);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="15" fill="#faf9f5"/>
<circle cx="32" cy="34" r="15" fill="none" stroke="#c96442" stroke-width="3"/>
<circle cx="26" cy="32" r="2.6" fill="#c96442"/>
<circle cx="38" cy="32" r="2.6" fill="#c96442"/>
<path d="M26 40c2.5 2.4 9.5 2.4 12 0" stroke="#c96442" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<path d="M32 19v-6" stroke="#9a6b1f" stroke-width="2.4" stroke-linecap="round"/>
</svg>
`;

/** Path → { body, contentType }. Exact-match only: no filesystem, no traversal. */
export const COMPANION_PWA_ASSETS = {
  "/": { body: INDEX_HTML, contentType: "text/html; charset=utf-8" },
  "/app.js": { body: APP_JS, contentType: "text/javascript; charset=utf-8" },
  "/sw.js": { body: SW_JS, contentType: "text/javascript; charset=utf-8", noStore: true },
  "/manifest.webmanifest": { body: MANIFEST, contentType: "application/manifest+json" },
  "/icon.svg": { body: ICON_SVG, contentType: "image/svg+xml" }
};

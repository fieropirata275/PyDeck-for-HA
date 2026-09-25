"use strict";

/* ═════════ State & helpers ═════════ */
const state = {
  project: null, file: null, dirty: false, files: [], projects: [],
  logs: [], logsRaw: null, lineCount: 0, tab: "files",
  term: null, fit: null, ws: null, wsProject: null, lastSize: "",
};

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const P = () => `api/projects/${enc(state.project)}`;

const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  ok: svg('<path d="M20 6 9 17l-5-5"/>'),
  err: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
};

async function errorFrom(r) {
  const t = await r.text();
  try { const j = JSON.parse(t); return j.detail || j.error || j.message || t; } catch { return t || `${r.status} ${r.statusText}`; }
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(await errorFrom(r));
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

// Para contenido de archivos/logs: siempre texto (evita que un .json se convierta en objeto)
async function apiText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(await errorFrom(r));
  const text = await r.text();
  if ((r.headers.get("content-type") || "").includes("application/json")) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.content === "string") return j.content;
      if (j && Array.isArray(j.lines)) return j.lines.join("\n");
      if (typeof j === "string") return j;
    } catch {}
  }
  return text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let toastTimer;
function toast(msg, type = "ok") {
  const el = $("toast");
  el.innerHTML = `${ICONS[type] || ""}<span>${escapeHtml(msg)}</span>`;
  el.className = `${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), type === "err" ? 4500 : 2400);
}

// Mapea el texto de runtime.status a un tono visual
function statusTone(s) {
  s = String(s || "").toLowerCase();
  if (/run|active|up|online|started/.test(s)) return "s-ok";
  if (/err|fail|crash|dead|exit[^e]*[1-9]/.test(s)) return "s-err";
  if (/test|start|install|restart|pending/.test(s)) return "s-info";
  return "s-idle";
}

const extOf = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
function langOf(p) {
  const map = { py: "Python", txt: "Texto", json: "JSON", yaml: "YAML", yml: "YAML", md: "Markdown", sh: "Shell", toml: "TOML", ini: "INI", cfg: "Config", env: "Env" };
  const e = extOf(p);
  return map[e] || (e ? e.toUpperCase() : "Texto");
}

/* ═════════ Modal (sustituye prompt/alert/confirm) ═════════ */
function ask({ title, message = "", input = false, value = "", placeholder = "", output = null,
               confirmText = "Aceptar", cancelText = "Cancelar", danger = false, validate = null }) {
  return new Promise((resolve) => {
    const dlg = $("modal"), inp = $("modalInput"), pre = $("modalPre"), ok = $("modalOk"), cancel = $("modalCancel");
    $("modalTitle").textContent = title;
    $("modalMsg").textContent = message;
    $("modalMsg").hidden = !message;
    inp.hidden = !input; inp.value = value; inp.placeholder = placeholder;
    pre.hidden = output == null; pre.textContent = output ?? "";
    dlg.classList.toggle("wide", output != null);
    ok.textContent = confirmText;
    ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    cancel.textContent = cancelText;
    cancel.hidden = !cancelText;

    const finish = (v) => {
      ok.removeEventListener("click", onOk); cancel.removeEventListener("click", onCancel);
      inp.removeEventListener("keydown", onKey); dlg.removeEventListener("cancel", onEsc);
      dlg.close(); resolve(v);
    };
    const onOk = () => {
      if (input) {
        const v = inp.value.trim();
        const bad = !v ? "Campo obligatorio" : validate?.(v);
        if (bad) { $("modalMsg").textContent = bad; $("modalMsg").hidden = false; inp.focus(); return; }
        return finish(v);
      }
      finish(true);
    };
    const onCancel = () => finish(input ? null : false);
    const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); onOk(); } };
    const onEsc = (e) => { e.preventDefault(); onCancel(); };

    ok.addEventListener("click", onOk); cancel.addEventListener("click", onCancel);
    inp.addEventListener("keydown", onKey); dlg.addEventListener("cancel", onEsc);
    dlg.showModal();
    setTimeout(() => (input ? (inp.focus(), inp.select()) : ok.focus()), 20);
  });
}

async function withBusy(btn, fn) {
  if (btn.classList.contains("loading")) return;
  btn.classList.add("loading"); btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message, "err"); }
  finally { btn.classList.remove("loading"); btn.disabled = false; }
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return ask({ title: "Cambios sin guardar", message: `${state.file} tiene cambios sin guardar. ¿Descartarlos?`, confirmText: "Descartar", danger: true });
}

/* ═════════ Proyectos ═════════ */
async function loadProjects() {
  const data = await api("api/projects");
  state.projects = data.projects || [];
  renderProjects();
  renderHeader();
}

function renderProjects() {
  const q = $("projectSearch").value.trim().toLowerCase();
  const nameOf = (p) => p.meta?.name || p.id;
  const list = state.projects.filter((p) => !q || nameOf(p).toLowerCase().includes(q) || String(p.id).toLowerCase().includes(q));
  $("projectCount").textContent = state.projects.length;
  const box = $("projects");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="listEmpty">${state.projects.length ? "Sin resultados" : "Aún no hay proyectos"}</div>`;
    return;
  }
  for (const p of list) {
    const st = p.runtime?.status || "—";
    const el = document.createElement("button");
    el.type = "button"; el.title = p.id;
    el.className = `project ${statusTone(st)} ${p.id === state.project ? "active" : ""}`;
    el.innerHTML = `<span class="dot"></span><span class="pname">${escapeHtml(nameOf(p))}</span><span class="pstate">${escapeHtml(st)}</span>`;
    el.onclick = () => selectProject(p.id);
    box.appendChild(el);
  }
}

function renderHeader() {
  if (!state.project) return;
  const p = state.projects.find((x) => x.id === state.project);
  const rt = p?.runtime || {};
  const st = rt.status || "—";
  $("title").textContent = p?.meta?.name || state.project;
  const badge = $("statusBadge");
  badge.textContent = st;
  badge.className = `badge ${statusTone(st)}`;

  const bits = [state.project];
  if (rt.pid) bits.push(`PID ${rt.pid}`);
  const code = rt.exit_code ?? rt.returncode;
  if (code != null) bits.push(`exit ${code}`);
  $("meta").innerHTML = bits.map(escapeHtml).join('<span class="sep">·</span>');

  const running = statusTone(st) === "s-ok";
  if (!$("startBtn").classList.contains("loading")) $("startBtn").disabled = running;
}

async function selectProject(id) {
  if (id === state.project) return;
  if (!(await confirmDiscard())) return;
  state.project = id; state.file = null; state.files = [];
  state.logs = []; state.logsRaw = null;
  closeTerminal();
  $("empty").hidden = true;
  $("workspace").hidden = false;
  resetEditor();
  renderProjects(); renderHeader();
  switchTab("files");
  try { await Promise.all([loadFiles(), loadLogs()]); }
  catch (e) { toast(e.message, "err"); }
}

/* ═════════ Archivos & editor ═════════ */
async function loadFiles() {
  if (!state.project) return;
  const data = await api(`${P()}/files`);
  state.files = data.files || [];
  renderFiles();
  if (!state.file && state.files.includes("main.py")) await openFile("main.py");
}

function renderFiles() {
  const box = $("files");
  box.innerHTML = "";
  if (!state.files.length) { box.innerHTML = '<div class="listEmpty">Sin archivos</div>'; return; }
  for (const path of state.files) {
    const i = path.lastIndexOf("/");
    const dir = i >= 0 ? path.slice(0, i + 1) : "", name = path.slice(i + 1);
    const ext = extOf(name).replace("yml", "yaml");
    const el = document.createElement("button");
    el.type = "button"; el.title = path;
    el.className = `fileItem ext-${ext} ${path === state.file ? "active" : ""}`;
    el.innerHTML = `${ICONS.file}<span class="fname">${dir ? `<span class="fdir">${escapeHtml(dir)}</span>` : ""}${escapeHtml(name)}</span>`;
    el.onclick = () => openFile(path);
    box.appendChild(el);
  }
}

function resetEditor() {
  const ed = $("editor");
  ed.value = ""; ed.disabled = true;
  $("saveBtn").disabled = true;
  $("fileName").textContent = "Selecciona un archivo";
  $("fileLang").textContent = "—";
  setDirty(false); updateGutter(); updateCursor();
}

async function openFile(path) {
  if (path !== state.file && !(await confirmDiscard())) return;
  try {
    const content = await apiText(`${P()}/file?path=${enc(path)}`);
    state.file = path;
    const ed = $("editor");
    ed.disabled = false;
    ed.value = content;
    ed.scrollTop = 0; ed.scrollLeft = 0;
    ed.setSelectionRange(0, 0);
    $("saveBtn").disabled = false;
    $("fileName").textContent = path;
    $("fileLang").textContent = langOf(path);
    setDirty(false); updateGutter(); updateCursor(); renderFiles();
  } catch (e) { toast(e.message, "err"); }
}

function setDirty(v) {
  state.dirty = v;
  $("editorPane").classList.toggle("isDirty", v);
  $("dirtyLabel").textContent = state.file ? (v ? "● Sin guardar" : "Guardado") : "";
}

async function saveFile() {
  if (!state.project || !state.file) return;
  await withBusy($("saveBtn"), async () => {
    await api(`${P()}/file?path=${enc(state.file)}`, { method: "PUT", body: JSON.stringify({ content: $("editor").value }) });
    setDirty(false);
    toast(`${state.file} guardado`);
  });
}

function updateGutter() {
  const n = $("editor").value.split("\n").length;
  if (n !== state.lineCount) {
    state.lineCount = n;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + "\n";
    $("gutter").textContent = s;
  }
  syncScroll();
}
const syncScroll = () => { $("gutter").scrollTop = $("editor").scrollTop; };

function updateCursor() {
  const ed = $("editor");
  const before = ed.value.slice(0, ed.selectionStart);
  const line = before.split("\n").length;
  const col = ed.selectionStart - before.lastIndexOf("\n");
  $("cursorPos").textContent = `Ln ${line}, Col ${col}`;
}

function onEdit() {
  if (state.file && !state.dirty) setDirty(true);
  updateGutter(); updateCursor();
}

// Inserta texto conservando el historial de deshacer (Ctrl+Z)
function insertText(text) {
  const ed = $("editor");
  if (!document.execCommand("insertText", false, text)) {
    ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, "end");
  }
}

function handleEditorKeys(e) {
  const ed = $("editor");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); return; }

  if (e.key === "Tab") {
    e.preventDefault();
    const s = ed.selectionStart, t = ed.selectionEnd, v = ed.value;
    if (s === t && !e.shiftKey) { insertText("    "); onEdit(); return; }
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    const le = t > s && v[t - 1] === "\n" ? t - 1 : t;
    const lineEnd = v.indexOf("\n", le); const end = lineEnd === -1 ? v.length : lineEnd;
    const block = v.slice(ls, end);
    const out = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, "") : block.replace(/^/gm, "    ");
    ed.setSelectionRange(ls, end);
    insertText(out);
    ed.setSelectionRange(ls, ls + out.length);
    onEdit();
    return;
  }

  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
    const s = ed.selectionStart, v = ed.value;
    const line = v.slice(v.lastIndexOf("\n", s - 1) + 1, s);
    let indent = line.match(/^[ \t]*/)[0];
    if (/:\s*(#.*)?$/.test(line)) indent += "    ";
    e.preventDefault();
    insertText("\n" + indent);
    onEdit();
  }
}

/* ═════════ Logs ═════════ */
async function loadLogs() {
  if (!state.project) return;
  const raw = await apiText(`${P()}/logs`);
  if (raw === state.logsRaw) return;
  state.logsRaw = raw;
  state.logs = raw ? raw.replace(/\n$/, "").split("\n") : [];
  renderLogs();
}

function logLevel(l) {
  if (/\b(ERROR|CRITICAL|FATAL)\b|Traceback|Exception\b|Error:/.test(l)) return "err";
  if (/\bWARN(ING)?\b/.test(l)) return "warn";
  if (/\bDEBUG\b/.test(l)) return "dbg";
  if (/\bINFO\b/.test(l)) return "info";
  return "";
}

function renderLogs() {
  const pre = $("logs");
  const q = $("logFilter").value.trim();
  const ql = q.toLowerCase();
  const lines = q ? state.logs.filter((l) => l.toLowerCase().includes(ql)) : state.logs;
  $("logCount").textContent = q ? `${lines.length} / ${state.logs.length} líneas` : `${lines.length} líneas`;
  if (!lines.length) {
    pre.innerHTML = `<span class="logsEmpty">${q ? "Sin coincidencias" : "Sin logs todavía. Inicia o testea el proyecto para ver su salida."}</span>`;
    return;
  }
  const re = q ? new RegExp(escapeRegex(escapeHtml(q)), "gi") : null;
  pre.innerHTML = lines.map((l) => {
    let h = escapeHtml(l);
    if (re) h = h.replace(re, (m) => `<mark>${m}</mark>`);
    return `<span class="ln ${logLevel(l)}">${h || " "}</span>`;
  }).join("");
  if ($("logFollow").checked) pre.scrollTop = pre.scrollHeight;
}

/* ═════════ Terminal ═════════ */
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    background: v("--code-bg"), foreground: v("--text"), cursor: v("--accent"), cursorAccent: v("--code-bg"),
    selectionBackground: "rgba(124,156,255,.3)",
  };
}

function setTermState(txt, cls = "") {
  $("termState").textContent = txt;
  $("termState").className = `termState ${cls}`;
  $("termDot").classList.toggle("on", cls === "on");
  $("termDot").title = txt;
}

function sendResize() {
  if (!state.term || !state.ws || state.ws.readyState !== 1) return;
  const size = `${state.term.cols}:${state.term.rows}`;
  if (size === state.lastSize) return;
  state.lastSize = size;
  state.ws.send(`__PYDECK_RESIZE__:${size}`);
}

function fitTerminal() {
  if (!state.term || state.tab !== "terminal") return;
  try { state.fit?.fit(); } catch {}
  sendResize();
}

function closeTerminal() {
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch {} }
  state.ws = null; state.wsProject = null; state.lastSize = "";
  if (state.term) { try { state.term.dispose(); } catch {} }
  state.term = null; state.fit = null;
  $("terminal").innerHTML = "";
  setTermState("Desconectado");
}

function openTerminal() {
  if (typeof Terminal === "undefined") { setTermState("xterm.js no ha cargado", "err"); return; }
  closeTerminal();
  const project = state.project;
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.25, convertEol: true, scrollback: 5000,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
    theme: termTheme(),
  });
  state.term = term;
  if (window.FitAddon?.FitAddon) { state.fit = new FitAddon.FitAddon(); term.loadAddon(state.fit); }
  term.open($("terminal"));
  requestAnimationFrame(() => { try { state.fit?.fit(); } catch {} });

  setTermState("Conectando…");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/$/, "")}/ws/terminal/${enc(project)}`);
  ws.binaryType = "arraybuffer";
  state.ws = ws; state.wsProject = project;

  ws.onopen = () => { setTermState("Conectado", "on"); state.lastSize = ""; setTimeout(fitTerminal, 60); term.focus(); };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onerror = () => setTermState("Error de conexión", "err");
  ws.onclose = () => { if (state.ws === ws) setTermState("Desconectado"); };
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
}

new ResizeObserver(() => fitTerminal()).observe($("terminal"));
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (state.term) state.term.options.theme = termTheme(); });

/* ═════════ Tabs ═════════ */
function switchTab(name) {
  state.tab = name;
  document.querySelectorAll(".tabBtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === "terminal") {
    const alive = state.ws && state.ws.readyState <= 1 && state.wsProject === state.project;
    if (alive) { requestAnimationFrame(fitTerminal); state.term?.focus(); } else openTerminal();
  }
  if (name === "logs") loadLogs().catch((e) => toast(e.message, "err"));
}
document.querySelectorAll(".tabBtn").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

/* ═════════ Acciones ═════════ */
const ACT_MSG = { start: "Proyecto iniciado", stop: "Proyecto detenido", restart: "Proyecto reiniciado", test: "Test lanzado" };

document.querySelectorAll("[data-act]").forEach((btn) => {
  btn.onclick = () => withBusy(btn, async () => {
    const name = btn.dataset.act;
    await api(`${P()}/${name}`, { method: "POST" });
    toast(ACT_MSG[name] || "Hecho");
    state.logsRaw = null;
    await Promise.all([loadProjects(), loadLogs()]);
    if (name === "test") switchTab("logs");
  });
});

$("installBtn").onclick = () => withBusy($("installBtn"), async () => {
  toast("Instalando dependencias…", "info");
  const r = await api(`${P()}/install`, { method: "POST" });
  const out = typeof r === "string" ? r : [r.stdout, r.stderr].filter(Boolean).join("\n");
  const failed = typeof r === "object" && r && ((r.returncode ?? r.code ?? 0) !== 0 || r.ok === false);
  toast(failed ? "La instalación ha fallado" : "Dependencias instaladas", failed ? "err" : "ok");
  await ask({ title: failed ? "Error instalando dependencias" : "Dependencias instaladas", output: out.trim() || "(sin salida)", confirmText: "Cerrar", cancelText: "" });
});

async function newProject() {
  const id = await ask({
    title: "Nuevo proyecto", message: "Solo letras, números, guion y guion bajo.",
    input: true, placeholder: "rainguard", confirmText: "Crear",
    validate: (v) => (/^[A-Za-z0-9_-]+$/.test(v) ? null : "Solo letras, números, - y _"),
  });
  if (!id) return;
  try {
    await api(`api/projects/${enc(id)}`, { method: "POST" });
    await loadProjects();
    await selectProject(id);
    toast("Proyecto creado");
  } catch (e) { toast(e.message, "err"); }
}
$("newBtn").onclick = newProject;
$("emptyNewBtn").onclick = newProject;

$("refreshFilesBtn").onclick = () => withBusy($("refreshFilesBtn"), loadFiles);
$("saveBtn").onclick = saveFile;

const ed = $("editor");
ed.addEventListener("keydown", handleEditorKeys);
ed.addEventListener("input", onEdit);
ed.addEventListener("scroll", syncScroll);
["keyup", "click", "select"].forEach((ev) => ed.addEventListener(ev, updateCursor));

// Terminal
$("termReconnectBtn").onclick = () => { if (state.project) openTerminal(); };
$("termClearBtn").onclick = () => { state.term?.clear(); state.term?.focus(); };

// Logs
$("logFilter").addEventListener("input", renderLogs);
$("logFollow").addEventListener("change", () => { if ($("logFollow").checked) $("logs").scrollTop = $("logs").scrollHeight; });
$("logWrap").addEventListener("change", () => $("logs").classList.toggle("nowrap", !$("logWrap").checked));
$("logs").addEventListener("scroll", () => {
  const pre = $("logs");
  $("logFollow").checked = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
});
$("copyLogsBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(state.logs.join("\n")); toast("Logs copiados"); }
  catch { toast("No se pudo acceder al portapapeles", "err"); }
};

$("projectSearch").addEventListener("input", renderProjects);

// Atajos y protección de cambios
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && state.file && state.tab === "files") { e.preventDefault(); saveFile(); }
});
window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ═════════ Polling ═════════ */
let ticking = false, tickN = 0;
async function tick() {
  if (ticking || document.hidden) return;
  ticking = true;
  try {
    if (tickN++ % 2 === 0) await loadProjects();
    if (state.project && state.tab === "logs") await loadLogs();
  } catch {} finally { ticking = false; }
}
setInterval(tick, 2500);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

loadProjects().catch((e) => toast(e.message, "err"));

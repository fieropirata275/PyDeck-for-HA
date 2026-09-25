let currentProject = null;
let currentFile = null;
let logTimer = null;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
    ...options,
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  return r.json();
}

function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function fmtUptime(sec) {
  if (!sec) return "—";
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return `${h}h ${m}m ${s}s`;
}

async function loadProjects() {
  const data = await api("api/projects");
  const box = $("projectList"); box.innerHTML = "";
  for (const p of data.projects) {
    const div = document.createElement("div");
    div.className = `projectItem ${p.running ? "running" : ""} ${p.id === currentProject ? "active" : ""}`;
    div.innerHTML = `<span class="dot"></span>${escapeHtml(p.name)}`;
    div.onclick = () => selectProject(p.id);
    box.appendChild(div);
  }
}

async function selectProject(id) {
  currentProject = id; currentFile = null;
  $("emptyState").classList.add("hidden"); $("projectView").classList.remove("hidden");
  await Promise.all([loadStatus(), loadFiles(), loadSettings(), loadLogs()]);
  await loadProjects();
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => { loadStatus(); if (!$("tab-logs").classList.contains("hidden")) loadLogs(); }, 1800);
}

async function loadStatus() {
  if (!currentProject) return;
  const s = await api(`api/projects/${encodeURIComponent(currentProject)}/status`);
  $("projectName").textContent = s.name;
  $("statusLine").textContent = s.running ? "RUNNING" : "STOPPED";
  $("statState").textContent = s.running ? "Running" : "Stopped";
  $("statPid").textContent = s.pid ?? "—";
  $("statCpu").textContent = `${s.cpu_percent.toFixed(1)} %`;
  $("statRam").textContent = `${s.memory_mb.toFixed(1)} MB`;
  $("statUptime").textContent = fmtUptime(s.uptime);
}

async function loadFiles() {
  if (!currentProject) return;
  const data = await api(`api/projects/${encodeURIComponent(currentProject)}/files`);
  const box = $("fileList"); box.innerHTML = "";
  for (const path of data.files) {
    const div = document.createElement("div"); div.className = `fileItem ${path === currentFile ? "active" : ""}`;
    div.textContent = path; div.onclick = () => openFile(path); box.appendChild(div);
  }
  if (!currentFile && data.files.includes("main.py")) await openFile("main.py");
}

async function openFile(path) {
  currentFile = path;
  const data = await api(`api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(path)}`);
  $("currentFile").textContent = path; $("editor").value = data.content;
  await loadFiles();
}

async function saveCurrentFile() {
  if (!currentProject || !currentFile) return;
  await api(`api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(currentFile)}`, {
    method: "PUT", body: JSON.stringify({content: $("editor").value})
  });
  toast("Guardado");
}

async function loadLogs() {
  if (!currentProject) return;
  const data = await api(`api/projects/${encodeURIComponent(currentProject)}/logs?tail=700`);
  const pre = $("logs"); const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 50;
  pre.textContent = data.lines.join("\n"); if (atBottom) pre.scrollTop = pre.scrollHeight;
}

async function loadSettings() {
  const s = await api(`api/projects/${encodeURIComponent(currentProject)}/settings`);
  $("settingName").value = s.name || currentProject;
  $("settingEntrypoint").value = s.entrypoint || "main.py";
  $("settingRestart").value = s.restart_policy || "on-failure";
  $("settingDelay").value = s.restart_delay ?? 3;
  $("settingAutostart").checked = !!s.autostart;
}

$("newProjectBtn").onclick = async () => {
  const id = prompt("ID del proyecto (ej. rainguard):"); if (!id) return;
  const name = prompt("Nombre visible:", id) || id;
  try { await api("api/projects", {method:"POST", body:JSON.stringify({id, name})}); await loadProjects(); await selectProject(id); }
  catch(e){ alert(e.message); }
};

$("newFileBtn").onclick = async () => {
  if (!currentProject) return;
  const path = prompt("Ruta del archivo (ej. helpers/weather.py):"); if (!path) return;
  try { await api(`api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(path)}`, {method:"PUT", body:JSON.stringify({content:""})}); await loadFiles(); await openFile(path); }
  catch(e){ alert(e.message); }
};

$("saveBtn").onclick = saveCurrentFile;
$("editor").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveCurrentFile(); } });

$("startBtn").onclick = async () => { try { await api(`api/projects/${currentProject}/start`, {method:"POST"}); toast("Proyecto iniciado"); await loadStatus(); await loadProjects(); } catch(e){ alert(e.message); } };
$("stopBtn").onclick = async () => { try { await api(`api/projects/${currentProject}/stop`, {method:"POST"}); toast("Proyecto detenido"); await loadStatus(); await loadProjects(); } catch(e){ alert(e.message); } };
$("restartBtn").onclick = async () => { try { await api(`api/projects/${currentProject}/restart`, {method:"POST"}); toast("Proyecto reiniciado"); await loadStatus(); } catch(e){ alert(e.message); } };
$("installBtn").onclick = async () => { if (!confirm("Instalar requirements.txt puede tardar bastante. ¿Continuar?")) return; try { toast("Instalando dependencias..."); await api(`api/projects/${currentProject}/install`, {method:"POST"}); toast("Dependencias instaladas"); } catch(e){ alert(e.message); } };
$("deleteBtn").onclick = async () => { if (!confirm(`¿Eliminar ${currentProject} y todos sus archivos?`)) return; await api(`api/projects/${currentProject}`, {method:"DELETE"}); currentProject=null; $("projectView").classList.add("hidden"); $("emptyState").classList.remove("hidden"); await loadProjects(); };

$("saveSettingsBtn").onclick = async () => {
  const body = {name:$("settingName").value, entrypoint:$("settingEntrypoint").value, restart_policy:$("settingRestart").value, restart_delay:Number($("settingDelay").value || 0), autostart:$("settingAutostart").checked};
  try { await api(`api/projects/${currentProject}/settings`, {method:"PUT", body:JSON.stringify(body)}); toast("Settings guardados"); await loadProjects(); await loadStatus(); } catch(e){ alert(e.message); }
};

document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active")); btn.classList.add("active");
  document.querySelectorAll(".tabPanel").forEach(x => x.classList.add("hidden")); $(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  if (btn.dataset.tab === "logs") loadLogs();
});

function escapeHtml(s){ return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

loadProjects().catch(e => alert(e.message));

from __future__ import annotations
import os, json, subprocess, threading, time, signal, shutil, venv
from pathlib import Path
import psutil

PROJECTS_DIR = Path("/data/projects")
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

_processes = {}
_lock = threading.RLock()

def project_dir(project_id: str) -> Path:
    p = (PROJECTS_DIR / project_id).resolve()
    if PROJECTS_DIR.resolve() not in p.parents and p != PROJECTS_DIR.resolve():
        raise ValueError("Invalid project id")
    return p

def metadata(project_id: str):
    p = project_dir(project_id)
    cfg = p / "project.json"
    if cfg.exists():
        return json.loads(cfg.read_text())
    return {"name": project_id, "entrypoint": "main.py", "autostart": False, "restart_policy": "unless-stopped"}

def save_metadata(project_id: str, data: dict):
    p = project_dir(project_id)
    (p/"project.json").write_text(json.dumps(data, indent=2))

def create_project(project_id: str):
    p = project_dir(project_id)
    p.mkdir(parents=True, exist_ok=True)
    (p/"data").mkdir(exist_ok=True)
    (p/"logs").mkdir(exist_ok=True)
    (p/".home").mkdir(exist_ok=True)
    if not (p/"main.py").exists():
        (p/"main.py").write_text('print("Hello from PyDeck")\n')
    if not (p/"requirements.txt").exists():
        (p/"requirements.txt").write_text("")
    if not (p/".env").exists():
        (p/".env").write_text("")
    if not (p/"project.json").exists():
        save_metadata(project_id, {"name": project_id, "entrypoint": "main.py", "autostart": False, "restart_policy": "on-failure"})
    ensure_venv(project_id)
    return p

def ensure_venv(project_id: str):
    p = project_dir(project_id)
    v = p/".venv"
    if not (v/"bin"/"python").exists():
        venv.EnvBuilder(with_pip=True).create(v)
    return v

def load_env(project_id: str):
    p = project_dir(project_id)
    env = os.environ.copy()
    env["HOME"] = str(p/".home")
    v = ensure_venv(project_id)
    env["VIRTUAL_ENV"] = str(v)
    env["PATH"] = f"{v/'bin'}:{env.get('PATH','')}"
    env["PYDECK_PROJECT_ID"] = project_id
    env["PYDECK_PROJECT_DIR"] = str(p)
    env_path = p/".env"
    if env_path.exists():
        for raw in env_path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, val = line.split("=", 1)
            env[k.strip()] = val.strip().strip('"').strip("'")
    return env

def status(project_id: str):
    with _lock:
        proc = _processes.get(project_id)
    if proc and proc.poll() is None:
        try:
            p = psutil.Process(proc.pid)
            return {
                "status": "running",
                "pid": proc.pid,
                "cpu_percent": p.cpu_percent(interval=0.0),
                "memory_mb": round(p.memory_info().rss/1024/1024, 1),
                "uptime": int(time.time()-p.create_time()),
            }
        except Exception:
            return {"status":"running","pid":proc.pid}
    return {"status":"stopped","pid":None}

def _watch(project_id, proc, restart_policy):
    code = proc.wait()
    print(f"[PyDeck] {project_id} exited code={code}", flush=True)
    with _lock:
        if _processes.get(project_id) is proc:
            _processes.pop(project_id, None)
    if restart_policy in ("always","on-failure") and (restart_policy=="always" or code != 0):
        time.sleep(3)
        try:
            start_project(project_id, _from_restart=True)
        except Exception as e:
            print(f"[PyDeck] restart failed for {project_id}: {e}", flush=True)

def start_project(project_id: str, _from_restart=False, extra_args=None):
    p = create_project(project_id)
    with _lock:
        old = _processes.get(project_id)
        if old and old.poll() is None:
            return old.pid
    cfg = metadata(project_id)
    entrypoint = cfg.get("entrypoint","main.py")
    py = ensure_venv(project_id)/"bin"/"python"
    cmd = [str(py), str(p/entrypoint)]
    if extra_args:
        cmd.extend(extra_args)
    proc = subprocess.Popen(
        cmd,
        cwd=p,
        env=load_env(project_id),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    with _lock:
        _processes[project_id] = proc
    def pump():
        logf = p/"logs"/"runtime.log"
        with logf.open("a", buffering=1) as f:
            for line in proc.stdout:
                print(f"[{project_id}] {line}", end="", flush=True)
                f.write(line)
    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=_watch, args=(project_id, proc, cfg.get("restart_policy","on-failure")), daemon=True).start()
    print(f"[PyDeck] started {project_id} pid={proc.pid}", flush=True)
    return proc.pid

def stop_project(project_id: str):
    with _lock:
        proc = _processes.get(project_id)
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            proc.kill()
    with _lock:
        _processes.pop(project_id, None)

def restart_project(project_id: str):
    stop_project(project_id)
    return start_project(project_id)

def install_requirements(project_id: str):
    p = create_project(project_id)
    pip = ensure_venv(project_id)/"bin"/"pip"
    req = p/"requirements.txt"
    return subprocess.run(
        [str(pip), "install", "-r", str(req)],
        cwd=p,
        env=load_env(project_id),
        capture_output=True,
        text=True,
        timeout=1200,
    )

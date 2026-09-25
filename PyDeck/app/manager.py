from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psutil

PROJECTS_DIR = Path("/data/projects")
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_project_id(project_id: str) -> str:
    if not SAFE_ID.fullmatch(project_id):
        raise ValueError("Invalid project id")
    return project_id


def project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / _safe_project_id(project_id)


def config_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def load_config(project_id: str) -> dict[str, Any]:
    path = config_path(project_id)
    if not path.exists():
        raise FileNotFoundError(project_id)
    return json.loads(path.read_text(encoding="utf-8"))


def save_config(project_id: str, data: dict[str, Any]) -> None:
    config_path(project_id).write_text(json.dumps(data, indent=2), encoding="utf-8")


@dataclass
class Runtime:
    process: subprocess.Popen | None = None
    started_at: float | None = None
    log_lines: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


class ProjectManager:
    def __init__(self) -> None:
        self.runtimes: dict[str, Runtime] = {}
        self._guard = threading.RLock()

    def list_projects(self) -> list[dict[str, Any]]:
        out = []
        for folder in sorted(PROJECTS_DIR.iterdir()):
            if not folder.is_dir() or not (folder / "project.json").exists():
                continue
            pid = folder.name
            cfg = load_config(pid)
            out.append(self.status(pid) | {"name": cfg.get("name", pid)})
        return out

    def create_project(self, project_id: str, name: str | None = None) -> dict[str, Any]:
        project_id = _safe_project_id(project_id)
        folder = project_dir(project_id)
        if folder.exists():
            raise FileExistsError(project_id)
        folder.mkdir(parents=True)
        (folder / "data").mkdir()
        (folder / "main.py").write_text(
            'import time\n\nprint("Hello from PyDeck 👋", flush=True)\n\nwhile True:\n    print("Project is alive", flush=True)\n    time.sleep(10)\n',
            encoding="utf-8",
        )
        (folder / "requirements.txt").write_text("", encoding="utf-8")
        save_config(project_id, {
            "name": name or project_id,
            "entrypoint": "main.py",
            "autostart": False,
            "restart_policy": "on-failure",
            "restart_delay": 3,
        })
        return self.status(project_id)

    def delete_project(self, project_id: str) -> None:
        self.stop(project_id, force=True)
        shutil.rmtree(project_dir(project_id))
        with self._guard:
            self.runtimes.pop(project_id, None)

    def ensure_venv(self, project_id: str) -> Path:
        folder = project_dir(project_id)
        venv = folder / ".venv"
        py = venv / "bin" / "python"
        if not py.exists():
            subprocess.run(["python", "-m", "venv", str(venv)], check=True)
        return venv

    def install_requirements(self, project_id: str) -> None:
        folder = project_dir(project_id)
        venv = self.ensure_venv(project_id)
        req = folder / "requirements.txt"
        if req.exists() and req.read_text(encoding="utf-8").strip():
            subprocess.run(
                [str(venv / "bin" / "pip"), "install", "-r", str(req)],
                cwd=folder,
                check=True,
            )

    def start(self, project_id: str, install: bool = False) -> dict[str, Any]:
        project_id = _safe_project_id(project_id)
        folder = project_dir(project_id)
        if not folder.exists():
            raise FileNotFoundError(project_id)
        cfg = load_config(project_id)
        rt = self.runtimes.setdefault(project_id, Runtime())
        if rt.process and rt.process.poll() is None:
            return self.status(project_id)

        if install:
            self.install_requirements(project_id)
        venv = self.ensure_venv(project_id)
        entry = folder / cfg.get("entrypoint", "main.py")
        if not entry.exists():
            raise FileNotFoundError(str(entry))

        env = os.environ.copy()
        env["PYDECK_PROJECT_ID"] = project_id
        env["PYDECK_PROJECT_DIR"] = str(folder)
        env["PYTHONUNBUFFERED"] = "1"

        proc = subprocess.Popen(
            [str(venv / "bin" / "python"), str(entry)],
            cwd=folder,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
            env=env,
        )
        rt.process = proc
        rt.started_at = time.time()
        self._append_log(rt, f"[PyDeck] started pid={proc.pid}")
        threading.Thread(target=self._reader, args=(project_id, rt), daemon=True).start()
        threading.Thread(target=self._watcher, args=(project_id, rt), daemon=True).start()
        return self.status(project_id)

    def _reader(self, project_id: str, rt: Runtime) -> None:
        proc = rt.process
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            self._append_log(rt, line.rstrip("\n"))

    def _watcher(self, project_id: str, rt: Runtime) -> None:
        proc = rt.process
        if not proc:
            return
        code = proc.wait()
        self._append_log(rt, f"[PyDeck] exited code={code}")
        cfg = load_config(project_id)
        policy = cfg.get("restart_policy", "no")
        should_restart = policy == "always" or (policy == "on-failure" and code != 0)
        if should_restart:
            delay = max(0, int(cfg.get("restart_delay", 3)))
            self._append_log(rt, f"[PyDeck] restarting in {delay}s")
            time.sleep(delay)
            if rt.process is proc:
                try:
                    self.start(project_id)
                except Exception as exc:
                    self._append_log(rt, f"[PyDeck] restart failed: {exc}")

    @staticmethod
    def _append_log(rt: Runtime, line: str) -> None:
        with rt.lock:
            rt.log_lines.append(line)
            if len(rt.log_lines) > 3000:
                del rt.log_lines[:1000]

    def stop(self, project_id: str, force: bool = False) -> dict[str, Any]:
        rt = self.runtimes.get(project_id)
        if not rt or not rt.process or rt.process.poll() is not None:
            return self.status(project_id)
        proc = rt.process
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=8)
        except Exception:
            if force:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    pass
            else:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    pass
        return self.status(project_id)

    def restart(self, project_id: str) -> dict[str, Any]:
        self.stop(project_id, force=True)
        return self.start(project_id)

    def logs(self, project_id: str, tail: int = 500) -> list[str]:
        rt = self.runtimes.setdefault(project_id, Runtime())
        with rt.lock:
            return rt.log_lines[-max(1, min(tail, 3000)):]

    def status(self, project_id: str) -> dict[str, Any]:
        project_id = _safe_project_id(project_id)
        cfg = load_config(project_id)
        rt = self.runtimes.get(project_id)
        running = bool(rt and rt.process and rt.process.poll() is None)
        result: dict[str, Any] = {
            "id": project_id,
            "name": cfg.get("name", project_id),
            "running": running,
            "pid": rt.process.pid if running and rt and rt.process else None,
            "uptime": int(time.time() - rt.started_at) if running and rt and rt.started_at else 0,
            "cpu_percent": 0.0,
            "memory_mb": 0.0,
        }
        if running and rt and rt.process:
            try:
                p = psutil.Process(rt.process.pid)
                result["cpu_percent"] = p.cpu_percent(interval=0.0)
                result["memory_mb"] = round(p.memory_info().rss / 1024 / 1024, 1)
            except psutil.Error:
                pass
        return result

    def autostart(self) -> None:
        for folder in PROJECTS_DIR.iterdir():
            if not folder.is_dir() or not (folder / "project.json").exists():
                continue
            try:
                cfg = load_config(folder.name)
                if cfg.get("autostart"):
                    self.start(folder.name)
            except Exception:
                pass

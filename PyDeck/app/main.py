from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ha_client import call_service, get_state
from manager import PROJECTS_DIR, ProjectManager, load_config, project_dir, save_config

manager = ProjectManager()
WEB_DIR = Path("/web")


class CreateProject(BaseModel):
    id: str
    name: str | None = None


class SaveFile(BaseModel):
    content: str


class SettingsPayload(BaseModel):
    name: str | None = None
    entrypoint: str | None = None
    autostart: bool | None = None
    restart_policy: str | None = None
    restart_delay: int | None = None


class ServiceCallPayload(BaseModel):
    domain: str
    service: str
    data: dict[str, Any] = {}


def safe_file(project_id: str, relpath: str) -> Path:
    base = project_dir(project_id).resolve()
    target = (base / relpath).resolve()
    if base != target and base not in target.parents:
        raise HTTPException(400, "Invalid path")
    if ".venv" in target.parts:
        raise HTTPException(403, "The .venv folder is hidden")
    return target


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.autostart()
    yield
    for p in list(manager.runtimes):
        try:
            manager.stop(p, force=True)
        except Exception:
            pass


app = FastAPI(title="PyDeck", version="0.1.0", lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/app.js")
async def app_js():
    return FileResponse(WEB_DIR / "app.js", media_type="application/javascript")


@app.get("/style.css")
async def style_css():
    return FileResponse(WEB_DIR / "style.css", media_type="text/css")


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "PyDeck", "version": "0.1.0"}


@app.get("/api/projects")
async def projects():
    return {"projects": manager.list_projects()}


@app.post("/api/projects")
async def create_project(payload: CreateProject):
    try:
        return manager.create_project(payload.id, payload.name)
    except FileExistsError:
        raise HTTPException(409, "Project already exists")
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    try:
        manager.delete_project(project_id)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


@app.get("/api/projects/{project_id}/status")
async def status(project_id: str):
    try:
        return manager.status(project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


@app.post("/api/projects/{project_id}/start")
async def start(project_id: str, install: bool = False):
    try:
        return await asyncio.to_thread(manager.start, project_id, install)
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.post("/api/projects/{project_id}/stop")
async def stop(project_id: str):
    try:
        return await asyncio.to_thread(manager.stop, project_id, True)
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.post("/api/projects/{project_id}/restart")
async def restart(project_id: str):
    try:
        return await asyncio.to_thread(manager.restart, project_id)
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.post("/api/projects/{project_id}/install")
async def install(project_id: str):
    try:
        await asyncio.to_thread(manager.install_requirements, project_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/projects/{project_id}/logs")
async def logs(project_id: str, tail: int = 500):
    return {"lines": manager.logs(project_id, tail)}


@app.get("/api/projects/{project_id}/settings")
async def settings(project_id: str):
    try:
        return load_config(project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


@app.put("/api/projects/{project_id}/settings")
async def update_settings(project_id: str, payload: SettingsPayload):
    try:
        cfg = load_config(project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")
    for key, value in payload.model_dump(exclude_none=True).items():
        cfg[key] = value
    if cfg.get("restart_policy") not in {"no", "on-failure", "always"}:
        raise HTTPException(400, "Invalid restart_policy")
    save_config(project_id, cfg)
    return cfg


@app.get("/api/projects/{project_id}/files")
async def files(project_id: str):
    base = project_dir(project_id)
    if not base.exists():
        raise HTTPException(404, "Project not found")
    items = []
    for p in sorted(base.rglob("*")):
        if ".venv" in p.parts:
            continue
        if p.is_file():
            items.append(str(p.relative_to(base)))
    return {"files": items}


@app.get("/api/projects/{project_id}/file")
async def read_file(project_id: str, path: str):
    target = safe_file(project_id, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    try:
        return {"path": path, "content": target.read_text(encoding="utf-8")}
    except UnicodeDecodeError:
        raise HTTPException(415, "Only text files can be edited")


@app.put("/api/projects/{project_id}/file")
async def write_file(project_id: str, path: str, payload: SaveFile):
    target = safe_file(project_id, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload.content, encoding="utf-8")
    return {"ok": True, "path": path}


@app.delete("/api/projects/{project_id}/file")
async def delete_file(project_id: str, path: str):
    target = safe_file(project_id, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    target.unlink()
    return {"ok": True}


@app.get("/api/ha/state/{entity_id:path}")
async def ha_state(entity_id: str):
    try:
        return await get_state(entity_id)
    except Exception as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/ha/service")
async def ha_service(payload: ServiceCallPayload):
    try:
        return await call_service(payload.domain, payload.service, payload.data)
    except Exception as exc:
        raise HTTPException(502, str(exc))


@app.websocket("/api/projects/{project_id}/logs/ws")
async def logs_ws(websocket: WebSocket, project_id: str):
    await websocket.accept()
    sent = 0
    try:
        while True:
            lines = manager.logs(project_id, 3000)
            if sent > len(lines):
                sent = 0
            for line in lines[sent:]:
                await websocket.send_text(line)
            sent = len(lines)
            await asyncio.sleep(0.75)
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8099, log_level="info")

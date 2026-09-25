from __future__ import annotations
import os, json, asyncio, pty, select, struct, fcntl, termios, signal, shutil
from pathlib import Path
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from manager import (
    PROJECTS_DIR, create_project, project_dir, metadata, save_metadata,
    status, start_project, stop_project, restart_project, install_requirements,
    load_env, ensure_venv
)

app = FastAPI(title="PyDeck", version="0.2.0")
WEB = Path("/web")
app.mount("/static", StaticFiles(directory=WEB), name="static")

@app.get("/", response_class=HTMLResponse)
async def home():
    return (WEB/"index.html").read_text()

@app.get("/api/health")
async def health():
    return {"status":"ok","service":"PyDeck","version":"0.2.0"}

@app.get("/api/projects")
async def list_projects():
    items=[]
    for p in sorted(PROJECTS_DIR.iterdir()):
        if p.is_dir():
            pid=p.name
            items.append({"id":pid,"meta":metadata(pid),"runtime":status(pid)})
    return {"projects":items}

@app.post("/api/projects/{project_id}")
async def api_create(project_id: str):
    create_project(project_id)
    return {"ok":True}

@app.delete("/api/projects/{project_id}")
async def api_delete(project_id: str):
    stop_project(project_id)
    p=project_dir(project_id)
    if p.exists():
        shutil.rmtree(p)
    return {"ok":True}

@app.post("/api/projects/{project_id}/start")
async def api_start(project_id: str):
    return {"pid":start_project(project_id)}

@app.post("/api/projects/{project_id}/test")
async def api_test(project_id: str):
    return {"pid":start_project(project_id, extra_args=["--test"])}

@app.post("/api/projects/{project_id}/stop")
async def api_stop(project_id: str):
    stop_project(project_id)
    return {"ok":True}

@app.post("/api/projects/{project_id}/restart")
async def api_restart(project_id: str):
    return {"pid":restart_project(project_id)}

@app.post("/api/projects/{project_id}/install")
async def api_install(project_id: str):
    result = install_requirements(project_id)
    return {"returncode":result.returncode,"stdout":result.stdout,"stderr":result.stderr}

@app.get("/api/projects/{project_id}/status")
async def api_status(project_id: str):
    return status(project_id)

@app.get("/api/projects/{project_id}/files")
async def api_files(project_id: str):
    p=project_dir(project_id)
    if not p.exists():
        raise HTTPException(404)
    out=[]
    for f in p.rglob("*"):
        if ".venv" in f.parts or ".home" in f.parts:
            continue
        if f.is_file():
            out.append(str(f.relative_to(p)))
    return {"files":sorted(out)}

def safe_file(project_id: str, rel: str):
    p=project_dir(project_id)
    f=(p/rel).resolve()
    if p.resolve() not in f.parents and f != p.resolve():
        raise HTTPException(400,"Invalid path")
    return f

@app.get("/api/projects/{project_id}/file")
async def read_file(project_id: str, path: str):
    f=safe_file(project_id,path)
    if not f.exists() or not f.is_file():
        raise HTTPException(404)
    return PlainTextResponse(f.read_text())

@app.put("/api/projects/{project_id}/file")
async def write_file(project_id: str, path: str, body: dict):
    f=safe_file(project_id,path)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(body.get("content",""))
    return {"ok":True}

@app.get("/api/projects/{project_id}/logs")
async def logs(project_id: str):
    p=project_dir(project_id)/"logs"/"runtime.log"
    if not p.exists():
        return PlainTextResponse("")
    return PlainTextResponse(p.read_text(errors="replace")[-200000:])

@app.websocket("/ws/terminal/{project_id}")
async def terminal_ws(ws: WebSocket, project_id: str):
    await ws.accept()
    p = create_project(project_id)
    env = load_env(project_id)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(p)
        os.execvpe("/bin/bash", ["/bin/bash","--noprofile","--norc"], env)

    loop = asyncio.get_running_loop()

    async def reader():
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, fd, 4096)
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass

    read_task = asyncio.create_task(reader())
    try:
        await ws.send_text(f"\r\n[PyDeck] terminal for {project_id}\r\n")
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if "bytes" in msg and msg["bytes"] is not None:
                os.write(fd, msg["bytes"])
            elif "text" in msg and msg["text"] is not None:
                text = msg["text"]
                if text.startswith("__PYDECK_RESIZE__:"):
                    try:
                        _, cols, rows = text.split(":")
                        winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
                    except Exception:
                        pass
                else:
                    os.write(fd, text.encode())
    except WebSocketDisconnect:
        pass
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass
        read_task.cancel()

# autostart
@app.on_event("startup")
async def startup():
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    for p in PROJECTS_DIR.iterdir():
        if p.is_dir():
            cfg = metadata(p.name)
            if cfg.get("autostart"):
                try:
                    start_project(p.name)
                except Exception as e:
                    print(f"[PyDeck] autostart failed for {p.name}: {e}", flush=True)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8099)

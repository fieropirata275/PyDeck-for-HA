# PyDeck for Home Assistant

PyDeck is a Home Assistant App/add-on that manages persistent Python projects from an Ingress UI.

## What works in this MVP
- Create/delete projects
- Edit project files in the browser
- Start / stop / restart Python processes
- Per-project `.venv`
- Install `requirements.txt`
- Autostart and restart policies
- Live-ish logs and CPU/RAM/PID/uptime stats
- Access to Home Assistant through Supervisor/Core API
- Persistent project storage under `/data/projects`

## Local installation
1. Install the **Samba share** or **Studio Code Server** app if you need an easy way to access Home Assistant files.
2. Copy the **contents of the `pydeck` folder** into:
   `/addons/pydeck/`
3. In Home Assistant go to **Settings → Apps → App Store**.
4. Open the menu and choose **Check for updates / Reload** so local apps are rescanned.
5. Open **PyDeck**, install it, start it, and enable **Show in sidebar**.

If your Home Assistant installation exposes local add-ons under a slightly different UI label, the on-disk folder remains the local add-on/app folder used by Supervisor.

## Project format
A project lives under `/data/projects/<id>/` and normally contains:

- `main.py`
- `requirements.txt`
- `project.json`
- `data/`

Example `project.json`:

```json
{
  "name": "RainGuard",
  "entrypoint": "main.py",
  "autostart": true,
  "restart_policy": "on-failure",
  "restart_delay": 3
}
```

## Home Assistant API from a project
The app has `homeassistant_api: true`, so projects inherit `SUPERVISOR_TOKEN` and can call HA Core through:

`http://supervisor/core/api`

Example:

```python
import os, requests

token = os.environ["SUPERVISOR_TOKEN"]
headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

r = requests.get(
    "http://supervisor/core/api/states/sensor.temperature",
    headers=headers,
    timeout=10,
)
print(r.json())
```

If the project uses `requests`, add `requests` to that project's `requirements.txt` and click **Install deps**.

## Security note
PyDeck executes arbitrary Python inside the PyDeck app container. It intentionally does **not** mount the Docker socket and is not privileged. Still, arbitrary Python can access resources available to this app, including the Home Assistant API token inherited by the process, so only trusted administrators should have access to PyDeck.


## 0.1.1
- Removed deprecated `build.yaml`.
- Dockerfile now uses `python:3.13-slim` directly, avoiding Home Assistant base-image fallback and the Alpine/`apt-get` build failure.

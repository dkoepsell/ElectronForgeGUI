# ⚡ Electron Forge GUI

A drag-and-drop local web GUI for packaging **Node/Electron** and **Python** apps into standalone desktop executables — no command line required.

Runs as a local Express server at `http://localhost:3847`. Drop in a zip of your project, configure options, click Build, download your `.exe` (or `.dmg`, `AppImage`).

---

## Features

- **Python apps** — auto-detects Flask, FastAPI, Django, Replit projects; builds with PyInstaller into a single `.exe`
- **Node/Electron apps** — packages with `electron-builder` for Windows, macOS, Linux
- **Live build log** — streaming WebSocket output in the browser
- **AI guide panel** — explains each step as it runs
- **Auto-detection** — entry point, port, framework, dependencies, env vars
- **Replit support** — parses `.replit` TOML, detects `.pythonlibs/`, handles `$PORT`
- **Smart dependency install** — PEP 621 `pyproject.toml`, Poetry, `requirements.txt`, Pipfile, plus source import scanning as fallback
- **Package data bundling** — automatically handles owlready2 (Pellet/HermiT reasoners), rdflib plugins, NLTK corpora

---

## Requirements

- **Node.js 18+** and npm
- **Python 3.8+** on PATH (for Python builds)
- Windows, macOS, or Linux

---

## Setup

```bash
git clone https://github.com/dkoepsell/electron-forge-gui.git
cd electron-forge-gui
npm install
npm start
```

Then open **http://localhost:3847** in your browser.

On Windows you can also run `start.sh` via Git Bash.

---

## Usage

### Python app

1. Zip your Python project (Flask, FastAPI, Django, plain script, or Replit export)
2. Drop the zip into the GUI
3. The tool auto-detects framework, entry point, port, and dependencies
4. Review the config panel — adjust entry point, hidden imports, or extra data files if needed
5. Click **Build**
6. Download the `.exe` when complete

**First run** of the exe will download any NLTK corpora (wordnet etc.) to `~/nltk_data` if your app uses them. Subsequent runs use the cached data.

### Node/Electron app

1. Zip your Electron project (must include `package.json` with `electron-builder` config)
2. Drop and configure targets (Windows / macOS / Linux)
3. Click **Build**

---

## Python build modes

| Mode | Description |
|------|-------------|
| **PyInstaller standalone** | Single `.exe` that launches the app and opens a browser window |
| **Electron wrapper** | Python server binary embedded inside an Electron shell (custom window chrome) |

---

## Supported dependency formats

- `pyproject.toml` — PEP 621 `[project].dependencies` array, or `[tool.poetry.dependencies]`
- `requirements.txt`
- `Pipfile`
- Source import scanning (fallback — scans all `.py` files and maps imports to pip packages)

---

## Notes

- Uploads stored in `./uploads/`, build artifacts in `./builds/<id>/output/`
- Change port with `PORT=8080 npm start` (default: **3847**)
- gunicorn is not supported inside PyInstaller — entry point is resolved to the underlying module

---

## License

MIT

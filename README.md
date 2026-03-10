# ⚡ Electron Forge GUI

A local web-based GUI for building Electron packages into platform executables via drag & drop.

## Requirements

- Node.js 18+ 
- npm 8+
- Linux/macOS: `tar` command available (built-in)
- For cross-platform builds: Wine (Windows executables on Linux/macOS), appropriate SDKs

## Setup

```bash
cd electron-forge-gui
npm install
npm start
```

Then open **http://localhost:3847** in your browser.

## Usage

1. **Drop** a `.zip`, `.tar.gz`, or `.tgz` of your Electron project into the drop zone (or click to browse).
   - Your archive must contain a valid `package.json` with `build` config for `electron-builder`
   
2. **Select targets**: Windows, macOS, Linux (toggle to deselect)

3. **Configure** optional overrides (app name, version, compression)

4. **Click Build** — watch the live log output

5. **Download** generated executables when the build completes

## Your package.json must include electron-builder config:

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "main": "main.js",
  "build": {
    "appId": "com.example.myapp",
    "productName": "My App",
    "directories": { "output": "dist" },
    "win": { "target": "nsis" },
    "mac": { "target": "dmg" },
    "linux": { "target": "AppImage" }
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.0.0"
  }
}
```

## Notes

- Uploads are stored in `./uploads/`
- Build artifacts are in `./builds/<buildId>/output/`
- Cross-platform builds require the corresponding OS or emulation layer
- Code signing requires valid certificates configured in electron-builder

## Port

Default port: **3847** — change with `PORT=8080 npm start`

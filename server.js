const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// When packaged (pkg or Electron asar), __dirname is read-only.
// Use a writable sibling folder next to the executable instead.
const DATA_ROOT = (() => {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'electron-forge-data');
  }
  if (process.versions && process.versions.electron) {
    const exeDir = process.platform === 'darwin'
      ? path.join(path.dirname(process.execPath), '..', '..', '..')
      : path.dirname(process.execPath);
    return path.join(exeDir, 'electron-forge-data');
  }
  return __dirname;
})();

const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const BUILDS_DIR = path.join(DATA_ROOT, 'builds');

[UPLOAD_DIR, BUILDS_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    console.log(`[init] directory ready: ${dir}`);
  } catch (e) {
    console.error(`[init] FAILED to create directory ${dir}:`, e.message);
    process.exit(1);
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${sanitized}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.tar', '.tgz', '.html', '.htm', '.ipynb'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.originalname.endsWith('.tar.gz')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Supported: .zip, .tar.gz, .html, .ipynb`));
    }
  }
});

const activeBuilds = new Map();
const connectedClients = new Set();

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  ws.on('close', () => connectedClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── Data/output file detection (shared by analyze + build pipelines) ──────────
const DATA_DIRS = new Set([
  'data','output','outputs','exports','results','cache','datasets',
  'raw','processed','generated','tmp','temp','logs','figures','plots',
  'archive','archives','backup','backups','dump','dumps','scratch',
]);
const DATA_EXTS = new Set([
  '.csv','.tsv','.parquet','.feather','.arrow','.hdf5','.h5',
  '.pkl','.pickle','.npy','.npz',
  '.db','.sqlite','.sqlite3',
  '.log','.out','.cache',
  '.xlsx','.xls',  // data exports (not code)
  '.bin','.dat',
]);
// Minimum file size to auto-exclude loose data files (1 MB — avoids excluding small fixtures)
const DATA_FILE_MIN_BYTES = 1024 * 1024;

/** Yield to the Node event loop so WebSocket messages flush. Call between heavy sync steps. */
function flushEventLoop() { return new Promise(r => setImmediate(r)); }

/**
 * Scan a directory for data files/dirs to exclude from packaging.
 * Returns { excludedItems, totalFiles, skippedDataFiles }
 * logFn(level, msg) is optional — called to emit real-time progress.
 */
async function detectDataFiles(dir, logFn) {
  const log2 = logFn || (() => {});
  let totalFiles = 0, skippedDataFiles = 0;
  const excludedItems = [];

  // Count files in a directory — async to avoid blocking on large data trees
  async function countFilesDeep(d, depth) {
    if (depth === undefined) depth = 0;
    let n = 0;
    let entries;
    try { entries = fs.readdirSync(d); } catch(_) { return 0; }
    for (const e of entries) {
      const fp = path.join(d, e);
      try {
        const st = fs.statSync(fp);
        if (st.isDirectory()) {
          n += await countFilesDeep(fp, depth + 1);
          if (depth === 0) await flushEventLoop(); // yield at each top-level subdir
        } else {
          n++;
        }
      } catch(_) {}
    }
    return n;
  }

  // Process one level at a time so we can yield
  async function scanDir(d, depth) {
    let entries;
    try { entries = fs.readdirSync(d); } catch(_) { return; }

    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === '__pycache__') continue;
      const fp = path.join(d, e);
      try {
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) {
          const nameLow = e.toLowerCase();
          if (depth <= 2 && DATA_DIRS.has(nameLow)) {
            const n = await countFilesDeep(fp);
            skippedDataFiles += n; totalFiles += n;
            excludedItems.push({ type: 'dir', name: e, path: fp, count: n, reason: 'data/output directory' });
            log2('warn', `  📂 ${e}/ — ${n} file${n!==1?'s':''} (data dir, excluded from build)`);
          } else if (depth < 4) {
            await scanDir(fp, depth + 1);
          }
        } else {
          totalFiles++;
          const xtn = path.extname(e).toLowerCase();
          const sz = stat.size;
          if (DATA_EXTS.has(xtn) && sz >= DATA_FILE_MIN_BYTES) {
            skippedDataFiles++;
            excludedItems.push({ type: 'file', name: e, path: fp, size: sz, reason: `large ${xtn} data file` });
            log2('warn', `  📄 ${e} (${formatBytes(sz)}) — data file, excluded from build`);
          }
        }
      } catch(_) {}
    }
    await flushEventLoop();
  }

  await scanDir(dir, 0);
  return { excludedItems, totalFiles, skippedDataFiles };
}

/**
 * Copy a directory, skipping excluded paths (by absolute path) and
 * always skipping node_modules / __pycache__ / .git.
 */
function copyDirFiltered(src, dst, excludedPaths) {
  const excluded = new Set(excludedPaths || []);
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue;
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    if (excluded.has(srcPath)) continue;
    try {
      if (fs.statSync(srcPath).isDirectory()) copyDirFiltered(srcPath, dstPath, excluded);
      else fs.copyFileSync(srcPath, dstPath);
    } catch(_) {}
  }
}


function log(buildId, level, message) {
  broadcast({ type: 'log', buildId, level, message, timestamp: new Date().toISOString() });
  console.log(`[${buildId}] [${level}] ${message}`);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

const PLATFORM = process.platform;
const NATIVE_TARGETS = {
  win32:  { win: true,  mac: false, linux: false },
  darwin: { win: false, mac: true,  linux: false },
  linux:  { win: false, mac: false, linux: true  },
};

// ═══════════════════════════════════════════════════════════════
// STACK ANALYSIS
// ═══════════════════════════════════════════════════════════════

// ── Python project detector ───────────────────────────────────
function analyzePythonProject(appDir) {
  const readSafe = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
  const existsIn = (...parts) => fs.existsSync(path.join(appDir, ...parts));

  // ── Replit detection ──────────────────────────────────────────
  const hasReplitFile  = existsIn('.replit');
  const hasReplitNix   = existsIn('replit.nix');
  const hasPythonLibs  = existsIn('.pythonlibs');
  const isReplit       = hasReplitFile || hasReplitNix;

  // Parse .replit TOML (simple regex — no toml dep needed)
  let replitRunCmd = '', replitEntrypoint = '', replitAppName = '';
  if (hasReplitFile) {
    const replitRaw = readSafe(path.join(appDir, '.replit'));
    const runMatch   = replitRaw.match(/^run\s*=\s*["'](.+?)["']/m)
                    || replitRaw.match(/^run\s*=\s*\[.*?"([^"]+\.py)"/m);
    const entryMatch = replitRaw.match(/^entrypoint\s*=\s*["'](.+?)["']/m);
    const nameMatch  = replitRaw.match(/^name\s*=\s*["'](.+?)["']/m);
    replitRunCmd     = runMatch    ? runMatch[1]    : '';
    replitEntrypoint = entryMatch  ? entryMatch[1]  : '';
    replitAppName    = nameMatch   ? nameMatch[1]   : '';
    // Extract python file from run command like "python app.py" or "gunicorn app:app"
    if (!replitEntrypoint && replitRunCmd) {
      const pyMatch = replitRunCmd.match(/python\d*\s+([^\s]+\.py)/);
      if (pyMatch) replitEntrypoint = pyMatch[1];
    }
  }

  // ── Python project markers ────────────────────────────────────
  const hasReqTxt    = existsIn('requirements.txt');
  const hasSetupPy   = existsIn('setup.py');
  const hasPyproject = existsIn('pyproject.toml');
  const hasCondaEnv  = existsIn('environment.yml') || existsIn('environment.yaml');
  const hasPipfile   = existsIn('Pipfile');
  const hasPoetryLock= existsIn('poetry.lock');
  const isPython     = hasReqTxt || hasSetupPy || hasPyproject || hasCondaEnv || hasPipfile || isReplit;
  if (!isPython) return null;

  // Check if pyproject.toml uses Poetry
  const pyprojectRaw = readSafe(path.join(appDir, 'pyproject.toml'));
  const hasPoetry    = /\[tool\.poetry\]/.test(pyprojectRaw);

  const reqTxt   = readSafe(path.join(appDir, 'requirements.txt')).toLowerCase();
  const pyproj   = pyprojectRaw.toLowerCase();
  const setuppy  = readSafe(path.join(appDir, 'setup.py')).toLowerCase();
  const allDeps  = reqTxt + pyproj + setuppy;

  // Scan .py files for imports
  let sourceScan = '';
  try {
    fs.readdirSync(appDir).forEach(f => {
      if (f.endsWith('.py')) sourceScan += readSafe(path.join(appDir, f));
    });
  } catch(_) {}

  // ── Framework detection ───────────────────────────────────────
  const hasFlask   = /\bflask\b/.test(allDeps) || /import flask|from flask/.test(sourceScan.toLowerCase());
  const hasFastAPI = /\bfastapi\b/.test(allDeps) || /import fastapi|from fastapi/.test(sourceScan.toLowerCase());
  const hasDjango  = /\bdjango\b/.test(allDeps) || /import django|from django/.test(sourceScan.toLowerCase());
  const hasTornado = /\btornado\b/.test(allDeps);
  const hasBottle  = /\bbottle\b/.test(allDeps);
  const hasGunicorn= /\bgunicorn\b/.test(allDeps) || /gunicorn/.test(replitRunCmd);
  const isWebApp   = hasFlask || hasFastAPI || hasDjango || hasTornado || hasBottle;

  // GUI frameworks
  const hasTkinter   = /\btkinter\b/.test(allDeps) || /import tkinter|from tkinter/.test(sourceScan.toLowerCase());
  const hasQtPy      = /\bpyqt[56]?\b|\bpyside[26]?\b/.test(allDeps);
  const hasWxPython  = /\bwxpython\b/.test(allDeps);
  const hasKivy      = /\bkivy\b/.test(allDeps);
  const hasDearpygui = /\bdearpygui\b/.test(allDeps);
  const isNativeGui  = hasTkinter || hasQtPy || hasWxPython || hasKivy || hasDearpygui;

  // Services / ML
  const hasOpenAI    = /\bopenai\b/.test(allDeps);
  const hasAnthropic = /\banthropic\b/.test(allDeps);
  const hasNumpy     = /\bnumpy\b/.test(allDeps);
  const hasPandas    = /\bpandas\b/.test(allDeps);
  const hasTorch     = /\btorch\b/.test(allDeps);
  const hasTF        = /\btensorflow\b/.test(allDeps);
  const isDataScience= hasNumpy || hasPandas || hasTorch || hasTF;
  const hasUvicorn   = /\buvicorn\b/.test(allDeps);

  // ── Entry point detection (Replit .replit file wins) ─────────
  // Also parse gunicorn "module:app" syntax from run command
  let replitModuleEntry = '';
  if (replitRunCmd) {
    // "gunicorn --bind 0.0.0.0:5000 main:app" → main.py
    const gunicornMatch = replitRunCmd.match(/(\w+):(\w+)\s*$/);
    if (gunicornMatch) replitModuleEntry = gunicornMatch[1] + '.py';
  }
  const commonEntries = ['main.py','app.py','run.py','server.py','wsgi.py','asgi.py','manage.py','__main__.py'];
  const entryPoint = replitEntrypoint
    || (replitModuleEntry && existsIn(replitModuleEntry) ? replitModuleEntry : null)
    || commonEntries.find(e => existsIn(e))
    || null;

  // ── Port detection ────────────────────────────────────────────
  // Replit defaults to 8080 (or reads $PORT). Check source for explicit port.
  const portMatch = sourceScan.match(/port\s*[=:]\s*(\d{4,5})/i)
                 || sourceScan.match(/\.run\([^)]*port\s*=\s*(\d+)/i);
  const usesEnvPort = /os\.environ.*PORT|getenv.*PORT|\$PORT/.test(sourceScan);
  const detectedPort = portMatch
    ? portMatch[1]
    : isReplit ? '8080'
    : hasFlask ? '5000'
    : hasFastAPI ? '8000'
    : '8080';

  // Detect Replit env vars referenced in source
  const replitEnvVars = [];
  const envVarMatches = sourceScan.matchAll(/os\.environ(?:\.get)?\s*\(\s*["']([A-Z_]+)["']/g);
  for (const m of envVarMatches) {
    if (!replitEnvVars.includes(m[1])) replitEnvVars.push(m[1]);
  }
  // Filter out standard ones we handle automatically
  const requiredEnvVars = replitEnvVars.filter(v => !['PORT','HOST','DEBUG'].includes(v));

  // ── App name ──────────────────────────────────────────────────
  let appName = 'python-app';
  try {
    if (replitAppName) {
      appName = replitAppName;
    } else {
      const nm = pyprojectRaw.match(/name\s*=\s*["']([^"']+)["']/);
      const dirName = path.basename(appDir).replace(/-main$|-master$|-nix-workspace$|repl-/, '');
      appName = nm ? nm[1] : (dirName || 'python-app');
    }
    appName = appName.replace(/[^a-zA-Z0-9_-]/g, '-');
  } catch(_) {}

  // ── App type label ────────────────────────────────────────────
  let appType = 'cli', appTypeLabel = 'CLI / Script';
  if (isWebApp)     { appType = 'web'; appTypeLabel = hasFlask ? 'Flask' : hasFastAPI ? 'FastAPI' : hasDjango ? 'Django' : 'Web App'; }
  else if (isNativeGui) { appType = 'gui'; appTypeLabel = hasTkinter ? 'Tkinter' : hasQtPy ? 'PyQt/PySide' : hasWxPython ? 'wxPython' : hasKivy ? 'Kivy' : 'Native GUI'; }

  // ── Issues & suggestions ──────────────────────────────────────
  const issues = [], suggestions = [];

  if (isReplit) {
    issues.push({ level: 'info', icon: '🟢', title: 'Replit project detected',
      detail: `This is a Replit project${replitEntrypoint ? ` — entry point "${replitEntrypoint}" read from .replit file` : ''}. Dependencies will be installed fresh into a build virtualenv (Replit's .pythonlibs are not portable). ${usesEnvPort ? 'App reads $PORT from environment — will be set to ' + detectedPort + ' in the packaged exe.' : ''}` });
  }

  if (isWebApp) {
    issues.push({ level: 'info', icon: '🌐', title: `${appTypeLabel} web app detected`,
      detail: `Two packaging options: PyInstaller Standalone bundles Python into a single .exe that starts the server and opens a browser. Electron Wrapper shows the app in a dedicated window instead.` });
  } else if (isNativeGui) {
    issues.push({ level: 'info', icon: '🖼️', title: `${appTypeLabel} native GUI detected`,
      detail: `PyInstaller will bundle Python and all dependencies into a standalone executable.` });
  } else {
    issues.push({ level: 'info', icon: '⌨️', title: 'CLI / script detected',
      detail: `PyInstaller packages this into a standalone executable that opens a terminal window when launched.` });
  }

  if (!entryPoint) {
    issues.push({ level: 'setup', icon: '📄', title: 'Entry point not auto-detected',
      detail: `No .replit entrypoint or common entry files (app.py, main.py…) found. Specify the entry point below.` });
  }

  if (hasPoetry) {
    issues.push({ level: 'info', icon: '📦', title: 'Poetry project detected',
      detail: `Dependencies will be installed via "pip install ." from pyproject.toml. No requirements.txt needed.` });
  }

  if (requiredEnvVars.length > 0) {
    issues.push({ level: 'warn', icon: '🔑', title: `${requiredEnvVars.length} env var(s) detected in source`,
      detail: `The app reads: ${requiredEnvVars.join(', ')}. Add these as environment variables in the build config below, or the packaged exe may crash at runtime.` });
  }

  if (isDataScience) {
    issues.push({ level: 'info', icon: '🔬', title: 'Data science libraries — expect large bundle',
      detail: `NumPy, Pandas, PyTorch, or TensorFlow add 200MB+ to the packaged executable.` });
  }

  if (hasQtPy) {
    issues.push({ level: 'info', icon: '⚠️', title: 'Qt apps may need hidden imports',
      detail: `PyQt/PySide sometimes needs extra --hidden-import entries. Add missing modules to Hidden Imports if the app crashes.` });
  }

  if (hasTkinter) {
    suggestions.push({ icon: '✅', title: 'Tkinter bundles cleanly', detail: 'Part of Python stdlib — included automatically.' });
  }

  if (hasGunicorn) {
    issues.push({ level: 'warn', icon: '⚠️', title: 'Gunicorn detected',
      detail: `Gunicorn is a production server that doesn't work inside a PyInstaller bundle. The launcher will run your app directly with Flask/FastAPI's built-in server instead.` });
  }

  // ── Stack badges ──────────────────────────────────────────────
  const stack = [{ label: 'Python', color: 'blue' }];
  if (isReplit)   stack.push({ label: 'Replit',       color: 'amber' });
  if (hasFlask)   stack.push({ label: 'Flask',        color: 'orange' });
  if (hasFastAPI) stack.push({ label: 'FastAPI',      color: 'emerald' });
  if (hasDjango)  stack.push({ label: 'Django',       color: 'green' });
  if (hasGunicorn)stack.push({ label: 'Gunicorn',     color: 'purple' });
  if (hasTkinter) stack.push({ label: 'Tkinter',      color: 'cyan' });
  if (hasQtPy)    stack.push({ label: 'PyQt/PySide',  color: 'indigo' });
  if (hasWxPython)stack.push({ label: 'wxPython',     color: 'purple' });
  if (hasKivy)    stack.push({ label: 'Kivy',         color: 'amber' });
  if (hasTorch)   stack.push({ label: 'PyTorch',      color: 'orange' });
  if (hasTF)      stack.push({ label: 'TensorFlow',   color: 'amber' });
  if (hasPandas)  stack.push({ label: 'Pandas',       color: 'blue' });
  if (hasOpenAI)  stack.push({ label: 'OpenAI',       color: 'emerald' });
  if (hasAnthropic)stack.push({ label: 'Claude API',  color: 'purple' });
  if (hasUvicorn) stack.push({ label: 'Uvicorn',      color: 'cyan' });
  if (hasPoetry)  stack.push({ label: 'Poetry',       color: 'indigo' });

  return {
    language: 'python',
    appName, version: '1.0.0', description: '',
    appDir, appType, appTypeLabel,
    isWebApp, isNativeGui, isReplit,
    hasFlask, hasFastAPI, hasDjango, hasGunicorn,
    hasTkinter, hasQtPy, hasWxPython, hasKivy,
    isDataScience, hasOpenAI, hasAnthropic,
    hasPoetry, hasPythonLibs,
    entryPoint, detectedPort, usesEnvPort,
    requiredEnvVars,
    canUseElectron: isWebApp,
    canUsePyInstaller: true,
    hasReqTxt, hasPyproject,
    issues, suggestions, stack,
  };
}

// ── R/Shiny analysis ──────────────────────────────────────────
function analyzeRProject(extractDir) {
  function findRRoot(dir, depth = 0) {
    const markers = ['app.R', 'server.R', 'ui.R', 'global.R'];
    for (const m of markers) {
      if (fs.existsSync(path.join(dir, m))) return dir;
    }
    if (depth >= 1) return null;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const sub = path.join(dir, entry);
        try {
          if (fs.statSync(sub).isDirectory() && !entry.startsWith('.')) {
            const found = findRRoot(sub, depth + 1);
            if (found) return found;
          }
        } catch(_) {}
      }
    } catch(_) {}
    return null;
  }

  const appDir = findRRoot(extractDir);
  if (!appDir) return null;

  const hasCombined = fs.existsSync(path.join(appDir, 'app.R'));
  const hasSplit = fs.existsSync(path.join(appDir, 'server.R'));
  const hasGlobal = fs.existsSync(path.join(appDir, 'global.R'));
  const hasRenv = fs.existsSync(path.join(appDir, 'renv.lock'));
  const hasDescription = fs.existsSync(path.join(appDir, 'DESCRIPTION'));

  // Detect port from app.R if set
  let detectedPort = '3838';
  const entryFile = hasCombined ? 'app.R' : 'server.R';
  try {
    const src = fs.readFileSync(path.join(appDir, entryFile), 'utf8');
    const portMatch = src.match(/port\s*=\s*(\d+)/);
    if (portMatch) detectedPort = portMatch[1];
  } catch(_) {}

  const appName = path.basename(appDir)
    .replace(/-main$/, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-') || 'shiny-app';

  const stack = [{ label: 'R/Shiny' }];
  if (hasRenv) stack.push({ label: 'renv' });
  if (hasDescription) stack.push({ label: 'R package' });

  const issues = [];
  issues.push({
    level: 'info', icon: '📦',
    title: 'R runtime required on target machine',
    detail: 'The packaged exe will launch R + Shiny locally. R must be installed at a known path (or bundled). Users without R can install it from r-project.org.',
  });
  if (!hasRenv) {
    issues.push({
      level: 'warn', icon: '⚠️',
      title: 'No renv.lock found',
      detail: 'Package versions are not pinned. Add renv::init() to lock dependencies for reproducible builds.',
    });
  }

  return {
    appType: 'r-shiny',
    appDir,
    appName,
    entryPoint: entryFile,
    detectedPort,
    hasRenv,
    stack,
    issues,
    suggestions: [],
    canUseElectron: true,
    language: 'r',
  };
}

// ── Static site analysis ──────────────────────────────────────
function analyzeStaticSite(extractDir) {
  // Also handles pre-built dist/build/out folders from any framework.
  // Finds index.html in: root, one level deep, or inside dist/build/out subdirs.
  function findIndexHtml(dir, depth = 0) {
    // Check pre-built output dirs first
    for (const outDir of ['dist', 'build', 'out']) {
      const candidate = path.join(dir, outDir, 'index.html');
      if (fs.existsSync(candidate)) return { dir: path.join(dir, outDir), isPrebuilt: true, outDirName: outDir };
    }
    // public/ and www/ are source dirs — check them but NOT as prebuilt
    for (const outDir of ['public', 'www']) {
      const candidate = path.join(dir, outDir, 'index.html');
      if (fs.existsSync(candidate)) return { dir: path.join(dir, outDir), isPrebuilt: false, outDirName: outDir };
    }
    // Check root
    if (fs.existsSync(path.join(dir, 'index.html'))) return { dir, isPrebuilt: false };
    if (depth >= 1) return null;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const sub = path.join(dir, entry);
        try {
          if (fs.statSync(sub).isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
            const found = findIndexHtml(sub, depth + 1);
            if (found) return found;
          }
        } catch(_) {}
      }
    } catch(_) {}
    return null;
  }

  const found = findIndexHtml(extractDir);
  if (!found) return null;

  const { dir: appDir, isPrebuilt, outDirName } = found;

  // If there's a package.json with a main/server entry or backend deps, let
  // the Node/Python analyzers handle it instead.
  // Exception: if we found a pre-built dist/ inside the project, treat as static.
  // Always check for backend deps — even inside public/ or dist/
  // package.json may be one or two levels up from where index.html was found
  {
    const pkgCandidates = [
      path.join(appDir, 'package.json'),
      path.join(appDir, '..', 'package.json'),
      path.join(appDir, '..', '..', 'package.json'),
    ];
    for (const pkgPath of pkgCandidates) {
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
          const hasBackend = !!(allDeps.express || allDeps.fastify || allDeps.koa ||
            allDeps['@hono/node-server'] || pkg.main);
          if (hasBackend) return null;
        } catch(_) {}
        break;
      }
    }
  }

  // Detect visualization libraries
  let fileCount = 0;
  let hasD3 = false, hasThree = false, hasP5 = false, hasCesium = false, hasPlotly = false;
  const extensions = new Set(['.html','.htm','.js','.mjs','.css','.json',
    '.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2','.ttf','.map','.wasm']);

  function scanFiles(d) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.startsWith('.') || f === 'node_modules') continue;
        const fp = path.join(d, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) { scanFiles(fp); continue; }
          if (extensions.has(path.extname(f).toLowerCase())) fileCount++;
          if (f.endsWith('.js') || f.endsWith('.html')) {
            try {
              const src = fs.readFileSync(fp, 'utf8');
              if (src.includes('d3') || src.includes('d3.js')) hasD3 = true;
              if (src.includes('three') || src.includes('THREE')) hasThree = true;
              if (src.includes('p5') || src.includes('p5.js')) hasP5 = true;
              if (src.includes('Cesium') || src.includes('cesium')) hasCesium = true;
              if (src.includes('Plotly') || src.includes('plotly')) hasPlotly = true;
            } catch(_) {}
          }
        } catch(_) {}
      }
    } catch(_) {}
  }
  scanFiles(appDir);

  const stack = [{ label: isPrebuilt ? `Pre-built (${outDirName}/)` : 'Static HTML/JS' }];
  if (hasD3) stack.push({ label: 'D3.js' });
  if (hasThree) stack.push({ label: 'Three.js' });
  if (hasP5) stack.push({ label: 'p5.js' });
  if (hasCesium) stack.push({ label: 'CesiumJS' });
  if (hasPlotly) stack.push({ label: 'Plotly' });

  const appName = path.basename(isPrebuilt ? path.dirname(appDir) : appDir)
    .replace(/-main$/, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-') || 'app';

  return {
    appType: 'static',
    appDir,
    appName,
    fileCount,
    isPrebuilt,
    outDirName,
    stack,
    issues: [],
    suggestions: [],
    canUseElectron: true,
  };
}

// ── Node/JS analysis (original) ───────────────────────────────
function analyzeProject(extractDir) {
  // Check for static site first — index.html with no package.json / no server
  const staticAnalysis = analyzeStaticSite(extractDir);
  if (staticAnalysis) return staticAnalysis;

  // Check for R/Shiny
  const rAnalysis = analyzeRProject(extractDir);
  if (rAnalysis) return rAnalysis;

  // Check for Python first — no package.json needed
  const pkgPath = findPackageJson(extractDir);
  if (!pkgPath) {
    const pyAnalysis = analyzePythonProject(extractDir);
    if (pyAnalysis) return pyAnalysis;
    // Try one level deep (GitHub ZIP: reponame-main/...)
    try {
      for (const entry of fs.readdirSync(extractDir)) {
        const sub = path.join(extractDir, entry);
        try { if (fs.statSync(sub).isDirectory()) { const py = analyzePythonProject(sub); if (py) return py; } } catch(_){}
      }
    } catch(_) {}
    return null;
  }

  const appDir = path.dirname(pkgPath);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch (e) { return null; }



  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};

  // Electron state
  const hasElectronBuilder = !!(pkg.build);
  const hasForgeConfig = !!(pkg.config && pkg.config.forge) || !!(allDeps['@electron-forge/cli']);
  const hasElectronDep = !!(allDeps.electron);
  const mainFile = pkg.main || '';
  const hasElectronMain = mainFile.toLowerCase().includes('electron') ||
    fs.existsSync(path.join(appDir, 'electron', 'main.js')) ||
    fs.existsSync(path.join(appDir, 'electron', 'main.ts'));
  const isElectronConfigured = (hasElectronBuilder || hasForgeConfig) && hasElectronMain;

  // Framework
  const hasTypeScript = !!(allDeps.typescript || fs.existsSync(path.join(appDir, 'tsconfig.json')));
  const hasVite = !!(allDeps.vite ||
    fs.existsSync(path.join(appDir, 'vite.config.ts')) ||
    fs.existsSync(path.join(appDir, 'vite.config.js')));
  const hasReact = !!(allDeps.react);
  const hasVue = !!(allDeps.vue);
  const hasSvelte = !!(allDeps.svelte);

  // Database
  const hasDrizzle = !!(allDeps['drizzle-orm']);
  const hasPrisma = !!(allDeps['@prisma/client'] || allDeps.prisma);
  const hasPg = !!(allDeps.pg || allDeps.postgres || allDeps['@neondatabase/serverless']);
  const hasMysql = !!(allDeps.mysql2 || allDeps.mysql);
  const hasSqlite = !!(allDeps['better-sqlite3'] || allDeps['sqlite3']);
  const hasDatabase = hasDrizzle || hasPrisma || hasPg || hasMysql || hasSqlite;
  const dbType = (hasPg || (hasDrizzle && !hasSqlite)) ? 'postgresql' :
    hasMysql ? 'mysql' :
    hasSqlite ? 'sqlite' : null;

  // Services
  const hasOpenAI = !!(allDeps.openai);
  const hasAnthropic = !!(allDeps['@anthropic-ai/sdk']);
  const hasDiscord = !!(allDeps['discord.js'] || allDeps['discord-api-types']);
  const hasStripe = !!(allDeps.stripe);

  // Structure
  const hasServerDir = fs.existsSync(path.join(appDir, 'server'));
  const hasClientDir = fs.existsSync(path.join(appDir, 'client'));
  const isFullStack = hasServerDir && hasClientDir;
  const hasMigrations = fs.existsSync(path.join(appDir, 'migrations')) ||
    fs.existsSync(path.join(appDir, 'drizzle'));

  // Required env vars
  const requiredEnvVars = [];
  const optionalEnvVars = [];

  if (dbType === 'postgresql') {
    requiredEnvVars.push({ key: 'DATABASE_URL', description: 'PostgreSQL connection string', example: 'postgres://user:password@host:5432/dbname', placeholder: 'postgres://user:password@localhost:5432/myapp' });
  } else if (dbType === 'mysql') {
    requiredEnvVars.push({ key: 'DATABASE_URL', description: 'MySQL connection string', example: 'mysql://user:password@host:3306/dbname', placeholder: 'mysql://user:password@localhost:3306/myapp' });
  }
  if (hasOpenAI) requiredEnvVars.push({ key: 'OPENAI_API_KEY', description: 'OpenAI API key for AI features', example: 'sk-proj-...', placeholder: 'sk-proj-...' });
  if (hasAnthropic) requiredEnvVars.push({ key: 'ANTHROPIC_API_KEY', description: 'Anthropic Claude API key', example: 'sk-ant-...', placeholder: 'sk-ant-...' });
  if (hasDiscord) {
    optionalEnvVars.push({ key: 'DISCORD_BOT_TOKEN', description: 'Discord bot token', example: 'MTI3...', placeholder: 'MTI3...' });
  }
  if (hasStripe) requiredEnvVars.push({ key: 'STRIPE_SECRET_KEY', description: 'Stripe secret key', example: 'sk_live_...', placeholder: 'sk_test_...' });
  optionalEnvVars.push({ key: 'PORT', description: 'Server port (defaults to 3000)', example: '3000', placeholder: '3000', default: '3000' });

  const hasExpress = !!(allDeps.express || allDeps.fastify || allDeps.koa || allDeps['@hono/node-server']);
  const hasFrontendBuild = hasVite || hasReact || hasVue || hasSvelte || isFullStack;
  const isPureServer = hasExpress && !hasFrontendBuild;

  // Issues
  const issues = [];
  const suggestions = [];

  if (hasExpress && !hasFrontendBuild) {
    issues.push({ level: 'info', icon: '🔌', title: 'Pure server app — require-in-main mode',
      detail: 'No frontend build step detected. The server will run inside the Electron main process via require() — no child process spawning needed. Your public/ and static/ asset folders will be included automatically.' });
  }
  if (dbType === 'postgresql') {
    issues.push({ level: 'env', icon: '🗄️', title: 'PostgreSQL required — provide DATABASE_URL below', detail: 'This app connects to an external PostgreSQL database. The DATABASE_URL you provide will be bundled in the packaged app\'s resources folder. Each end user will need a running database.' });
  }
  if (hasOpenAI || hasAnthropic) {
    issues.push({ level: 'env', icon: '🔑', title: 'API key required — provide it below', detail: 'This app uses an AI API. The key will be bundled in the packaged app. Be aware that anyone who unpacks the app can extract it.' });
  }
  if (hasTypeScript && !isElectronConfigured) {
    issues.push({ level: 'info', icon: '🔧', title: 'TypeScript will be compiled automatically', detail: 'The build pipeline will run your TypeScript compilation and Vite build steps before packaging. No manual action needed.' });
  }
  if (hasMigrations && hasDatabase) {
    suggestions.push({ icon: '📋', title: 'Database migrations detected', detail: 'Remember to run migrations before distributing — either manually against the target database, or add a first-launch migration runner to the Electron main process.' });
  }
  if (dbType === 'sqlite') {
    suggestions.push({ icon: '✅', title: 'SQLite detected — great for local apps', detail: 'SQLite works perfectly in packaged Electron apps with no external server needed. The database file will be stored on each user\'s machine.' });
  }

  // Stack badges
  const stack = [];
  if (hasTypeScript) stack.push({ label: 'TypeScript', color: 'blue' });
  if (hasVite) stack.push({ label: 'Vite', color: 'purple' });
  if (hasReact) stack.push({ label: 'React', color: 'cyan' });
  if (hasVue) stack.push({ label: 'Vue', color: 'green' });
  if (hasSvelte) stack.push({ label: 'Svelte', color: 'orange' });
  if (hasDrizzle) stack.push({ label: 'Drizzle ORM', color: 'amber' });
  if (hasPrisma) stack.push({ label: 'Prisma', color: 'indigo' });
  if (dbType === 'postgresql') stack.push({ label: 'PostgreSQL', color: 'blue' });
  if (dbType === 'mysql') stack.push({ label: 'MySQL', color: 'orange' });
  if (dbType === 'sqlite') stack.push({ label: 'SQLite', color: 'green' });
  if (isFullStack) stack.push({ label: 'Full-stack', color: 'amber' });
  if (hasOpenAI) stack.push({ label: 'OpenAI', color: 'emerald' });
  if (hasAnthropic) stack.push({ label: 'Claude API', color: 'purple' });
  if (hasDiscord) stack.push({ label: 'Discord', color: 'indigo' });

  // Pure server: Express/Fastify/etc with no frontend build step
  // These get require()-in-main treatment instead of child_process spawn

  // Detect static assets directories to include
  const hasPublicDir = fs.existsSync(path.join(appDir, 'public'));
  const hasStaticDir = fs.existsSync(path.join(appDir, 'static'));
  const hasViewsDir  = fs.existsSync(path.join(appDir, 'views'));

  return {
    appName: pkg.name || 'unknown',
    version: pkg.version || '0.0.0',
    description: pkg.description || '',
    appDir,
    pkg,
    isElectronConfigured,
    needsElectronSetup: !isElectronConfigured,
    hasTypeScript, hasVite, hasReact, hasVue, hasSvelte,
    isFullStack, hasServerDir, hasClientDir, hasMigrations,
    hasDatabase, dbType, hasDrizzle, hasPrisma,
    hasOpenAI, hasAnthropic, hasDiscord, hasStripe,
    hasExpress, isPureServer,
    hasPublicDir, hasStaticDir, hasViewsDir,
    requiredEnvVars, optionalEnvVars,
    hasRequiredEnvVars: requiredEnvVars.length > 0,
    issues, suggestions, stack,
    scripts,
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTO-SETUP: Write Electron main + patch package.json
// ═══════════════════════════════════════════════════════════════

async function autoSetupElectron(appDir, pkg, analysis, buildId) {
  log(buildId, 'info', '⚙️  Auto-configuring Electron...');
  const electronDir = path.join(appDir, 'electron');
  fs.mkdirSync(electronDir, { recursive: true });

  const PORT = (() => {
    // Try to detect port from source
    try {
      const src = fs.readFileSync(path.join(appDir, pkg.main || 'server.js'), 'utf8');
      const m = src.match(/(?:PORT\s*=\s*process\.env\.PORT\s*\|\|\s*|listen\(\s*)(\d{4,5})/);
      if (m) return parseInt(m[1]);
    } catch(_) {}
    return 3000;
  })();

  let mainJs;

  if (analysis.isPureServer) {
    // ── Pure server: require() in main process ────────────────────
    // Electron main IS Node.js — no need to spawn a separate process.
    // Just require the server module, wait for its port, open a window.
    log(buildId, 'info', `  Pure server detected (port ${PORT}) — using require-in-main pattern`);

    // Resolve the entry module path relative to app root
    const serverEntry = pkg.main || 'server.js';

    mainJs = `/**
 * Electron main — auto-generated by Electron Forge V4
 * App: ${analysis.appName} v${analysis.version}
 * Mode: pure-server (require in main process)
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Load .env before requiring the server
try {
  const dotenv = require('dotenv');
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(app.getAppPath(), '.env');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
} catch(e) {}

const PORT = parseInt(process.env.PORT || '${PORT}', 10);
let mainWindow = null;

function waitForServer(port, tries) {
  tries = tries === undefined ? 60 : tries;
  return new Promise(function(resolve, reject) {
    (function attempt(n) {
      http.get('http://localhost:' + port, function(r) { r.resume(); resolve(); })
        .on('error', function() {
          if (n <= 0) return reject(new Error('Server on :' + port + ' did not start in time.'));
          setTimeout(function() { attempt(n - 1); }, 500);
        });
    })(tries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true,
                      preload: path.join(__dirname, 'preload.js') },
    title: '${analysis.appName}',
    show: false,
  });
  mainWindow.loadURL('http://localhost:' + PORT);
  mainWindow.webContents.setWindowOpenHandler(function(d) {
    shell.openExternal(d.url); return { action: 'deny' };
  });
  // Prevent Electron from navigating to file:// URLs on drag-and-drop
  // (without this, dropping a file navigates the window away from localhost)
  mainWindow.webContents.on('will-navigate', function(event, url) {
    if (!url.startsWith('http://localhost:' + PORT)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', function(event, url) {
    if (!url.startsWith('http://localhost:' + PORT)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', function() {
    mainWindow.show();
    // Open DevTools if EF_DEVTOOLS env var is set — useful for debugging packaged apps
    if (process.env.EF_DEVTOOLS) mainWindow.webContents.openDevTools();
  });
  mainWindow.on('closed', function() { mainWindow = null; });
}

app.whenReady().then(function() {
${analysis.dbType === 'postgresql' ? `  if (!process.env.DATABASE_URL) {
    dialog.showMessageBox({ type:'error', title:'Config Required',
      message:'DATABASE_URL is not set.',
      detail:'Create a .env file with:\\n  DATABASE_URL=postgres://user:pass@host:5432/dbname',
      buttons:['Quit'] }).then(function() { app.quit(); });
    return;
  }
` : ''}  // Require the server in this same process — no child process needed
  try {
    require('../${serverEntry}');
  } catch(e) {
    dialog.showMessageBox({ type:'error', title:'Server Error',
      message:'Failed to start server: ' + e.message, buttons:['Quit'] })
      .then(function() { app.quit(); });
    return;
  }


  // IPC: native file open dialog (used by UI when running as packaged app)
  const { ipcMain, dialog } = require('electron');
  ipcMain.handle('dialog:openFile', async (event, filters) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [
        { name: 'Project Archives', extensions: ['zip','tar','tgz','gz','html','htm','ipynb'] }
      ],
    });
    return result;
  });
  waitForServer(PORT).then(function() {
    createWindow();
    app.on('activate', function() {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(function(err) {
    dialog.showMessageBox({ type:'error', title:'Server Timeout',
      message: err.message, buttons:['Quit'] })
      .then(function() { app.quit(); });
  });
});


// Prevent any webContents from navigating to file:// URLs (covers drag-drop at app level)
app.on('web-contents-created', function(event, contents) {
  contents.on('will-navigate', function(e, url) {
    if (url.startsWith('file://')) e.preventDefault();
  });
});
app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
});
`;
  } else {
    // ── Full-stack / frontend app: spawn compiled entry ───────────
    mainJs = `/**
 * Electron main — auto-generated by Electron Forge V4
 * App: ${analysis.appName} v${analysis.version}
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

try {
  const dotenv = require('dotenv');
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(app.getAppPath(), '.env');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
} catch(e) {}

const PORT = parseInt(process.env.PORT || '${PORT}', 10);
let serverProcess = null;
let mainWindow = null;

function waitForServer(port, retries, delay) {
  retries = retries === undefined ? 40 : retries;
  delay = delay === undefined ? 600 : delay;
  return new Promise(function(resolve, reject) {
    (function attempt(n) {
      http.get('http://localhost:' + port, resolve)
        .on('error', function() {
          if (n <= 0) return reject(new Error('Server on :' + port + ' did not start.'));
          setTimeout(function() { attempt(n - 1); }, delay);
        });
    })(retries);
  });
}

function resolveServerEntry() {
  var bases = [
    path.join(app.getAppPath(), 'dist', 'server', 'index.js'),
    path.join(app.getAppPath(), 'dist', 'index.js'),
    path.join(app.getAppPath(), 'index.js'),
    path.join(app.getAppPath(), 'server.js'),
    path.join(app.getAppPath(), 'app.js'),
  ];
  for (var i = 0; i < bases.length; i++) {
    if (fs.existsSync(bases[i])) return bases[i];
  }
  return bases[0];
}

function startServer() {
  var entry = resolveServerEntry();
  // Use process.execPath (Electron binary) — it can run .js as Node in this context
  serverProcess = spawn(process.execPath, ['--no-deprecation', entry], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (serverProcess.stdout) serverProcess.stdout.on('data', function(d) { process.stdout.write('[server] ' + d); });
  if (serverProcess.stderr) serverProcess.stderr.on('data', function(d) { process.stderr.write('[server] ' + d); });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true,
                      preload: path.join(__dirname, 'preload.js') },
    title: '${analysis.appName}',
    show: false,
  });
  mainWindow.loadURL('http://localhost:' + PORT);
  mainWindow.webContents.setWindowOpenHandler(function(d) { shell.openExternal(d.url); return { action: 'deny' }; });
  // Prevent Electron from navigating to file:// URLs on drag-and-drop
  // (without this, dropping a file navigates the window away from localhost)
  mainWindow.webContents.on('will-navigate', function(event, url) {
    if (!url.startsWith('http://localhost:' + PORT)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', function(event, url) {
    if (!url.startsWith('http://localhost:' + PORT)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', function() {
    mainWindow.show();
    if (process.env.EF_DEVTOOLS) mainWindow.webContents.openDevTools();
  });
  mainWindow.on('closed', function() { mainWindow = null; });
}

app.whenReady().then(function() {
${analysis.dbType === 'postgresql' ? `  if (!process.env.DATABASE_URL) {
    dialog.showMessageBox({ type:'error', title:'Configuration Required', message:'DATABASE_URL is not set.',
      detail:'Create a .env file with:\\n  DATABASE_URL=postgres://user:pass@host:5432/dbname',
      buttons:['Quit'] }).then(function() { app.quit(); });
    return;
  }
` : ''}  startServer();

  // IPC: native file open dialog (used by UI when running as packaged app)
  const { ipcMain, dialog } = require('electron');
  ipcMain.handle('dialog:openFile', async (event, filters) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [
        { name: 'Project Archives', extensions: ['zip','tar','tgz','gz','html','htm','ipynb'] }
      ],
    });
    return result;
  });
  waitForServer(PORT).then(function() {
    createWindow();
    app.on('activate', function() { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(function(err) {
    dialog.showMessageBox({ type:'error', title:'Server Failed to Start', message: err.message, buttons:['Quit'] })
      .then(function() { app.quit(); });
  });
});

// Prevent any webContents from navigating to file:// URLs (covers drag-drop at app level)
app.on('web-contents-created', function(event, contents) {
  contents.on('will-navigate', function(e, url) {
    if (url.startsWith('file://')) e.preventDefault();
  });
});
app.on('window-all-closed', function() { if (serverProcess) serverProcess.kill('SIGTERM'); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', function() { if (serverProcess) serverProcess.kill('SIGTERM'); });
`;
  }

  fs.writeFileSync(path.join(electronDir, 'main.js'), mainJs);
  log(buildId, 'success', `  Created electron/main.js (${analysis.isPureServer ? 'require-in-main' : 'spawn'} mode)`);

  // electron/preload.js
  fs.writeFileSync(path.join(electronDir, 'preload.js'),
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
});\n`
  );
  log(buildId, 'success', '  Created electron/preload.js');

  // ── Patch package.json ────────────────────────────────────────
  pkg.main = 'electron/main.js';
  pkg.type = 'commonjs';
  pkg.build = pkg.build || {};
  const safeName = (pkg.name || 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
  pkg.build.appId = 'com.' + (safeName || 'app') + '.app';
  pkg.build.productName = pkg.productName || pkg.name || 'App';
  pkg.build.asar = true;
  pkg.build.directories = { output: 'dist-electron' };

  // Build files: include everything needed, tailored to app type
  const includeFiles = ['electron/**/*', 'node_modules/**/*', 'package.json',
    '!node_modules/.cache/**/*', '!**/*.ts', '!**/*.map'];
  if (analysis.isPureServer) {
    // Pure server: include all JS + static asset dirs at root level
    const mainEntry = pkg.main_backup || pkg.scripts?.start?.replace('node ', '') || 'server.js';
    includeFiles.unshift('*.js', '*.json');
    if (analysis.hasPublicDir)  includeFiles.unshift('public/**/*');
    if (analysis.hasStaticDir)  includeFiles.unshift('static/**/*');
    if (analysis.hasViewsDir)   includeFiles.unshift('views/**/*');
  } else {
    // Full-stack: compiled output goes in dist/
    includeFiles.unshift('dist/**/*');
    if (analysis.hasPublicDir)  includeFiles.unshift('public/**/*');
    includeFiles.push('!client/**/*', '!server/**/*', '!shared/**/*');
  }
  pkg.build.files = includeFiles;

  if (analysis.hasDatabase || analysis.hasOpenAI || analysis.hasAnthropic) {
    pkg.build.extraResources = [{ from: '.env', to: '.env' }];
  }
  // Point electron-builder at our already-downloaded Electron binary.
  // This avoids a ~100MB re-download on every build.
  const serverElectronPath = path.join(__dirname, 'node_modules', 'electron');
  const serverElectronDist = path.join(serverElectronPath, 'dist');
  const serverElectronPkg  = path.join(serverElectronPath, 'package.json');
  // electron/dist may not exist until after first launch on some installs,
  // but electron/package.json always exists if electron is installed
  if (fs.existsSync(serverElectronPkg)) {
    try {
      const epkg = JSON.parse(fs.readFileSync(serverElectronPkg, 'utf8'));
      if (epkg.version) pkg.build.electronVersion = epkg.version;
      // Only set electronDist if the dist folder actually exists
      if (fs.existsSync(serverElectronDist)) {
        pkg.build.electronDist = serverElectronDist;
        log(buildId, 'info', '  Using cached Electron v' + epkg.version + ' from server node_modules (no download needed)');
      } else {
        log(buildId, 'info', '  Electron v' + epkg.version + ' version pinned (dist not yet cached)');
      }
    } catch(_) {}
  } else {
    // electron not installed in server node_modules — pin a known stable version
    // so electron-builder doesn't fail trying to auto-detect it
    pkg.build.electronVersion = '33.3.1';
    log(buildId, 'warn', '  electron not found in server node_modules — pinning v33.3.1');
  }
  pkg.build.win   = { target: [{ target: 'nsis', arch: ['x64'] }] };
  pkg.build.mac   = { target: [{ target: 'dmg',  arch: ['x64', 'arm64'] }] };
  pkg.build.linux = { target: ['AppImage', 'deb'] };
  // Ensure electron-builder is in devDependencies, not dependencies
  if (pkg.dependencies && pkg.dependencies['electron-builder']) {
    pkg.devDependencies = pkg.devDependencies || {};
    pkg.devDependencies['electron-builder'] = pkg.dependencies['electron-builder'];
    delete pkg.dependencies['electron-builder'];
  }
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['electron:start'] = 'electron .';

  // Stash original main so main.js can reference it
  if (analysis.isPureServer) pkg.main_backup = undefined; // cleanup

  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  log(buildId, 'success', '  Patched package.json with electron-builder config');
  log(buildId, 'success', '⚙️  Auto-configuration complete');
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ready',
    activeBuilds: activeBuilds.size,
    platform: PLATFORM,
    nativeTargets: NATIVE_TARGETS[PLATFORM] || { win: false, mac: false, linux: false },
    hasGuideKey: !!(process.env.ANTHROPIC_API_KEY),
  });
});

app.post('/api/upload', (req, res) => {
  upload.single('package')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 500 MB)' });
      return res.status(400).json({ error: err.message || 'Upload error' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const buildId = `build_${Date.now()}`;
    const file = req.file;
    console.log(`[upload] ${file.originalname} (${file.size} bytes)`);
    res.json({ buildId, filename: file.originalname, size: file.size, path: file.path, message: 'File uploaded successfully' });
  });
});

// ── Upload by local path (Electron native dialog) ────────────────
app.post('/api/upload-path', async (req, res) => {
  try {
    const { filePath, fileName } = req.body;
    if (!filePath || !fileName) return res.status(400).json({ error: 'filePath and fileName required' });
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found: ' + filePath });
    const ext = path.extname(fileName).toLowerCase();
    const allowed = ['.zip','.tar','.tgz','.gz','.html','.htm','.ipynb'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: 'Unsupported file type: ' + ext });
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 500 MB)' });
    const buildId = 'build_' + Date.now();
    const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(UPLOAD_DIR, sanitized);
    fs.copyFileSync(filePath, destPath);
    console.log('[upload-path] ' + fileName + ' (' + stat.size + ' bytes) -> ' + destPath);
    res.json({ buildId, filename: fileName, size: stat.size, path: destPath, message: 'File loaded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze uploaded project ─────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { filePath, filename, buildId: clientBuildId } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });

  const analyzeId = clientBuildId || `analyze_${Date.now()}`;
  function alog(level, msg) {
    broadcast({ type: 'analyzelog', analyzeId, level, message: msg });
    console.log(`[analyze][${level}] ${msg}`);
  }

  const ext = filename.toLowerCase();

  // Single-file HTML — no extraction needed
  if (ext.endsWith('.html') || ext.endsWith('.htm')) {
    const appName = path.basename(filename, path.extname(filename))
      .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-') || 'app';
    return res.json({ analysis: {
      appType: 'static-single', appName, fileCount: 1,
      stack: [{ label: 'Single-file HTML' }], issues: [], suggestions: [], canUseElectron: true,
    }});
  }

  // Jupyter notebook — no extraction needed
  if (ext.endsWith('.ipynb')) {
    const appName = path.basename(filename, '.ipynb')
      .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-') || 'notebook';
    return res.json({ analysis: {
      appType: 'notebook', appName, fileCount: 1,
      stack: [{ label: 'Jupyter Notebook' }], issues: [], suggestions: [], canUseElectron: true,
    }});
  }

  const analyzeDir = path.join(UPLOAD_DIR, `analyze_${Date.now()}`);
  fs.mkdirSync(analyzeDir, { recursive: true });

  // Respond immediately — real progress streams via WebSocket
  res.json({ status: 'analyzing', analyzeId });
  await flushEventLoop();

  try {
    // ── Step 1: Archive info ──────────────────────────────────────
    const fileStat = fs.statSync(filePath);
    alog('info', `📦 Archive: ${filename} (${formatBytes(fileStat.size)})`);
    await flushEventLoop();

    // Quick ZIP entry count (read tail for end-of-central-directory)
    let entryCount = 0;
    if (ext.endsWith('.zip')) {
      try {
        const fd = fs.openSync(filePath, 'r');
        const tailSize = Math.min(65536, fileStat.size);
        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, fileStat.size - tailSize);
        fs.closeSync(fd);
        // EOCD signature 0x06054b50 (LE) → 2-byte entry count at offset +10
        const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
        const eocdPos = tail.lastIndexOf(sig);
        if (eocdPos !== -1) entryCount = tail.readUInt16LE(eocdPos + 10);
        if (entryCount > 0) alog('info', `   ${entryCount.toLocaleString()} entries in archive`);
      } catch(_) {}
    }
    await flushEventLoop();

    // ── Step 2: Extract ───────────────────────────────────────────
    alog('info', '📂 Extracting archive...');
    await flushEventLoop();
    const t0 = Date.now();

    if (ext.endsWith('.zip')) {
      let lastPct = -1;
      await extractZip(filePath, {
        dir: analyzeDir,
        onEntry: entryCount > 20 ? (entry => {
          const pct = Math.floor((entry.entryCount / entryCount) * 100 / 10) * 10;
          if (pct > lastPct) {
            lastPct = pct;
            broadcast({ type: 'analyzelog', analyzeId, level: 'info',
              message: `   Extracting... ${pct}% (${entry.entryCount.toLocaleString()} / ${entryCount.toLocaleString()} files)` });
          }
        }) : undefined
      });
    } else {
      await extractTar(filePath, analyzeDir, analyzeId);
    }
    alog('success', `✅ Extracted in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    await flushEventLoop();

    // ── Step 3: Data file detection ───────────────────────────────
    alog('info', '🔍 Scanning for data/output files to exclude...');
    await flushEventLoop();
    const { excludedItems, totalFiles, skippedDataFiles } = await detectDataFiles(analyzeDir, alog);
    await flushEventLoop();

    const codeFiles = totalFiles - skippedDataFiles;
    if (skippedDataFiles > 0) {
      alog('warn', `   ${skippedDataFiles} data/output file${skippedDataFiles!==1?'s':''} will be excluded from build (${codeFiles} code files kept)`);
    } else {
      alog('info', `   ${totalFiles} files — no large data files detected`);
    }
    await flushEventLoop();

    // ── Step 4: Project type detection ───────────────────────────
    alog('info', '🔎 Detecting project type...');
    await flushEventLoop();
    const analysis = analyzeProject(analyzeDir);
    await flushEventLoop();

    if (!analysis) {
      broadcast({ type: 'analyzedone', analyzeId,
        error: 'Could not identify project type. No package.json, Python markers, R markers, or index.html found.' });
      return;
    }

    const stackStr = analysis.stack && analysis.stack.length > 0
      ? analysis.stack.map(s=>s.label).join(', ') : 'unknown';
    alog('success', `✅ Detected: ${analysis.appName} — ${stackStr}`);
    await flushEventLoop();

    if (analysis.requiredEnvVars && analysis.requiredEnvVars.length > 0)
      alog('warn', `⚠️  Env vars needed: ${analysis.requiredEnvVars.map(v=>v.name||v).join(', ')}`);

    if (analysis.issues && analysis.issues.length > 0)
      analysis.issues.forEach(i => {
        if (i.level === 'error' || i.level === 'warn')
          alog(i.level === 'error' ? 'error' : 'warn', `   ${i.title}`);
      });

    analysis.skippedDataFiles = skippedDataFiles;
    analysis.excludedItems = excludedItems;

    await flushEventLoop();
    alog('success', `🎯 Analysis complete`);
    broadcast({ type: 'analyzedone', analyzeId, analysis });

  } catch (err) {
    alog('error', `Analysis error: ${err.message}`);
    if (err.stack) alog('error', err.stack.split('\n').slice(1,3).join(' | '));
    broadcast({ type: 'analyzedone', analyzeId, error: err.message });
    try { fs.rmSync(analyzeDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── AI Guide (proxied to Anthropic API) ──────────────────────────
app.post('/api/guide', async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Set ANTHROPIC_API_KEY on the server to enable AI guidance.' });
  }

  const { messages, analysisContext } = req.body;
  const systemPrompt = `You are an Electron packaging expert embedded in "Electron Forge GUI," a drag-and-drop tool for building desktop executables from web apps.

Be concise and practical. Give direct answers. Mention specific file names, commands, and config keys.

${analysisContext ? `Current project:\n${JSON.stringify(analysisContext, null, 2)}` : ''}

Key facts:
- electron-builder produces .exe (Windows), .dmg (macOS), .AppImage/.deb (Linux)
- TypeScript/Vite projects must be compiled BEFORE electron-builder runs
- Full-stack apps (Express + Vite) spawn the server as a child process from the Electron main process
- External databases (PostgreSQL, MySQL) are NOT bundled — the .env goes in resources/ and users need their own DB
- SQLite is ideal for fully self-contained desktop apps with no external server
- Code signing is required for production macOS/Windows distribution but optional for personal use
- ASAR bundles everything but prevents direct file access — use extraResources for user-editable files`;

  const https = require('https');
  const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages });

  const apiReq = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => { data += chunk; });
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(400).json({ error: parsed.error.message });
        res.json({ response: parsed.content?.[0]?.text || '' });
      } catch (e) { res.status(500).json({ error: 'Failed to parse API response' }); }
    });
  });
  apiReq.on('error', (err) => res.status(500).json({ error: err.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── Start Node/JS build ──────────────────────────────────────────
app.post('/api/build', async (req, res) => {
  const { buildId, filePath, filename, targets, config, envVars } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runBuild(buildId, filePath, filename, workDir, targets, config, envVars || {});
});

// ── Start Python build ───────────────────────────────────────────
app.post('/api/build-python', async (req, res) => {
  const { buildId, filePath, filename, pythonConfig } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runPythonBuild(buildId, filePath, filename, workDir, pythonConfig || {});
});

// ── Start Static site build ──────────────────────────────────────
app.post('/api/build-static', async (req, res) => {
  const { buildId, filePath, filename, staticConfig } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runStaticBuild(buildId, filePath, filename, workDir, staticConfig || {});
});

// ── Start Single-file HTML build ─────────────────────────────────
app.post('/api/build-static-single', async (req, res) => {
  const { buildId, filePath, filename, staticConfig } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runSingleHtmlBuild(buildId, filePath, filename, workDir, staticConfig || {});
});

// ── Start Jupyter notebook build ─────────────────────────────────
app.post('/api/build-notebook', async (req, res) => {
  const { buildId, filePath, filename, staticConfig } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runNotebookBuild(buildId, filePath, filename, workDir, staticConfig || {});
});

// ── Start R/Shiny build ──────────────────────────────────────────
app.post('/api/build-r', async (req, res) => {
  const { buildId, filePath, filename, rConfig } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });
  res.json({ status: 'started', buildId });
  runRBuild(buildId, filePath, filename, workDir, rConfig || {});
});

// ═══════════════════════════════════════════════════════════════
// SHARED BUILD HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * After extraction, detect and remove data/output files from appDir.
 * Logs every exclusion. Returns the list of excluded items.
 */
async function applyDataExclusions(appDir, buildId) {
  log(buildId, 'info', '🔍 Scanning for data files to exclude...');
  const { excludedItems, skippedDataFiles } = await detectDataFiles(appDir, (level, msg) => log(buildId, level, msg));
  if (skippedDataFiles === 0) {
    log(buildId, 'info', '   No large data files found — packaging all files');
    return [];
  }
  log(buildId, 'info', `   Removing ${skippedDataFiles} data/output file(s) before packaging...`);
  for (const item of excludedItems) {
    try {
      if (item.type === 'dir') {
        fs.rmSync(item.path, { recursive: true, force: true });
        log(buildId, 'warn', `   ✂ Removed dir: ${item.name}/ (${item.count} files)`);
      } else {
        fs.unlinkSync(item.path);
        log(buildId, 'warn', `   ✂ Removed: ${item.name} (${formatBytes(item.size)})`);
      }
    } catch(e) {
      log(buildId, 'warn', `   Could not remove ${item.name}: ${e.message}`);
    }
  }
  return excludedItems;
}

// ═══════════════════════════════════════════════════════════════
// BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

async function runBuild(buildId, filePath, filename, workDir, targets, config, envVars) {
  activeBuilds.set(buildId, { status: 'extracting', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'extracting' });

  try {
    log(buildId, 'info', `Starting build: ${filename}`);

    const extractDir = path.join(workDir, 'source');
    fs.mkdirSync(extractDir, { recursive: true });

    const ext = filename.toLowerCase();
    if (ext.endsWith('.zip')) {
      log(buildId, 'info', 'Extracting ZIP...');
      await extractZip(filePath, { dir: extractDir });
    } else {
      log(buildId, 'info', 'Extracting TAR...');
      await extractTar(filePath, extractDir, buildId);
    }
    log(buildId, 'success', 'Archive extracted');

    // Remove data/output files before packaging
    await applyDataExclusions(extractDir, buildId);

    const pkgJsonPath = findPackageJson(extractDir);
    if (!pkgJsonPath) throw new Error('No package.json found in archive');

    const appDir = path.dirname(pkgJsonPath);
    let pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    log(buildId, 'info', `App: ${pkg.name || 'Unknown'} v${pkg.version || '0.0.0'}`);

    const analysis = analyzeProject(extractDir);
    if (analysis) {
      const stackLabels = analysis.stack.map(s => s.label).join(', ');
      log(buildId, 'info', `Stack: ${stackLabels || 'standard'}`);
      broadcast({ type: 'analysis', buildId, analysis });
    }

    // Inject env vars
    if (envVars && Object.keys(envVars).length > 0) {
      const populated = Object.entries(envVars).filter(([k, v]) => k && v);
      if (populated.length > 0) {
        const envContent = populated.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
        fs.writeFileSync(path.join(appDir, '.env'), envContent);
        log(buildId, 'success', `Wrote .env with ${populated.length} variable(s)`);
      }
    } else if (analysis && (analysis.hasDatabase || analysis.hasOpenAI)) {
      log(buildId, 'warn', 'No env vars provided — app will need manual .env configuration after install');
    }

    // Apply config overrides
    if (config && config.appName) {
      // productName can be human-readable; name must be a valid npm package name
      pkg.productName = config.appName;
      pkg.name = config.appName.toLowerCase()
        .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';
    }
    if (config && config.version) pkg.version = config.version;

    // Auto-setup if needed
    if (analysis && analysis.needsElectronSetup) {
      broadcast({ type: 'status', buildId, status: 'configuring' });
      await autoSetupElectron(appDir, pkg, analysis, buildId);
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    }

    if (!pkg.main) throw new Error('package.json missing "main" field. Electron needs an entry point.');

    // Install — skip entirely if server has electron-builder available,
    // since we pass electronDist + electronVersion in the build config.
    const isWin = process.platform === 'win32';
    const binExt = isWin ? '.cmd' : '';
    const serverBuilderBin = path.join(__dirname, 'node_modules', '.bin', 'electron-builder' + binExt);

    if (fs.existsSync(serverBuilderBin)) {
      log(buildId, 'info', 'Server electron-builder available — skipping npm install ✓');
    } else {
      broadcast({ type: 'status', buildId, status: 'installing' });
      log(buildId, 'info', 'Installing dependencies...');
      await runNpmInstall(appDir, buildId);
      log(buildId, 'success', 'Dependencies installed');
      const appElectronBin = path.join(appDir, 'node_modules', '.bin', 'electron' + binExt);
      if (!fs.existsSync(appElectronBin)) {
        log(buildId, 'warn', 'Installing electron + electron-builder...');
        await runCommand(isWin ? 'npm.cmd' : 'npm', ['install', '--save-dev', 'electron', 'electron-builder', '--no-fund', '--no-audit'], appDir, buildId);
      }
    }

    // Framework build
    await runFrameworkBuild(appDir, pkg, buildId);

    // Resolve electron-builder
    const localBuilderBin = path.join(appDir, 'node_modules', '.bin', `electron-builder${binExt}`);
    const ownBuilderBin = path.join(__dirname, 'node_modules', '.bin', `electron-builder${binExt}`);
    const electronBuilderBin = fs.existsSync(localBuilderBin) ? localBuilderBin : ownBuilderBin;
    if (!fs.existsSync(electronBuilderBin)) throw new Error('electron-builder not found after install.');
    log(buildId, 'info', `Using ${fs.existsSync(localBuilderBin) ? 'project-local' : 'bundled'} electron-builder`);

    // Build
    broadcast({ type: 'status', buildId, status: 'building' });
    log(buildId, 'info', 'Running electron-builder...');

    const nativeTargets = NATIVE_TARGETS[PLATFORM] || {};
    const validTargets = (targets || []).filter(t => nativeTargets[t]);
    const skipped = (targets || []).filter(t => !nativeTargets[t]);
    if (skipped.length > 0) log(buildId, 'warn', `Skipping incompatible targets on ${PLATFORM}: ${skipped.join(', ')}`);
    if (validTargets.length === 0) throw new Error(`No valid build targets for ${PLATFORM}. Selected: ${(targets || []).join(', ')}`);
    log(buildId, 'info', `Building for: ${validTargets.join(', ')}`);

    const builderArgs = buildElectronBuilderArgs(validTargets);

    // Verify electronVersion is in package.json — if not, inject via CLI arg.
    // We never install electron as a dependency; we just need the version string.
    try {
      const freshPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const ev = (freshPkg.build && freshPkg.build.electronVersion) || '33.3.1';
      builderArgs.push('-c.electronVersion=' + ev);
      log(buildId, 'info', '  electronVersion=' + ev);
    } catch(_) {
      builderArgs.push('-c.electronVersion=33.3.1');
    }

    await runCommand(electronBuilderBin, builderArgs, appDir, buildId);

    // Collect output
    const distDirs = ['dist-electron', 'dist', 'release', 'out'].map(d => path.join(appDir, d));
    const outputFiles = distDirs.flatMap(d => collectOutputFiles(d));
    if (outputFiles.length === 0) log(buildId, 'warn', 'No output files found. Check electron-builder config.');

    const finalOutputDir = path.join(workDir, 'output');
    fs.mkdirSync(finalOutputDir, { recursive: true });
    outputFiles.forEach(f => {
      const dest = path.join(finalOutputDir, path.basename(f));
      fs.copyFileSync(f, dest);
      log(buildId, 'success', `Output: ${path.basename(f)} (${formatBytes(fs.statSync(dest).size)})`);
    });

    const duration = ((Date.now() - activeBuilds.get(buildId).startTime) / 1000).toFixed(1);
    log(buildId, 'success', `✅ Build complete in ${duration}s — ${outputFiles.length} file(s)`);
    activeBuilds.set(buildId, { status: 'complete', outputDir: finalOutputDir });
    broadcast({
      type: 'status', buildId, status: 'complete',
      outputFiles: outputFiles.map(f => ({
        name: path.basename(f),
        size: fs.statSync(path.join(finalOutputDir, path.basename(f))).size,
        downloadUrl: `/api/download/${buildId}/${path.basename(f)}`
      }))
    });

  } catch (err) {
    log(buildId, 'error', `Build failed: ${err.message}`);
    if (err.stack) log(buildId, 'error', err.stack);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// STATIC SITE BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

// ── Smart copy: skips data/output dirs and large data files ────
const COPY_SKIP_DIRS = new Set(['node_modules','.git','__pycache__','.pyi_venv','venv','.venv',
  'data','output','outputs','exports','results','cache','datasets','raw','processed',
  'generated','tmp','temp','logs','figures','plots','.cache','.pytest_cache']);
const COPY_SKIP_EXTS = new Set(['.csv','.tsv','.parquet','.feather','.arrow','.hdf5',
  '.h5','.pkl','.pickle','.npy','.npz','.log','.cache']);
const COPY_LARGE_THRESHOLD = 25 * 1024 * 1024; // 25 MB — skip single large binary blobs

function smartCopyDir(src, dst, buildId, depth) {
  if (depth === undefined) depth = 0;
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0, skipped = 0;
  for (const entry of fs.readdirSync(src)) {
    if (entry.startsWith('.') && entry !== '.env') continue;
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        const nameLow = entry.toLowerCase();
        if (COPY_SKIP_DIRS.has(nameLow)) {
          if (buildId) log(buildId, 'info', `  Skipping ${entry}/ (excluded directory)`);
          skipped++;
          continue;
        }
        const { copied: c, skipped: s } = smartCopyDir(srcPath, dstPath, buildId, depth + 1);
        copied += c; skipped += s;
      } else {
        const xtn = path.extname(entry).toLowerCase();
        if (COPY_SKIP_EXTS.has(xtn)) {
          if (buildId && depth <= 2) log(buildId, 'info', `  Skipping ${entry} (data file)`);
          skipped++; continue;
        }
        if (stat.size > COPY_LARGE_THRESHOLD && (xtn === '.bin' || xtn === '.dat' || xtn === '')) {
          if (buildId) log(buildId, 'warn', `  Skipping ${entry} (${formatBytes(stat.size)} — large binary)`);
          skipped++; continue;
        }
        fs.copyFileSync(srcPath, dstPath);
        copied++;
      }
    } catch(e) {
      if (buildId) log(buildId, 'warn', `  Could not copy ${entry}: ${e.message}`);
    }
  }
  return { copied, skipped };
}

// ── Shared: write wrapper pkg, npm install, run electron-builder, finalize ──
async function buildElectronStaticWrapper(wrapperDir, siteDir, appName, windowWidth, windowHeight, workDir, buildId) {
  const isWin = process.platform === 'win32';
  const safeName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g,'-') || 'app';

  // Write electron/main.js
  const mainJs = `const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
let mainWindow = null;
app.whenReady().then(function() {
  mainWindow = new BrowserWindow({
    width: ${windowWidth}, height: ${windowHeight},
    title: ${JSON.stringify(appName)},
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'site', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(function(d) { shell.openExternal(d.url); return { action: 'deny' }; });
  mainWindow.on('closed', function() { mainWindow = null; });
});
app.on('window-all-closed', function() { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', function() { if (BrowserWindow.getAllWindows().length === 0) app.emit('ready'); });
`;
  require('fs').mkdirSync(require('path').join(wrapperDir, 'electron'), { recursive: true });
  require('fs').writeFileSync(path.join(wrapperDir, 'electron', 'main.js'), mainJs);

  const wrapperPkg = {
    name: safeName, version: '1.0.0', type: 'commonjs',
    main: 'electron/main.js',
    devDependencies: { electron: '^28.0.0', 'electron-builder': '^24.0.0' },
    build: {
      appId: `com.${safeName.replace(/-/g,'')}.app`,
      productName: appName, asar: true,
      directories: { output: 'dist' },
      files: ['electron/**/*', 'site/**/*', 'package.json'],
      win: { target: [{ target: 'nsis', arch: ['x64'] }] },
      mac: { target: [{ target: 'dmg' }] },
      linux: { target: ['AppImage'] },
    }
  };
  require('fs').writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify(wrapperPkg, null, 2));

  log(buildId, 'info', 'Installing Electron...');
  await runNpmInstall(wrapperDir, buildId);

  const builderBin = path.join(wrapperDir, 'node_modules', '.bin', `electron-builder${isWin ? '.cmd' : ''}`);
  if (!fs.existsSync(builderBin)) throw new Error('electron-builder not found after npm install.');

  const target = isWin ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
  log(buildId, 'info', `Packaging ${target}...`);
  broadcast({ type: 'status', buildId, status: 'building' });
  await runCommand(builderBin, [target, '--publish', 'never'], wrapperDir, buildId);
  log(buildId, 'success', 'Electron packaging complete ✓');

  await collectAndFinalize(buildId, workDir, path.join(wrapperDir, 'dist'));
}

async function collectAndFinalize(buildId, workDir, distDir) {
  const finalOutputDir = path.join(workDir, 'output');
  fs.mkdirSync(finalOutputDir, { recursive: true });

  const outputFiles = [];
  if (fs.existsSync(distDir)) {
    const exts = new Set(['.exe', '.dmg', '.AppImage', '.deb', '.rpm']);
    function scanDist(d) {
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        const stat = fs.statSync(fp);
        if (stat.isFile() && exts.has(path.extname(f).toLowerCase())) outputFiles.push(fp);
        else if (stat.isDirectory()) scanDist(fp);
      }
    }
    scanDist(distDir);
  }

  outputFiles.forEach(f => {
    const dest = path.join(finalOutputDir, path.basename(f));
    fs.copyFileSync(f, dest);
    log(buildId, 'success', `Output: ${path.basename(f)} (${formatBytes(fs.statSync(dest).size)})`);
  });

  if (outputFiles.length === 0) {
    log(buildId, 'warn', 'No output binary found — check build log for electron-builder errors.');
  }

  const duration = ((Date.now() - (activeBuilds.get(buildId).startTime || Date.now())) / 1000).toFixed(1);
  log(buildId, 'success', `✅ Build complete in ${duration}s`);
  activeBuilds.set(buildId, { status: 'complete', outputDir: finalOutputDir });

  const finalFiles = fs.readdirSync(finalOutputDir).map(f => ({
    name: f,
    size: (() => { try { return fs.statSync(path.join(finalOutputDir, f)).size; } catch(_) { return 0; } })(),
    downloadUrl: `/api/download/${buildId}/${f}`,
  }));
  broadcast({ type: 'status', buildId, status: 'complete', outputFiles: finalFiles });
}

async function runStaticBuild(buildId, filePath, filename, workDir, staticConfig) {
  activeBuilds.set(buildId, { status: 'extracting', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'extracting' });

  const {
    appName = 'app',
    windowWidth = 1280,
    windowHeight = 800,
    singleFile = false,  // if true, the zip is a single HTML file
  } = staticConfig;

  try {
    log(buildId, 'info', `Starting static build: ${filename}`);
    const extractDir = path.join(workDir, 'source');
    fs.mkdirSync(extractDir, { recursive: true });

    if (filename.toLowerCase().endsWith('.zip')) {
      log(buildId, 'info', 'Extracting ZIP...');
      await extractZip(filePath, { dir: extractDir });
    } else {
      log(buildId, 'info', 'Extracting TAR...');
      await extractTar(filePath, extractDir, buildId);
    }
    log(buildId, 'success', 'Archive extracted');

    // Resolve project root (may be nested: reponame-main/index.html)
    let appDir = extractDir;
    if (!fs.existsSync(path.join(extractDir, 'index.html'))) {
      try {
        for (const entry of fs.readdirSync(extractDir)) {
          const sub = path.join(extractDir, entry);
          try {
            if (fs.statSync(sub).isDirectory() &&
                fs.existsSync(path.join(sub, 'index.html'))) {
              appDir = sub;
              log(buildId, 'info', `Project root: ${entry}/`);
              break;
            }
          } catch(_) {}
        }
      } catch(_) {}
    }

    if (!fs.existsSync(path.join(appDir, 'index.html'))) {
      throw new Error('No index.html found in archive. Make sure the zip contains your static site files.');
    }

    log(buildId, 'info', `Packaging static site as Electron app: ${appName}`);

    // Create Electron wrapper project
    const wrapperDir = path.join(workDir, 'electron-wrapper');
    const siteDir = path.join(wrapperDir, 'site');
    fs.mkdirSync(path.join(wrapperDir, 'electron'), { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });

    // Copy site files into wrapper/site/ — skip data/output files
    log(buildId, 'info', 'Copying site files (excluding data/output directories)...');
    const { copied, skipped } = smartCopyDir(appDir, siteDir, buildId);
    log(buildId, skipped > 0 ? 'warn' : 'success',
      `Copied ${copied} files${skipped > 0 ? `, skipped ${skipped} data/output files` : ''}`);

    // Write Electron main.js — loads index.html directly from disk (no server)
    const mainJs = `const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;

app.whenReady().then(function() {
  mainWindow = new BrowserWindow({
    width: ${windowWidth},
    height: ${windowHeight},
    title: ${JSON.stringify(appName)},
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,  // allow local file:// asset loading
    }
  });
  // Load index.html directly from the bundled site directory
  mainWindow.loadFile(path.join(__dirname, '..', 'site', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(function(d) {
    shell.openExternal(d.url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', function() { mainWindow = null; });
});

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) app.emit('ready');
});
`;
    fs.writeFileSync(path.join(wrapperDir, 'electron', 'main.js'), mainJs);

    // Write package.json
    const safeName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const wrapperPkg = {
      name: safeName,
      version: '1.0.0',
      type: 'commonjs',
      main: 'electron/main.js',
      scripts: { start: 'electron .' },
      devDependencies: { electron: '^28.0.0', 'electron-builder': '^24.0.0' },
      build: {
        appId: `com.${safeName.replace(/-/g,'')}.app`,
        productName: appName,
        asar: true,
        directories: { output: 'dist' },
        files: ['electron/**/*', 'site/**/*', 'package.json'],
        win: { target: [{ target: 'nsis', arch: ['x64'] }] },
        mac: { target: [{ target: 'dmg' }] },
        linux: { target: ['AppImage'] },
      }
    };
    fs.writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify(wrapperPkg, null, 2));

    // npm install
    log(buildId, 'info', 'Installing Electron...');
    await runNpmInstall(wrapperDir, buildId);

    // electron-builder
    const isWin = process.platform === 'win32';
    const builderBin = path.join(wrapperDir, 'node_modules', '.bin', `electron-builder${isWin ? '.cmd' : ''}`);
    if (!fs.existsSync(builderBin)) throw new Error('electron-builder not found after npm install.');

    const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
    const target = PLATFORM === 'win' ? '--win' : PLATFORM === 'mac' ? '--mac' : '--linux';
    log(buildId, 'info', `Packaging ${target}...`);
    broadcast({ type: 'status', buildId, status: 'building' });
    await runCommand(builderBin, [target, '--publish', 'never'], wrapperDir, buildId);
    log(buildId, 'success', 'Electron packaging complete ✓');

    // Collect output
    const finalOutputDir = path.join(workDir, 'output');
    fs.mkdirSync(finalOutputDir, { recursive: true });
    const distDir = path.join(wrapperDir, 'dist');
    const outputFiles = [];
    if (fs.existsSync(distDir)) {
      function scanDist(d) {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          const stat = fs.statSync(fp);
          if (stat.isFile() && (f.endsWith('.exe') || f.endsWith('.dmg') || f.endsWith('.AppImage') || f.endsWith('.deb'))) {
            outputFiles.push(fp);
          } else if (stat.isDirectory() && !f.startsWith('win-') && !f.startsWith('mac-') && !f.startsWith('linux-')) {
            // skip intermediate build dirs
          }
        }
      }
      scanDist(distDir);
    }

    outputFiles.forEach(f => {
      const dest = path.join(finalOutputDir, path.basename(f));
      fs.copyFileSync(f, dest);
      log(buildId, 'success', `Output: ${path.basename(f)} (${formatBytes(fs.statSync(dest).size)})`);
    });

    if (outputFiles.length === 0) {
      log(buildId, 'warn', 'No output binary found. Check build log for electron-builder errors.');
    }

    const duration = ((Date.now() - activeBuilds.get(buildId).startTime) / 1000).toFixed(1);
    log(buildId, 'success', `✅ Static site build complete in ${duration}s`);
    activeBuilds.set(buildId, { status: 'complete', outputDir: finalOutputDir });

    const finalFiles = fs.readdirSync(finalOutputDir).map(f => ({
      name: f,
      size: (() => { try { return fs.statSync(path.join(finalOutputDir, f)).size; } catch(_) { return 0; } })(),
      downloadUrl: `/api/download/${buildId}/${f}`,
    }));
    broadcast({ type: 'status', buildId, status: 'complete', outputFiles: finalFiles });

  } catch(err) {
    log(buildId, 'error', `Static build failed: ${err.message}`);
    if (err.stack) log(buildId, 'error', err.stack);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLE-FILE HTML BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

async function runSingleHtmlBuild(buildId, filePath, filename, workDir, staticConfig) {
  activeBuilds.set(buildId, { status: 'building', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'building' });

  const appName = staticConfig.appName ||
    path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9]/g,'-') || 'app';
  const windowWidth = staticConfig.windowWidth || 1280;
  const windowHeight = staticConfig.windowHeight || 800;

  try {
    log(buildId, 'info', `Packaging single HTML file: ${filename}`);
    const wrapperDir = path.join(workDir, 'electron-wrapper');
    const siteDir = path.join(wrapperDir, 'site');
    fs.mkdirSync(path.join(wrapperDir, 'electron'), { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });

    // Copy the single HTML file as index.html
    fs.copyFileSync(filePath, path.join(siteDir, 'index.html'));
    log(buildId, 'success', `Copied ${filename} → site/index.html`);

    await buildElectronStaticWrapper(wrapperDir, siteDir, appName, windowWidth, windowHeight, workDir, buildId);
  } catch(err) {
    log(buildId, 'error', `Build failed: ${err.message}`);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// JUPYTER NOTEBOOK BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

async function runNotebookBuild(buildId, filePath, filename, workDir, staticConfig) {
  activeBuilds.set(buildId, { status: 'building', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'building' });

  const appName = staticConfig.appName ||
    path.basename(filename, '.ipynb').replace(/[^a-zA-Z0-9]/g,'-') || 'notebook';
  const windowWidth = staticConfig.windowWidth || 1280;
  const windowHeight = staticConfig.windowHeight || 900;

  try {
    log(buildId, 'info', `Processing Jupyter notebook: ${filename}`);

    // Try nbconvert first; fall back to rendering the notebook JSON as HTML
    const wrapperDir = path.join(workDir, 'electron-wrapper');
    const siteDir = path.join(wrapperDir, 'site');
    fs.mkdirSync(path.join(wrapperDir, 'electron'), { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });

    // Check if nbconvert is available
    let nbconvertAvailable = false;
    try {
      const result = require('child_process').execSync('jupyter nbconvert --version 2>&1', { timeout: 5000 }).toString();
      if (result.includes('.')) nbconvertAvailable = true;
    } catch(_) {}

    const outputHtml = path.join(siteDir, 'index.html');

    if (nbconvertAvailable) {
      log(buildId, 'info', 'Converting notebook with nbconvert...');
      require('child_process').execSync(
        `jupyter nbconvert --to html --output "${outputHtml}" "${filePath}"`,
        { timeout: 60000 }
      );
      log(buildId, 'success', 'Notebook converted to HTML via nbconvert');
    } else {
      log(buildId, 'warn', 'nbconvert not found — generating self-contained HTML viewer');
      // Read notebook JSON and build a simple styled viewer
      const nb = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const html = renderNotebookToHtml(nb, appName);
      fs.writeFileSync(outputHtml, html, 'utf8');
      log(buildId, 'success', 'Generated HTML notebook viewer');
    }

    await buildElectronStaticWrapper(wrapperDir, siteDir, appName, windowWidth, windowHeight, workDir, buildId);
  } catch(err) {
    log(buildId, 'error', `Notebook build failed: ${err.message}`);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

function renderNotebookToHtml(nb, title) {
  const cells = nb.cells || [];
  const cellsHtml = cells.map(cell => {
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    const escaped = src.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (cell.cell_type === 'markdown') {
      return `<div class="cell markdown"><div class="src">${escaped}</div></div>`;
    } else if (cell.cell_type === 'code') {
      const outputs = (cell.outputs || []).map(o => {
        if (o.output_type === 'stream') {
          const text = Array.isArray(o.text) ? o.text.join('') : (o.text || '');
          return `<pre class="output">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
        }
        if (o.output_type === 'display_data' || o.output_type === 'execute_result') {
          if (o.data && o.data['text/html']) {
            const html = Array.isArray(o.data['text/html']) ? o.data['text/html'].join('') : o.data['text/html'];
            return `<div class="output">${html}</div>`;
          }
          if (o.data && o.data['image/png']) {
            return `<div class="output"><img src="data:image/png;base64,${o.data['image/png']}" style="max-width:100%"></div>`;
          }
          if (o.data && o.data['text/plain']) {
            const text = Array.isArray(o.data['text/plain']) ? o.data['text/plain'].join('') : o.data['text/plain'];
            return `<pre class="output">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
          }
        }
        return '';
      }).join('');
      return `<div class="cell code"><pre class="src"><code>${escaped}</code></pre>${outputs}</div>`;
    }
    return '';
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px 40px; background: #fff; color: #222; }
  h1 { font-size: 1.4em; margin-bottom: 24px; border-bottom: 1px solid #ddd; padding-bottom: 12px; }
  .cell { margin-bottom: 20px; }
  .cell.code .src { background: #f7f7f7; border-left: 3px solid #ccc; padding: 12px 16px; font-family: 'Consolas', monospace; font-size: 13px; overflow-x: auto; white-space: pre; }
  .cell.markdown .src { white-space: pre-wrap; font-size: 14px; line-height: 1.6; }
  .output { background: #fff; border-left: 3px solid #dae8fc; padding: 8px 16px; font-size: 13px; overflow-x: auto; }
  pre.output { font-family: monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>${title}</h1>
${cellsHtml}
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// R/SHINY BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

async function runRBuild(buildId, filePath, filename, workDir, rConfig) {
  activeBuilds.set(buildId, { status: 'extracting', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'extracting' });

  const {
    appName = 'shiny-app',
    detectedPort = '3838',
    rPath = '',  // optional: explicit R executable path
  } = rConfig;

  try {
    log(buildId, 'info', `Starting R/Shiny build: ${filename}`);

    // Extract
    const extractDir = path.join(workDir, 'source');
    fs.mkdirSync(extractDir, { recursive: true });
    if (filename.toLowerCase().endsWith('.zip')) {
      await extractZip(filePath, { dir: extractDir });
    } else {
      await extractTar(filePath, extractDir, buildId);
    }
    log(buildId, 'success', 'Archive extracted');

    // Remove data/output files before packaging
    await applyDataExclusions(extractDir, buildId);

    // Resolve project root
    let appDir = extractDir;
    const rMarkers = ['app.R', 'server.R', 'ui.R'];
    if (!rMarkers.some(m => fs.existsSync(path.join(extractDir, m)))) {
      for (const entry of fs.readdirSync(extractDir)) {
        const sub = path.join(extractDir, entry);
        try {
          if (fs.statSync(sub).isDirectory() && rMarkers.some(m => fs.existsSync(path.join(sub, m)))) {
            appDir = sub;
            log(buildId, 'info', `Project root: ${entry}/`);
            break;
          }
        } catch(_) {}
      }
    }

    // Detect R executable
    const isWin = process.platform === 'win32';
    let rExe = rPath || '';
    if (!rExe) {
      const candidates = isWin
        ? ['Rscript', 'C:\\Program Files\\R\\R-4.3.3\\bin\\Rscript.exe',
           'C:\\Program Files\\R\\R-4.4.0\\bin\\Rscript.exe',
           'C:\\Program Files\\R\\R-4.2.3\\bin\\Rscript.exe']
        : ['Rscript', '/usr/bin/Rscript', '/usr/local/bin/Rscript'];
      for (const r of candidates) {
        try {
          require('child_process').execSync(`"${r}" --version 2>&1`, { timeout: 5000 });
          rExe = r;
          break;
        } catch(_) {}
      }
    }
    if (!rExe) throw new Error('R not found on this system. Install R from r-project.org and ensure Rscript is on your PATH.');
    log(buildId, 'success', `Found R: ${rExe}`);

    // Install shiny + renv if needed
    broadcast({ type: 'status', buildId, status: 'installing' });
    const hasRenv = fs.existsSync(path.join(appDir, 'renv.lock'));
    if (hasRenv) {
      log(buildId, 'info', 'Restoring renv packages...');
      await runCommand(rExe, ['-e', 'renv::restore(prompt=FALSE)'], appDir, buildId);
      log(buildId, 'success', 'renv packages restored');
    } else {
      log(buildId, 'info', 'Installing shiny package...');
      await runCommand(rExe, ['-e', "if(!require('shiny',quietly=TRUE)) install.packages('shiny', repos='https://cran.rstudio.com/')"], appDir, buildId);
      log(buildId, 'success', 'shiny installed');
    }

    // Create Electron wrapper that launches R as child process
    broadcast({ type: 'status', buildId, status: 'building' });
    const wrapperDir = path.join(workDir, 'electron-wrapper');
    const appCopyDir = path.join(wrapperDir, 'shiny-app');
    fs.mkdirSync(path.join(wrapperDir, 'electron'), { recursive: true });
    fs.mkdirSync(appCopyDir, { recursive: true });

    // Copy R app files into wrapper — skip data/output dirs
    const { copied: rCopied, skipped: rSkipped } = smartCopyDir(appDir, appCopyDir, buildId);
    log(buildId, 'success', `R app files copied (${rCopied} files${rSkipped > 0 ? `, ${rSkipped} excluded` : ''})`);

    // Write Electron main.js — spawns Rscript, waits for server, opens window
    const rExeForJs = rExe.replace(/\\/g, '\\\\');
    const mainJs = `const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = ${detectedPort};
const RSCRIPT = ${JSON.stringify(rExe)};
let mainWindow = null, rProcess = null;

function waitForServer(port, cb, tries=0) {
  http.get('http://localhost:' + port, r => { r.resume(); cb(); })
    .on('error', () => {
      if (tries > 60) cb(new Error('R/Shiny server did not start after 30s'));
      else setTimeout(() => waitForServer(port, cb, tries+1), 500);
    });
}

app.whenReady().then(function() {
  const appDir = path.join(process.resourcesPath, 'shiny-app');
  const runScript = 'shiny::runApp("' + appDir.replace(/\\\\/g, '/') + '", port=' + PORT + ', launch.browser=FALSE)';

  rProcess = spawn(RSCRIPT, ['--vanilla', '-e', runScript], { stdio: ['ignore','pipe','pipe'] });
  rProcess.stdout.on('data', d => process.stdout.write('[R] ' + d));
  rProcess.stderr.on('data', d => process.stderr.write('[R] ' + d));
  rProcess.on('exit', code => { if (code && mainWindow) dialog.showMessageBox({ type:'error', message:'R process exited (code '+code+')' }); });

  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    title: ${JSON.stringify(appName)},
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  });

  waitForServer(PORT, function(err) {
    if (err) {
      dialog.showMessageBox({ type:'error', title:'R failed to start', message: err.message, buttons:['Quit'] }).then(() => app.quit());
      return;
    }
    mainWindow.loadURL('http://localhost:' + PORT);
    mainWindow.show();
  });

  mainWindow.on('closed', function() { mainWindow = null; });
});

app.on('window-all-closed', function() {
  if (rProcess) rProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', function() { if (rProcess) rProcess.kill(); });
`;
    fs.writeFileSync(path.join(wrapperDir, 'electron', 'main.js'), mainJs);

    const safeName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const wrapperPkg = {
      name: safeName, version: '1.0.0', type: 'commonjs',
      main: 'electron/main.js',
      devDependencies: { electron: '^28.0.0', 'electron-builder': '^24.0.0' },
      build: {
        appId: `com.${safeName.replace(/-/g,'')}.app`,
        productName: appName, asar: true,
        directories: { output: 'dist' },
        files: ['electron/**/*', 'package.json'],
        extraResources: [{ from: 'shiny-app', to: 'shiny-app' }],
        win: { target: [{ target: 'nsis', arch: ['x64'] }] },
        mac: { target: [{ target: 'dmg' }] },
        linux: { target: ['AppImage'] },
      }
    };
    fs.writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify(wrapperPkg, null, 2));

    log(buildId, 'info', 'Installing Electron...');
    await runNpmInstall(wrapperDir, buildId);

    const builderBin = path.join(wrapperDir, 'node_modules', '.bin', `electron-builder${isWin ? '.cmd' : ''}`);
    if (!fs.existsSync(builderBin)) throw new Error('electron-builder not found.');
    const target = isWin ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
    log(buildId, 'info', `Packaging ${target}...`);
    await runCommand(builderBin, [target, '--publish', 'never'], wrapperDir, buildId);
    log(buildId, 'success', 'R/Shiny app packaged ✓');

    await collectAndFinalize(buildId, workDir, path.join(wrapperDir, 'dist'));
  } catch(err) {
    log(buildId, 'error', `R build failed: ${err.message}`);
    if (err.stack) log(buildId, 'error', err.stack);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// PYTHON BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════

async function runPythonBuild(buildId, filePath, filename, workDir, pythonConfig) {
  activeBuilds.set(buildId, { status: 'extracting', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'extracting' });

  const {
    entryPoint,          // e.g. 'app.py'
    appName = 'app',
    mode = 'pyinstaller',  // 'pyinstaller' | 'electron-python'
    hiddenImports = '',
    addDataPaths = '',
    onefile = true,
    noconsole = false,
    detectedPort = '5000',
    isWebApp = false,
    envVars = {},
  } = pythonConfig;

  try {
    // ── Extract ──────────────────────────────────────────────────
    log(buildId, 'info', `Starting Python build: ${filename}`);
    const extractDir = path.join(workDir, 'source');
    fs.mkdirSync(extractDir, { recursive: true });

    if (filename.toLowerCase().endsWith('.zip')) {
      log(buildId, 'info', 'Extracting ZIP...');
      await extractZip(filePath, { dir: extractDir });
    } else {
      log(buildId, 'info', 'Extracting TAR...');
      await extractTar(filePath, extractDir, buildId);
    }
    log(buildId, 'success', 'Archive extracted');

    // Remove data/output files before PyInstaller packaging
    await applyDataExclusions(extractDir, buildId);

    // Resolve the actual project directory (may be nested inside reponame-main/)
    let appDir = extractDir;
    if (!fs.existsSync(path.join(extractDir, entryPoint || 'requirements.txt'))) {
      const entries = fs.readdirSync(extractDir).filter(e => {
        try { return fs.statSync(path.join(extractDir, e)).isDirectory(); } catch(_) { return false; }
      });
      if (entries.length === 1) {
        appDir = path.join(extractDir, entries[0]);
        log(buildId, 'info', `Project root: ${entries[0]}/`);
      }
    }

    if (!entryPoint) throw new Error('No entry point specified. Please provide the main Python file (e.g. app.py).');
    const entryPath = path.join(appDir, entryPoint);
    if (!fs.existsSync(entryPath)) throw new Error(`Entry point not found: ${entryPoint}. Verify the filename matches a .py file in the project root.`);

    // ── Write .env if provided ───────────────────────────────────
    if (envVars && Object.keys(envVars).filter(k => envVars[k]).length > 0) {
      const envContent = Object.entries(envVars).filter(([k,v]) => k && v).map(([k,v]) => `${k}=${v}`).join('\n') + '\n';
      fs.writeFileSync(path.join(appDir, '.env'), envContent);
      log(buildId, 'success', `Wrote .env with ${Object.keys(envVars).filter(k=>envVars[k]).length} variable(s)`);
    }

    // ── Detect Python / pip ──────────────────────────────────────
    broadcast({ type: 'status', buildId, status: 'installing' });
    const isWin = process.platform === 'win32';
    const python  = await findPython(buildId);
    log(buildId, 'info', `Python: ${python}`);

    // ── Create virtualenv and install dependencies ────────────────
    // Using a venv is the only reliable way to make PyInstaller find all
    // submodules on Windows Store Python, where packages live in a sandboxed
    // user location that PyInstaller's analysis can't fully traverse.
    const venvDir = path.join(appDir, '.pyi_venv');
    log(buildId, 'info', 'Creating build virtualenv (.pyi_venv)...');
    const venvT0 = Date.now();
    await runCommand(python, ['-m', 'venv', venvDir], appDir, buildId);
    log(buildId, 'success', `Virtualenv ready (${((Date.now()-venvT0)/1000).toFixed(1)}s)`);

    const venvPython = isWin
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');

    // Upgrade pip silently first so later installs don't warn about it
    try {
      await runCommand(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'], appDir, buildId);
      log(buildId, 'info', 'pip upgraded');
    } catch(_) {}


    // ── Install dependencies ──────────────────────────────────────
    const reqFile = path.join(appDir, 'requirements.txt');
    const pyprojectFile = path.join(appDir, 'pyproject.toml');
    const pipfilePath = path.join(appDir, 'Pipfile');

    let depsInstalled = false;

    // Log what files we actually see (helps diagnose future issues)
    const depFiles = ['requirements.txt','pyproject.toml','Pipfile','setup.py','poetry.lock']
      .filter(f => fs.existsSync(path.join(appDir, f)));
    log(buildId, 'info', depFiles.length
      ? `Dependency files found: ${depFiles.join(', ')}`
      : 'No standard dependency files found — will install from detected stack');

    if (fs.existsSync(pyprojectFile)) {
      const pyprojectContent = fs.readFileSync(pyprojectFile, 'utf8');
      const hasPoetry  = pyprojectContent.includes('[tool.poetry]');
      const hasPep517  = pyprojectContent.includes('[build-system]');
      const hasPep621  = pyprojectContent.includes('[project]');

      if (hasPoetry || hasPep517) {
        // Standard installable package — pip install . handles everything
        log(buildId, 'info', `Installing via pip install . (${hasPoetry ? 'Poetry' : 'PEP 517'})...`);
        try {
          await runCommand(venvPython, ['-m', 'pip', 'install', '.', '--no-color'], appDir, buildId);
          log(buildId, 'success', 'Dependencies installed (pyproject.toml)');
          depsInstalled = true;
        } catch(e) {
          log(buildId, 'warn', `pyproject.toml pip install . failed: ${e.message} — will try parsing deps directly`);
        }
      }

      if (!depsInstalled && hasPep621) {
        // PEP 621 format: dependencies = ["flask>=3.1", "flask-login>=0.6", ...]
        // Used by uv, Replit, and modern projects without a build backend
        const arrayMatch = pyprojectContent.match(/\[project\][\s\S]*?\bdependencies\s*=\s*\[([\s\S]*?)\]/);
        if (arrayMatch) {
          const pkgs = [...arrayMatch[1].matchAll(/"([^"]+)"|'([^']+)'/g)]
            .map(m => (m[1] || m[2]).trim())
            // Strip version specifiers: "flask>=3.1.0" → "flask"
            .map(p => p.split(/[>=<!;[\s]/)[0].trim())
            .filter(p => p && p !== 'python');
          if (pkgs.length) {
            log(buildId, 'info', `PEP 621 pyproject.toml — installing ${pkgs.length} packages: ${pkgs.slice(0,8).join(', ')}${pkgs.length > 8 ? '…' : ''}`);
            let installed = 0, skipped = 0;
            for (const pkg of pkgs) {
              try {
                await runCommand(venvPython, ['-m', 'pip', 'install', pkg, '--quiet'], appDir, buildId);
                installed++;
              } catch(_) { skipped++; }
            }
            log(buildId, 'success', `pyproject.toml: ${installed} packages installed, ${skipped} skipped`);
            if (installed > 0) depsInstalled = true;
          }
        } else {
          log(buildId, 'warn', 'PEP 621 [project] found but no dependencies array — trying fallback');
        }
      }

      if (!depsInstalled) {
        // Last-resort: [tool.poetry.dependencies] or [dependencies] TOML table style
        const tableSectionMatch = pyprojectContent.match(
          /\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?=\n\[|$)/
        );
        const section = tableSectionMatch ? tableSectionMatch[1] : '';
        const SKIP = new Set(['python','name','version','description','authors','readme','license',
                              'homepage','repository','documentation','keywords','classifiers']);
        const pkgs = [...section.matchAll(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=/gm)]
          .map(m => m[1].toLowerCase().replace(/_/g, '-'))
          .filter(p => !SKIP.has(p));
        if (pkgs.length) {
          log(buildId, 'info', `Installing ${pkgs.length} packages from [dependencies] table: ${pkgs.join(', ')}`);
          let installed = 0;
          for (const pkg of pkgs) {
            try { await runCommand(venvPython, ['-m', 'pip', 'install', pkg, '--quiet'], appDir, buildId); installed++; } catch(_) {}
          }
          if (installed > 0) { log(buildId, 'success', `${installed} packages installed`); depsInstalled = true; }
        } else {
          log(buildId, 'warn', 'pyproject.toml found but no parseable dependencies — falling through to source scan');
        }
      }
    }

    if (!depsInstalled && fs.existsSync(reqFile)) {
      log(buildId, 'info', 'Installing requirements.txt into virtualenv...');
      log(buildId, 'info', 'Installing from requirements.txt...');
      const pipT0 = Date.now();
      await runCommand(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt', '--no-color'], appDir, buildId);
      log(buildId, 'success', `requirements.txt installed (${((Date.now()-pipT0)/1000).toFixed(1)}s)`);
      log(buildId, 'success', 'Requirements installed');
      depsInstalled = true;
    }

    if (!depsInstalled && fs.existsSync(pipfilePath)) {
      log(buildId, 'info', 'Pipfile found — installing via pip...');
      // Extract package names from Pipfile [packages] section
      const pipfileContent = fs.readFileSync(pipfilePath, 'utf8');
      const pkgSection = pipfileContent.match(/\[packages\]([\s\S]*?)(?=\[|$)/);
      if (pkgSection) {
        const pkgs = [...pkgSection[1].matchAll(/^(\w[\w-]*)\s*=/gm)].map(m => m[1]);
        if (pkgs.length) {
          await runCommand(venvPython, ['-m', 'pip', 'install', ...pkgs, '--no-color'], appDir, buildId);
          log(buildId, 'success', 'Pipfile dependencies installed');
          depsInstalled = true;
        }
      }
    }

    // ── Source import scan — runs ALWAYS after dep file install ─────
    // Catches packages imported in source but missing from dep files
    // (common in Replit projects, and covers flask_login, flask_sqlalchemy, etc.)
    {
      // Map from import name → pip package name (where they differ)
      const IMPORT_TO_PIP = {
        'flask_login':        'flask-login',
        'flask_sqlalchemy':   'flask-sqlalchemy',
        'flask_wtf':          'flask-wtf',
        'flask_migrate':      'flask-migrate',
        'flask_mail':         'flask-mail',
        'flask_cors':         'flask-cors',
        'flask_jwt_extended': 'flask-jwt-extended',
        'flask_restful':      'flask-restful',
        'flask_bcrypt':       'flask-bcrypt',
        'flask_limiter':      'flask-limiter',
        'flask_caching':      'flask-caching',
        'flask_socketio':     'flask-socketio',
        'dotenv':             'python-dotenv',
        'PIL':                'Pillow',
        'cv2':                'opencv-python',
        'sklearn':            'scikit-learn',
        'bs4':                'beautifulsoup4',
        'yaml':               'pyyaml',
        'dateutil':           'python-dateutil',
        'jose':               'python-jose',
        'passlib':            'passlib',
        'aiofiles':           'aiofiles',
        'pydantic':           'pydantic',
        'sqlalchemy':         'sqlalchemy',
        'alembic':            'alembic',
        'celery':             'celery',
        'redis':              'redis',
        'pymongo':            'pymongo',
        'motor':              'motor',
        'httpx':              'httpx',
        'requests':           'requests',
        'boto3':              'boto3',
        'stripe':             'stripe',
        'twilio':             'twilio',
        'sendgrid':           'sendgrid',
      };

      // Stdlib modules — never try to pip install these
      const STDLIB = new Set([
        'os','sys','re','json','math','time','datetime','pathlib','typing','collections',
        'itertools','functools','operator','io','abc','copy','random','string','struct',
        'hashlib','hmac','base64','urllib','http','email','html','xml','csv','sqlite3',
        'threading','multiprocessing','subprocess','socket','logging','warnings','traceback',
        'inspect','importlib','pkgutil','zipfile','tarfile','gzip','shutil','tempfile',
        'glob','fnmatch','stat','enum','dataclasses','contextlib','weakref','gc','signal',
        'platform','ctypes','array','queue','heapq','bisect','textwrap','unicodedata',
        'codecs','locale','gettext','argparse','configparser','ast','dis','token','tokenize',
        'runpy','unittest','doctest','pdb','profile','timeit','uuid','secrets','decimal',
        'fractions','statistics','cmath','calendar','zlib','lzma','bz2','mimetypes',
        'concurrent','asyncio','selectors','ssl','ftplib','poplib','imaplib','smtplib',
        'xmlrpc','wsgiref','builtins','__future__','_thread','sysconfig','site',
      ]);

      // Scan all .py files in appDir (top level + one level deep)
      const pyFiles = [];
      try {
        for (const f of fs.readdirSync(appDir)) {
          const fp = path.join(appDir, f);
          if (f.endsWith('.py')) pyFiles.push(fp);
          else if (fs.statSync(fp).isDirectory() && !f.startsWith('.') && f !== '__pycache__') {
            try {
              for (const sub of fs.readdirSync(fp)) {
                if (sub.endsWith('.py')) pyFiles.push(path.join(fp, sub));
              }
            } catch(_) {}
          }
        }
      } catch(_) {}

      const importedModules = new Set();
      for (const pyFile of pyFiles) {
        try {
          const src = fs.readFileSync(pyFile, 'utf8');
          // Match: import foo, from foo import bar, from foo.bar import baz
          for (const m of src.matchAll(/^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm)) {
            importedModules.add(m[1].toLowerCase());
          }
        } catch(_) {}
      }

      // Figure out which ones need installing
      const toInstall = [];
      for (const mod of importedModules) {
        if (STDLIB.has(mod)) continue;
        // Map to pip name if needed
        const pipName = IMPORT_TO_PIP[mod] || IMPORT_TO_PIP[mod.replace(/_/g, '-')] || mod.replace(/_/g, '-');
        toInstall.push(pipName);
      }

      if (toInstall.length) {
        log(buildId, 'info', `Source scan: installing ${toInstall.length} imported packages one-by-one (skipping local/unknown): ${toInstall.slice(0,8).join(', ')}${toInstall.length > 8 ? '…' : ''}`);
        let installed = 0, skipped = 0;
        for (const pkg of toInstall) {
          try {
            await runCommand(venvPython, ['-m', 'pip', 'install', pkg, '--quiet'], appDir, buildId);
            installed++;
            depsInstalled = true;
          } catch(_) {
            skipped++;  // local module or typo — silently skip
          }
        }
        log(buildId, 'success', `Source-scan packages: ${installed} installed, ${skipped} skipped (local/unknown)`);
      }
    }

    // ── Hard fallback if literally nothing installed ──────────────
    if (!depsInstalled) {
      log(buildId, 'warn', 'No packages installed from any source — installing detected framework packages');
      const fallbackPkgs = [];
      if (pythonConfig.hasFlask)    fallbackPkgs.push('flask');
      if (pythonConfig.hasFastAPI)  fallbackPkgs.push('fastapi', 'uvicorn');
      if (pythonConfig.hasDjango)   fallbackPkgs.push('django');
      if (pythonConfig.hasOpenAI)   fallbackPkgs.push('openai');
      if (pythonConfig.hasAnthropic)fallbackPkgs.push('anthropic');
      if (pythonConfig.hasPandas)   fallbackPkgs.push('pandas');
      if (pythonConfig.hasNumpy)    fallbackPkgs.push('numpy');
      if (fallbackPkgs.length) {
        await runCommand(venvPython, ['-m', 'pip', 'install', ...fallbackPkgs, '--no-color'], appDir, buildId);
        log(buildId, 'success', 'Framework packages installed');
      }
    }

    // ── Inject Replit env vars into .env if app uses $PORT etc ────
    // Replit sets PORT=8080 at runtime; the packaged exe must replicate this
    if (pythonConfig.isReplit && pythonConfig.usesEnvPort) {
      const envPath = path.join(appDir, '.env');
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (!existing.includes('PORT=')) {
        fs.appendFileSync(envPath, `\nPORT=${detectedPort}\n`);
        log(buildId, 'info', `  Injected PORT=${detectedPort} into .env for Replit compatibility`);
      }
    }

    log(buildId, 'info', 'Installing PyInstaller into virtualenv...');
    log(buildId, 'info', 'Installing PyInstaller...');
    const pyiT0 = Date.now();
    await runCommand(venvPython, ['-m', 'pip', 'install', 'pyinstaller', '--no-color'], appDir, buildId);
    log(buildId, 'success', `PyInstaller installed (${((Date.now()-pyiT0)/1000).toFixed(1)}s)`);
    log(buildId, 'success', 'PyInstaller ready');

    // ── Build ────────────────────────────────────────────────────
    broadcast({ type: 'status', buildId, status: 'building' });

    if (mode === 'electron-python') {
      log(buildId, 'info', 'Mode: Electron wrapper — building headless Python server binary...');
      const entryMod = entryPoint.replace(/\.py$/i, '').replace(/[/\\]/g, '.');
      await buildPyInstallerBinary(appDir, entryPoint, appName, {
        onefile: true, noconsole: true,
        hiddenImports, addDataPaths, python: venvPython, buildId,
        entryModuleName: entryMod, analysis: pythonConfig,
        extraArgs: ['--name', `${appName}-server`],
      });
      log(buildId, 'info', 'Building Electron wrapper...');
      await buildElectronPythonWrapper(appDir, appName, detectedPort, workDir, buildId);
    } else {
      log(buildId, 'info', 'Mode: PyInstaller standalone');
      const entryMod = entryPoint.replace(/\.py$/i, '').replace(/[/\\]/g, '.');
      if (isWebApp) {
        await injectWebLauncher(appDir, entryPoint, appName, detectedPort, venvPython, buildId);
        await buildPyInstallerBinary(appDir, `_launcher_${appName}.py`, appName, {
          onefile, noconsole: true, hiddenImports, addDataPaths, python: venvPython, buildId,
          entryModuleName: entryMod, analysis: pythonConfig,
        });
      } else {
        await buildPyInstallerBinary(appDir, entryPoint, appName, {
          onefile, noconsole, hiddenImports, addDataPaths, python: venvPython, buildId,
          entryModuleName: entryMod, analysis: pythonConfig,
        });
      }
    }

    // ── Collect output ───────────────────────────────────────────
    const distDir = path.join(appDir, 'dist');
    const outputFiles = [];
    const finalOutputDir = path.join(workDir, 'output');
    fs.mkdirSync(finalOutputDir, { recursive: true });

    if (fs.existsSync(distDir)) {
      function scanDist(d) {
        fs.readdirSync(d).forEach(f => {
          const fp = path.join(d, f);
          const stat = fs.statSync(fp);
          const exts = ['.exe', '.app', '', '.dmg'];
          if (stat.isDirectory() && f.endsWith('.app')) {
            // macOS .app bundle — zip it
            outputFiles.push(fp);
          } else if (stat.isFile() && (f === appName || f === appName + '.exe' || f.endsWith('.exe') || (!f.includes('.') && stat.size > 100000))) {
            outputFiles.push(fp);
          }
        });
      }
      scanDist(distDir);
    }

    // Also check for electron-builder output (wrapper mode outputs to wrapperDir/dist)
    const electronOut = path.join(workDir, 'electron-wrapper', 'dist');
    if (fs.existsSync(electronOut)) {
      collectOutputFiles(electronOut).forEach(f => outputFiles.push(f));
    }

    if (outputFiles.length === 0) {
      log(buildId, 'warn', 'No output binary found in dist/. Check the build log for PyInstaller errors.');
    }

    outputFiles.forEach(f => {
      const dest = path.join(finalOutputDir, path.basename(f));
      try {
        if (fs.statSync(f).isDirectory()) {
          // .app bundle — zip it
          const zipName = path.basename(f) + '.zip';
          const zipDest = path.join(finalOutputDir, zipName);
          require('child_process').execSync(`cd "${path.dirname(f)}" && zip -r "${zipDest}" "${path.basename(f)}"`, { stdio: 'pipe' });
          log(buildId, 'success', `Output: ${zipName} (${formatBytes(fs.statSync(zipDest).size)})`);
          outputFiles.push(zipDest);
        } else {
          fs.copyFileSync(f, dest);
          log(buildId, 'success', `Output: ${path.basename(f)} (${formatBytes(fs.statSync(dest).size)})`);
        }
      } catch(e) {
        log(buildId, 'warn', `Could not copy ${path.basename(f)}: ${e.message}`);
      }
    });

    const duration = ((Date.now() - activeBuilds.get(buildId).startTime) / 1000).toFixed(1);
    log(buildId, 'success', `✅ Python build complete in ${duration}s`);
    activeBuilds.set(buildId, { status: 'complete', outputDir: finalOutputDir });

    const finalFiles = fs.readdirSync(finalOutputDir).map(f => ({
      name: f,
      size: (() => { try { return fs.statSync(path.join(finalOutputDir, f)).size; } catch(_) { return 0; } })(),
      downloadUrl: `/api/download/${buildId}/${f}`
    }));

    broadcast({ type: 'status', buildId, status: 'complete', outputFiles: finalFiles });

  } catch (err) {
    log(buildId, 'error', `Python build failed: ${err.message}`);
    if (err.stack) log(buildId, 'error', err.stack);
    activeBuilds.set(buildId, { status: 'error', error: err.message });
    broadcast({ type: 'status', buildId, status: 'error', error: err.message });
  }
}

async function findPython(buildId) {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const result = require('child_process').execSync(`${cmd} --version 2>&1`, { timeout: 5000 }).toString().trim();
      if (result.includes('Python 3')) {
        log(buildId, 'info', `Found Python: ${result} (${cmd})`);
        return cmd;
      }
    } catch(_) {}
  }
  throw new Error('Python 3 not found on this system. Install Python 3.8+ and ensure it is on your PATH.');
}

async function buildPyInstallerBinary(appDir, entry, appName, opts) {
  const { onefile, noconsole, hiddenImports, addDataPaths, python, buildId, extraArgs = [], entryModuleName, analysis } = opts;
  const sep = process.platform === 'win32' ? ';' : ':';
  const args = ['-m', 'PyInstaller'];
  if (onefile) args.push('--onefile');
  if (noconsole) args.push('--noconsole');
  args.push('--name', appName);
  args.push('--distpath', path.join(appDir, 'dist'));
  args.push('--workpath', path.join(appDir, 'build'));
  args.push('--specpath', path.join(appDir, 'build'));

  // Hidden import for the real entry module (needed for runpy.run_module in frozen mode)
  if (entryModuleName) {
    args.push('--hidden-import', entryModuleName);
  }

  // Minimal hidden imports — with --paths pointing at pkgDir, PyInstaller finds
  // most things automatically. We only need to hint at the top-level packages
  // and a few commonly-missed dynamic imports.
  if (analysis) {
    if (analysis.hasFlask) {
      args.push(
        '--hidden-import', 'flask',
        '--hidden-import', 'werkzeug', '--hidden-import', 'werkzeug.serving',
        '--hidden-import', 'jinja2', '--hidden-import', 'click',
        '--hidden-import', 'itsdangerous', '--hidden-import', 'markupsafe'
      );
    }
    if (analysis.hasFastAPI) {
      args.push(
        '--hidden-import', 'fastapi', '--hidden-import', 'uvicorn',
        '--hidden-import', 'uvicorn.logging', '--hidden-import', 'uvicorn.loops.auto',
        '--hidden-import', 'uvicorn.protocols.http.auto', '--hidden-import', 'uvicorn.lifespan.on',
        '--hidden-import', 'starlette', '--hidden-import', 'anyio._backends._asyncio'
      );
    }
    if (analysis.hasDjango) {
      args.push('--hidden-import', 'django', '--hidden-import', 'django.template');
    }
  }

  // User-specified hidden imports
  if (hiddenImports) {
    hiddenImports.split(/[\s,]+/).filter(Boolean).forEach(imp => {
      args.push('--hidden-import', imp.trim());
    });
  }

  // Add data paths from user input — absolute paths to avoid specpath confusion
  if (addDataPaths) {
    addDataPaths.split('\n').filter(Boolean).forEach(line => {
      const parts = line.split(':');
      const src = parts[0]?.trim();
      const dst = (parts[1] || '.').trim();
      if (src) {
        const absSrc = path.isAbsolute(src) ? src : path.join(appDir, src);
        args.push('--add-data', `${absSrc}${sep}${dst}`);
      }
    });
  }

  // Auto-include common data dirs using absolute paths
  const commonDataDirs = ['templates', 'static', 'assets', 'migrations', 'media'];
  commonDataDirs.forEach(d => {
    const absDir = path.join(appDir, d);
    if (fs.existsSync(absDir)) {
      args.push('--add-data', `${absDir}${sep}${d}`);
      log(buildId, 'info', `  Auto-including data dir: ${d}/`);
    }
  });

  // Auto-include package data directories for known packages that bundle
  // non-Python files (reasoners, schemas, dictionaries, etc.)
  // These live inside the venv's site-packages and must be explicitly added.
  const pkgDataDirs = [
    { pkg: 'owlready2', subdirs: ['pellet', 'hermit'] },  // Java OWL reasoners
    { pkg: 'nltk_data', subdirs: ['.'] },                  // NLTK corpora (top-level)
    { pkg: 'rdflib',    subdirs: ['plugins'] },
  ];
  // Find venv site-packages
  const venvSitePackages = (() => {
    const base = path.join(appDir, '.pyi_venv');
    const winPath = path.join(base, 'Lib', 'site-packages');
    const nixPath = path.join(base, 'lib');
    if (fs.existsSync(winPath)) return winPath;
    if (fs.existsSync(nixPath)) {
      // lib/pythonX.Y/site-packages
      const pyDir = fs.readdirSync(nixPath).find(d => d.startsWith('python'));
      if (pyDir) return path.join(nixPath, pyDir, 'site-packages');
    }
    return null;
  })();
  if (venvSitePackages) {
    for (const { pkg, subdirs } of pkgDataDirs) {
      const pkgDir = path.join(venvSitePackages, pkg);
      if (!fs.existsSync(pkgDir)) continue;
      for (const sub of subdirs) {
        const absData = sub === '.' ? pkgDir : path.join(pkgDir, sub);
        if (fs.existsSync(absData)) {
          const dest = sub === '.' ? pkg : `${pkg}/${sub}`;
          args.push('--add-data', `${absData}${sep}${dest}`);
          log(buildId, 'info', `  Auto-including package data: ${dest}/`);
        }
      }
    }
  }

  // Scan venv for installed packages that need special PyInstaller handling
  if (venvSitePackages && fs.existsSync(path.join(venvSitePackages, 'owlready2'))) {
    // owlready2 uses __file__-relative paths to find reasoners and quad store
    // --collect-data ensures ALL non-.py files inside the package are bundled
    args.push('--collect-data', 'owlready2');
    args.push('--hidden-import', 'owlready2.base');
    args.push('--hidden-import', 'owlready2.namespace');
    args.push('--hidden-import', 'owlready2.entity');
    args.push('--hidden-import', 'owlready2.reasoning');
    log(buildId, 'info', '  owlready2 detected — bundling package data (Pellet reasoner, quad store)');
  }
  if (venvSitePackages && fs.existsSync(path.join(venvSitePackages, 'rdflib'))) {
    args.push('--collect-data', 'rdflib');
    args.push('--hidden-import', 'rdflib.plugins.parsers.notation3');
    args.push('--hidden-import', 'rdflib.plugins.parsers.rdfxml');
    args.push('--hidden-import', 'rdflib.plugins.serializers.rdfxml');
    log(buildId, 'info', '  rdflib detected — bundling plugins');
  }
  if (venvSitePackages && fs.existsSync(path.join(venvSitePackages, 'nltk'))) {
    // Strategy: write a custom runtime hook that runs AFTER pyi_rth_nltk
    // (hooks execute alphabetically; 'z_' suffix ensures it sorts last).
    // The hook patches nltk.data.ZipFilePathPointer so BadZipFile becomes
    // LookupError — the exception owl_tester.py already catches and recovers
    // from via nltk.download(). No corpora need to be bundled.
    const nltkHookLines = [
      '# Custom runtime hook — fixes NLTK BadZipFile in PyInstaller frozen builds.',
      '# Runs after pyi_rth_nltk (alphabetical order) and patches ZipFilePathPointer',
      '# so corrupt/stub zips raise LookupError instead of BadZipFile.',
      'import os, sys, zipfile as _zf',
      'try:',
      '    import nltk.data as _nd',
      '    _user_nltk = os.path.join(os.path.expanduser("~"), "nltk_data")',
      '    os.makedirs(_user_nltk, exist_ok=True)',
      '    # Put user dir first, strip any _MEIPASS stubs',
      '    _mp = getattr(sys, "_MEIPASS", None)',
      '    _nd.path[:] = [_user_nltk] + [p for p in _nd.path',
      '                   if p != _user_nltk and (_mp is None or not p.startswith(_mp))]',
      '    # Patch ZipFilePathPointer.__init__ so BadZipFile -> LookupError',
      '    _orig_init = _nd.ZipFilePathPointer.__init__',
      '    def _safe_init(self, zipfile, entry=""):',
      '        try: _orig_init(self, zipfile, entry)',
      '        except _zf.BadZipFile as e:',
      '            raise LookupError(f"Corrupt NLTK zip {zipfile!r}: {e}")',
      '    _nd.ZipFilePathPointer.__init__ = _safe_init',
      'except Exception:',
      '    pass',
    ];
    const nltkHookPath = path.join(appDir, 'pyi_rth_z_nltk_fix.py');
    fs.writeFileSync(nltkHookPath, nltkHookLines.join('\n') + '\n');
    args.push('--runtime-hook', nltkHookPath);
    log(buildId, 'info', '  nltk detected — injecting BadZipFile→LookupError runtime hook');
  }

  args.push(...extraArgs, entry);
  log(buildId, 'info', `Running PyInstaller: ${args.slice(2).join(' ')}`);
  await runCommand(python, args, appDir, buildId);
  log(buildId, 'success', 'PyInstaller packaging complete ✓');
}

async function injectWebLauncher(appDir, entryPoint, appName, port, python, buildId) {
  // PyInstaller --onefile extracts to a temp dir at runtime.
  // Source .py files are NOT present there — modules are frozen.
  // The correct way to run an entry module in a frozen bundle is runpy.run_module()
  // which looks up the module by name in sys.modules / the frozen importer, not by path.
  const moduleName = entryPoint.replace(/\.py$/i, '').replace(/[/\\]/g, '.');

  const launcherCode = `# Auto-generated launcher by Electron Forge GUI
# Works both as a normal script AND inside a PyInstaller --onefile bundle.
import sys
import os
import time
import threading
import webbrowser
import runpy

PORT = int(os.environ.get('PORT', ${JSON.stringify(port)}))
URL = 'http://localhost:' + str(PORT)

# ── NLTK download destination ────────────────────────────────────────────────
# The pyi_rth_z_nltk_fix runtime hook already patches ZipFilePathPointer so
# BadZipFile raises LookupError. This just ensures nltk.download() saves to
# ~/nltk_data so corpora persist across runs.
os.environ.setdefault('NLTK_DATA', os.path.join(os.path.expanduser('~'), 'nltk_data'))
# ─────────────────────────────────────────────────────────────────────────────

def open_browser():
    import urllib.request
    # Poll until the server responds (up to 30s), then open the browser.
    # Fixed sleep isn't reliable — heavy apps (Flask+owlready2) can take >5s.
    for _ in range(60):
        try:
            urllib.request.urlopen(URL, timeout=1)
            break
        except Exception:
            time.sleep(0.5)
    webbrowser.open(URL)

def main():
    # Open browser in background after server starts
    t = threading.Thread(target=open_browser, daemon=True)
    t.start()

    # runpy.run_module works in both normal Python AND PyInstaller frozen mode.
    # It finds the module by name (not file path), so it works even when
    # .py files are not present in the extraction temp directory.
    try:
        runpy.run_module(${JSON.stringify(moduleName)}, run_name='__main__', alter_sys=True)
    except SystemExit:
        pass  # Flask/Uvicorn may call sys.exit on shutdown — that's fine

if __name__ == '__main__':
    main()
`;
  const launcherPath = path.join(appDir, `_launcher_${appName}.py`);
  fs.writeFileSync(launcherPath, launcherCode);
  log(buildId, 'success', `  Created launcher wrapper → _launcher_${appName}.py (module: ${moduleName})`);
}

async function buildElectronPythonWrapper(appDir, appName, port, workDir, buildId) {
  // Create a minimal Node project that wraps the Python binary in Electron
  const wrapperDir = path.join(workDir, 'electron-wrapper');
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.mkdirSync(path.join(wrapperDir, 'electron'), { recursive: true });

  // Copy the Python binary into the wrapper's resources
  const pythonBin = fs.readdirSync(path.join(appDir, 'dist')).find(f =>
    f === appName || f === appName + '.exe' || (!f.includes('.') && f.toLowerCase().includes(appName.toLowerCase()))
  );
  if (!pythonBin) throw new Error(`PyInstaller binary not found in dist/. Ensure the PyInstaller step succeeded.`);

  const binSrc = path.join(appDir, 'dist', pythonBin);
  const binDest = path.join(wrapperDir, pythonBin);
  fs.copyFileSync(binSrc, binDest);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binDest, '755'); } catch(_) {}
  }
  log(buildId, 'info', `Copied Python binary: ${pythonBin}`);

  // Write Electron main
  const mainJs = `const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = ${port};
let pyProcess = null;
let mainWindow = null;

function waitForServer(port, retries, delay) {
  retries = retries || 30; delay = delay || 500;
  return new Promise(function(resolve, reject) {
    (function attempt(n) {
      http.get('http://localhost:' + port, resolve)
        .on('error', function() { if (n <= 0) return reject(new Error('Python server did not start on :' + port)); setTimeout(function(){attempt(n-1);},delay); });
    })(retries);
  });
}

app.whenReady().then(function() {
  const binName = '${pythonBin}';
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, binName)
    : path.join(__dirname, '..', binName);

  if (!fs.existsSync(binPath)) {
    dialog.showMessageBox({ type:'error', title:'Missing binary', message:'Python server binary not found: ' + binPath, buttons:['Quit'] }).then(function(){ app.quit(); });
    return;
  }

  pyProcess = spawn(binPath, [], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore','pipe','pipe'] });
  pyProcess.stdout && pyProcess.stdout.on('data', function(d){ process.stdout.write('[py] ' + d); });
  pyProcess.stderr && pyProcess.stderr.on('data', function(d){ process.stderr.write('[py] ' + d); });

  waitForServer(PORT).then(function() {
    mainWindow = new BrowserWindow({ width:1280, height:800, webPreferences:{ nodeIntegration:false, contextIsolation:true, webSecurity:false } });
    mainWindow.loadURL('http://localhost:' + PORT);
    mainWindow.webContents.setWindowOpenHandler(function(d){ require('electron').shell.openExternal(d.url); return { action:'deny'}; });
    mainWindow.on('closed', function(){ mainWindow = null; });
  }).catch(function(err){
    dialog.showMessageBox({ type:'error', title:'Server failed', message:err.message, buttons:['Quit'] }).then(function(){ app.quit(); });
  });

  app.on('activate', function(){ if (BrowserWindow.getAllWindows().length===0 && mainWindow===null) mainWindow && mainWindow.show(); });
});

app.on('window-all-closed', function(){ if (pyProcess) pyProcess.kill(); if (process.platform!=='darwin') app.quit(); });
app.on('before-quit', function(){ if (pyProcess) pyProcess.kill(); });
`;
  fs.writeFileSync(path.join(wrapperDir, 'electron', 'main.js'), mainJs);

  // Write wrapper package.json
  const wrapperPkg = {
    name: appName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    version: '1.0.0',
    type: 'commonjs',
    main: 'electron/main.js',
    scripts: { start: 'electron .' },
    devDependencies: { electron: '^28.0.0', 'electron-builder': '^24.0.0' },
    build: {
      appId: `com.${appName.toLowerCase().replace(/[^a-z0-9]/g,'')}.app`,
      productName: appName,
      asar: true,
      directories: { output: 'dist' },  // relative — electron-builder runs from wrapperDir
      files: ['electron/**/*', 'package.json'],
      extraResources: [{ from: path.basename(pythonBin), to: path.basename(pythonBin) }],
      win: { target: [{ target: 'nsis', arch: ['x64'] }] },
      mac: { target: [{ target: 'dmg' }] },
      linux: { target: ['AppImage'] },
    }
  };
  fs.writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify(wrapperPkg, null, 2));

  // npm install + electron-builder
  log(buildId, 'info', 'Installing Electron wrapper dependencies...');
  await runNpmInstall(wrapperDir, buildId);

  const isWin = process.platform === 'win32';
  const builderBin = path.join(wrapperDir, 'node_modules', '.bin', `electron-builder${isWin ? '.cmd' : ''}`);
  if (!fs.existsSync(builderBin)) throw new Error('electron-builder not found in wrapper project after npm install.');

  const nativeTargets = NATIVE_TARGETS[PLATFORM] || {};
  const target = nativeTargets.win ? '--win' : nativeTargets.mac ? '--mac' : '--linux';
  log(buildId, 'info', `Packaging Electron wrapper ${target}...`);
  await runCommand(builderBin, [target, '--publish', 'never'], wrapperDir, buildId);
  log(buildId, 'success', 'Electron wrapper packaged ✓');
}

function buildElectronBuilderArgs(targets) {
  const args = [];
  targets.forEach(t => {
    if (t === 'win') args.push('--win');
    if (t === 'mac') args.push('--mac');
    if (t === 'linux') args.push('--linux');
  });
  args.push('--publish', 'never');
  return args;
}

function findPackageJson(dir, maxDepth = 4) {
  // BFS search up to maxDepth levels — handles GitHub-style ZIPs
  // where content lands in reponame-main/package.json
  const queue = [{ d: dir, depth: 0 }];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next']);

  while (queue.length > 0) {
    const { d, depth } = queue.shift();
    const candidate = path.join(d, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (depth >= maxDepth) continue;
    try {
      const entries = fs.readdirSync(d);
      for (const entry of entries) {
        if (skip.has(entry) || entry.startsWith('.')) continue;
        const full = path.join(d, entry);
        try {
          if (fs.statSync(full).isDirectory()) queue.push({ d: full, depth: depth + 1 });
        } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

function collectOutputFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const exts = ['.exe', '.dmg', '.pkg', '.AppImage', '.deb', '.rpm', '.snap', '.msi', '.zip', '.tar.gz'];
  const files = [];
  function scan(d) {
    fs.readdirSync(d).forEach(f => {
      const fp = path.join(d, f);
      const stat = fs.statSync(fp);
      if (stat.isDirectory() && !f.startsWith('.') && !['mac', 'linux-unpacked', 'win-unpacked'].includes(f)) scan(fp);
      else if (exts.some(e => f.endsWith(e))) files.push(fp);
    });
  }
  scan(dir);
  return files;
}

const EB_STAGES = [
  { re: /electron-builder\s+v/i,         msg: 'electron-builder starting...' },
  { re: /installing app dependencies/i,   msg: 'Installing app dependencies...' },
  { re: /downloading electron/i,          msg: 'Downloading Electron runtime...' },
  { re: /downloaded electron/i,          msg: 'Electron runtime ready ✓' },
  { re: /building target.*nsis/i,        msg: 'Building Windows NSIS installer...' },
  { re: /building target.*dmg/i,         msg: 'Building macOS DMG...' },
  { re: /building target.*appimage/i,    msg: 'Building Linux AppImage...' },
  { re: /building target.*deb/i,         msg: 'Building Debian package...' },
  { re: /packaging for/i,                msg: null },
  { re: /built in \d/i,                  msg: null },
];

function parseElectronBuilderLine(line, buildId) {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!plain) return;
  for (const stage of EB_STAGES) {
    if (stage.re.test(plain)) {
      log(buildId, 'info', '  › ' + (stage.msg || plain));
      broadcast({ type: 'progress_detail', buildId, detail: stage.msg || plain });
      return;
    }
  }
  if (plain.length > 3) log(buildId, 'stdout', plain);
}

async function runFrameworkBuild(appDir, pkgJson, buildId) {
  const isWin = process.platform === 'win32';
  const binExt = isWin ? '.cmd' : '';
  const scripts = pkgJson.scripts || {};
  const allDeps = { ...pkgJson.devDependencies, ...pkgJson.dependencies };

  const distExists = ['dist', 'build', 'out'].some(d =>
    fs.existsSync(path.join(appDir, d, 'index.html')) ||
    fs.existsSync(path.join(appDir, d, 'server', 'index.js'))
  );
  if (distExists) { log(buildId, 'info', 'Compiled output found — skipping build step'); return; }

  const viteBin = path.join(appDir, 'node_modules', '.bin', `vite${binExt}`);
  if (allDeps.vite && fs.existsSync(viteBin)) {
    // Patch vite.config.ts/js to remove Replit-only dev plugins that are
    // ESM-only and use top-level await — they break Vite's CJS config loader.
    patchViteConfig(appDir, buildId);
    patchPostcssConfig(appDir, buildId);
    log(buildId, 'info', 'Running Vite build...');
    await runCommand(viteBin, ['build'], appDir, buildId);
    log(buildId, 'success', 'Vite build complete ✓');
  } else if (scripts.build) {
    log(buildId, 'info', 'Running npm run build...');
    const npmBin = isWin ? 'npm.cmd' : 'npm';
    try {
      await runCommand(npmBin, ['run', 'build'], appDir, buildId);
      log(buildId, 'success', 'Build complete ✓');
    } catch (e) {
      log(buildId, 'warn', 'npm run build exited non-zero — continuing');
    }
  } else {
    log(buildId, 'warn', 'No build script found — if app shows blank content, ensure dist/ is pre-built');
  }
}

function patchViteConfig(appDir, buildId) {
  // Remove Replit-specific dev plugins from vite.config.ts/js before building.
  // Strategy:
  //   Pass 1 — collect identifier names imported from @replit/* packages.
  //   Pass 2 — line-by-line: drop any line referencing @replit/ or calling a
  //             collected identifier. Track open parens to drop multi-line blocks.
  const configFiles = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
  for (const cf of configFiles) {
    const cfPath = path.join(appDir, cf);
    if (!fs.existsSync(cfPath)) continue;
    let src = fs.readFileSync(cfPath, 'utf8');
    const original = src;

    // Pass 1: collect replit-imported names
    const replitNames = new Set();
    for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+['"]@replit\/[^'"]+['"]/gm))
      replitNames.add(m[1]);
    for (const m of src.matchAll(/^import\s*\{([^}]+)\}\s*from\s+['"]@replit\/[^'"]+['"]/gm))
      for (const name of m[1].split(','))
        replitNames.add(name.trim().split(/\s+as\s+/).pop().trim());

    // Pass 2: filter lines
    const lines = src.split('\n');
    const out = [];
    let skipDepth = 0;

    for (const line of lines) {
      if (skipDepth > 0) {
        for (const ch of line) {
          if (ch === '(') skipDepth++;
          if (ch === ')') skipDepth--;
        }
        if (skipDepth <= 0) skipDepth = 0;
        continue;
      }

      // Line references @replit/ directly
      let shouldDrop = line.includes('@replit/');

      // Line calls a known replit-imported identifier
      if (!shouldDrop) {
        for (const name of replitNames) {
          if (new RegExp('(?:\\.\\.\\.)?(?:await\\s+)?' + name + '\\s*\\(').test(line)) {
            shouldDrop = true;
            break;
          }
        }
      }

      if (shouldDrop) {
        let depth = 0;
        for (const ch of line) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
        }
        if (depth > 0) skipDepth = depth;
        continue;
      }

      out.push(line);
    }

    let result = out.join('\n');
    result = result.replace(/,[ \t]*,/g, ',');
    result = result.replace(/,[ \t]*(\])/g, '$1');
    result = result.replace(/(\[)[ \t]*,/g, '$1');

    if (result !== original) {
      fs.writeFileSync(cfPath, result, 'utf8');
      log(buildId, 'info', `  Patched ${cf} — removed Replit-only dev plugins`);
    }
    break;
  }
}

function patchPostcssConfig(appDir, buildId) {
  // When we force "type":"commonjs" in package.json, any config file using
  // ESM `export default` breaks. Convert postcss.config.js (and tailwind.config.js)
  // to CJS syntax so Node can load them.
  const esmConfigFiles = [
    'postcss.config.js',
    'tailwind.config.js',
    'tailwind.config.ts',
  ];
  for (const cf of esmConfigFiles) {
    const cfPath = path.join(appDir, cf);
    if (!fs.existsSync(cfPath)) continue;
    let src = fs.readFileSync(cfPath, 'utf8');
    // Only touch files that use ESM export default
    if (!src.includes('export default')) continue;
    // Convert: export default { ... } → module.exports = { ... }
    const patched = src.replace(/^\s*export\s+default\s+/m, 'module.exports = ');
    if (patched !== src) {
      fs.writeFileSync(cfPath, patched, 'utf8');
      log(buildId, 'info', `  Patched ${cf} — converted ESM export to module.exports`);
    }
  }
}

function runNpmInstall(cwd, buildId) {
  return new Promise((resolve, reject) => {
    log(buildId, 'info', 'Running npm install...');
    const args = ['install', '--verbose', '--no-fund', '--no-audit'];
    const opts = { cwd, shell: process.platform === 'win32' };
    const proc = spawn('npm', args, opts);
    let addedCount = 0, lastPkgCount = 0, deprecCount = 0, warnCount = 0, fetchCount = 0;
    let lastLoggedFetch = '';
    const stderrErrors = [];

    const heartbeat = setInterval(() => broadcast({ type: 'heartbeat', buildId, ts: Date.now() }), 3000);

    function parseLine(line) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!plain) return;
      if (/^npm warn deprecated/i.test(plain)) { deprecCount++; return; }
      if (/^npm warn/i.test(plain)) { warnCount++; return; }
      if (/^npm timing/i.test(plain)) return;
      if (/^npm http fetch (GET|HEAD)/i.test(plain)) {
        const m = plain.match(/GET\s+\d+\s+https?:\/\/[^/]+\/([^/\s]+)/);
        if (m && m[1] !== lastLoggedFetch) {
          lastLoggedFetch = m[1];
          fetchCount++;
          log(buildId, 'stdout', `  fetching  ${m[1]}`);
          broadcast({ type: 'npm_progress', buildId, phase: 'fetch', fetched: fetchCount, label: m[1] });
        }
        return;
      }
      if (/^npm verb/i.test(plain)) return;
      if (/^added \d+|^changed \d+/i.test(plain)) {
        const m = plain.match(/(\d+)\s+package/);
        if (m) addedCount = parseInt(m[1], 10);
        log(buildId, 'success', '  ' + plain);
        broadcast({ type: 'npm_added', buildId, count: addedCount });
        return;
      }
      if (/^npm error/i.test(plain)) { log(buildId, 'error', plain); stderrErrors.push(plain); }
    }

    proc.stdout.on('data', d => d.toString().split('\n').forEach(parseLine));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(parseLine));

    const nmDir = path.join(cwd, 'node_modules');
    let diskTickCount = 0;
    const diskWatcher = setInterval(() => {
      diskTickCount++;
      try {
        const entries = fs.readdirSync(nmDir).filter(e => !e.startsWith('.')).length;
        broadcast({ type: 'heartbeat', buildId, ts: Date.now() });
        if (entries !== lastPkgCount) {
          lastPkgCount = entries;
          log(buildId, 'info', `  node_modules: ${entries} packages...`);
          broadcast({ type: 'npm_progress', buildId, phase: 'unpack', unpacked: entries, total: addedCount || fetchCount || 100 });
          broadcast({ type: 'npm_disk', buildId, count: entries });
        } else if (diskTickCount % 3 === 0) {
          log(buildId, 'info', `  unpacking… (${entries} pkgs, ${diskTickCount * 4}s elapsed)`);
        }
      } catch (_) {
        if (diskTickCount % 3 === 0) log(buildId, 'info', `  npm install running… (${diskTickCount * 4}s elapsed)`);
      }
    }, 4000);

    proc.on('close', code => {
      clearInterval(heartbeat); clearInterval(diskWatcher);
      if (deprecCount > 0) log(buildId, 'warn', `  npm: ${deprecCount} deprecation warnings suppressed`);
      if (warnCount > 0) log(buildId, 'warn', `  npm: ${warnCount} warnings suppressed`);
      if (code === 0) {
        log(buildId, 'success', `npm install complete — ${addedCount || lastPkgCount} packages`);
        resolve();
      } else {
        const tail = stderrErrors.slice(-6).join(' | ');
        reject(new Error('npm install exited with code ' + code + (tail ? ': ' + tail : '')));
      }
    });
    proc.on('error', err => { clearInterval(heartbeat); clearInterval(diskWatcher); reject(err); });
  });
}

function runCommand(cmd, args, cwd, buildId) {
  const isEB  = String(cmd).includes('electron-builder');
  const isPip = String(cmd).includes('python') && args.includes('pip') && args.includes('install');
  const isVenv = String(cmd).includes('python') && args.includes('venv');
  const isRscript = String(cmd).includes('Rscript') || String(cmd).includes('rscript');

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    const stderrErrors = [];
    let deprecatedCount = 0, warnCount = 0;
    const heartbeat = setInterval(() => broadcast({ type: 'heartbeat', buildId, ts: Date.now() }), 3000);

    // For slow operations that can go silent (pip building wheels, R restoring), log elapsed time
    let elapsedSecs = 0;
    let elapsedTicker = null;
    if (isPip || isVenv || isRscript) {
      const label = isPip ? 'pip' : isVenv ? 'venv' : 'Rscript';
      const target = isPip ? (args.find(a => a.endsWith('.txt') || a === 'pyinstaller' || a === '.') || 'packages') : '';
      elapsedTicker = setInterval(() => {
        elapsedSecs += 10;
        // Only log if we haven't had other log activity (avoids duplicate noise)
        log(buildId, 'info', `  ⏱  ${label}${target ? ' ' + target : ''} — still running… ${elapsedSecs}s elapsed`);
      }, 10000);
    }

    proc.stdout.on('data', d => {
      d.toString().split('\n').forEach(l => {
        const line = l.trim();
        if (!line) return;
        if (isPip) {
          // Filter out low-value pip progress lines, keep meaningful ones
          if (/^Collecting |^Downloading |^Building wheel|^Installed |^Successfully installed/i.test(line)) {
            log(buildId, 'stdout', `  ${line}`);
          } else if (/^Successfully installed/i.test(line)) {
            log(buildId, 'success', `  ${line}`);
          }
          // Reset elapsed ticker on any output
          elapsedSecs = 0;
          return;
        }
        if (isEB) parseElectronBuilderLine(line, buildId);
        else log(buildId, 'stdout', line);
      });
    });

    proc.stderr.on('data', d => {
      d.toString().split('\n').forEach(l => {
        const line = l.trim();
        if (!line) return;
        if (/^npm warn deprecated/i.test(line)) { deprecatedCount++; return; }
        if (/^npm warn/i.test(line)) { warnCount++; return; }
        if (isPip) {
          // pip sends warnings and errors to stderr
          if (/^error:|^warning:/i.test(line)) log(buildId, 'warn', `  pip: ${line}`);
          // Reset elapsed ticker on any output
          elapsedSecs = 0;
          return;
        }
        if (isEB) parseElectronBuilderLine(line, buildId);
        else { log(buildId, 'stderr', line); stderrErrors.push(line); }
      });
    });

    proc.on('close', code => {
      clearInterval(heartbeat);
      if (elapsedTicker) clearInterval(elapsedTicker);
      if (deprecatedCount > 0) log(buildId, 'warn', `npm: ${deprecatedCount} deprecation warnings suppressed`);
      if (warnCount > 0) log(buildId, 'warn', `npm: ${warnCount} warnings suppressed`);
      if (code === 0) resolve();
      else { const tail = stderrErrors.slice(-6).join(' | '); reject(new Error('Command exited with code ' + code + (tail ? ' — ' + tail : ''))); }
    });

    proc.on('error', err => {
      clearInterval(heartbeat);
      if (elapsedTicker) clearInterval(elapsedTicker);
      log(buildId, 'error', 'Failed to spawn: ' + err.message);
      reject(err);
    });
  });
}

function extractTar(filePath, destDir, buildId) {
  return new Promise((resolve, reject) => {
    const isGzip = filePath.endsWith('.gz') || filePath.endsWith('.tgz');
    const args = isGzip ? ['-xzf', filePath, '-C', destDir] : ['-xf', filePath, '-C', destDir];
    const proc = spawn('tar', args);
    proc.stderr.on('data', d => { if (buildId && buildId !== 'analyze') log(buildId, 'stderr', d.toString()); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
    proc.on('error', reject);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

app.get('/api/download/:buildId/:filename', (req, res) => {
  const { buildId, filename } = req.params;
  const filePath = path.join(BUILDS_DIR, buildId, 'output', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

app.get('/api/builds', (req, res) => {
  const builds = [];
  activeBuilds.forEach((v, k) => builds.push({ id: k, ...v }));
  res.json(builds);
});

app.use((err, req, res, next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n⚡ Electron Forge V4 running at ${url}\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.log('  Tip: Set ANTHROPIC_API_KEY to enable the AI Guide feature.\n');
  if (process.pkg) {
    // Running as packaged exe — open browser automatically
    console.log('  Opening browser...');
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd);
  }
});

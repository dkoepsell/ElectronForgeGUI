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

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILDS_DIR = path.join(__dirname, 'builds');

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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.tar', '.tar.gz', '.tgz', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.originalname.endsWith('.tar.gz')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  }
});

// Track active builds
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

function log(buildId, level, message) {
  broadcast({ type: 'log', buildId, level, message, timestamp: new Date().toISOString() });
  console.log(`[${buildId}] [${level}] ${message}`);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Platform compatibility matrix
const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
const NATIVE_TARGETS = {
  win32:  { win: true,  mac: false, linux: false },
  darwin: { win: false, mac: true,  linux: false },
  linux:  { win: false, mac: false, linux: true  },
};
// With Wine installed on Linux, win is also possible — but we won't assume it
const TARGET_REQUIRES = {
  win:   'Windows',
  mac:   'macOS',
  linux: 'Linux',
};

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ready',
    activeBuilds: activeBuilds.size,
    platform: PLATFORM,
    nativeTargets: NATIVE_TARGETS[PLATFORM] || { win: false, mac: false, linux: false },
  });
});

app.post('/api/upload', (req, res) => {
  // Call multer manually so we can catch its errors and always send a JSON response
  upload.single('package')(req, res, (err) => {
    if (err) {
      console.error('[upload] multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 500 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload error' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file received — check the field name is "package"' });
    }

    const buildId = `build_${Date.now()}`;
    const file = req.file;
    console.log(`[upload] received: ${file.originalname} (${file.size} bytes) → ${file.path}`);

    res.json({
      buildId,
      filename: file.originalname,
      size: file.size,
      path: file.path,
      message: 'File uploaded successfully'
    });
  });
});

app.post('/api/build', async (req, res) => {
  const { buildId, filePath, filename, targets, config } = req.body;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const workDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });

  res.json({ status: 'started', buildId });

  // Run build asynchronously
  runBuild(buildId, filePath, filename, workDir, targets, config);
});

async function runBuild(buildId, filePath, filename, workDir, targets, config) {
  activeBuilds.set(buildId, { status: 'extracting', startTime: Date.now() });
  broadcast({ type: 'status', buildId, status: 'extracting' });

  try {
    log(buildId, 'info', `Starting build for: ${filename}`);
    log(buildId, 'info', `Work directory: ${workDir}`);

    // Extract the package
    const ext = filename.toLowerCase();
    const extractDir = path.join(workDir, 'source');
    fs.mkdirSync(extractDir, { recursive: true });

    if (ext.endsWith('.zip')) {
      log(buildId, 'info', 'Extracting ZIP archive...');
      await extractZip(filePath, { dir: extractDir });
      log(buildId, 'success', 'ZIP extracted successfully');
    } else if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz') || ext.endsWith('.tar')) {
      log(buildId, 'info', 'Extracting TAR archive...');
      await extractTar(filePath, extractDir, buildId);
    } else {
      // Assume it's already a directory or package.json was given
      log(buildId, 'warn', 'Unsupported archive format, treating as direct path');
    }

    // Find package.json
    const pkgJsonPath = findPackageJson(extractDir);
    if (!pkgJsonPath) {
      throw new Error('No package.json found in the uploaded package');
    }

    log(buildId, 'info', `Found package.json at: ${pkgJsonPath}`);
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    log(buildId, 'info', `App: ${pkgJson.name || 'Unknown'} v${pkgJson.version || '0.0.0'}`);

    const appDir = path.dirname(pkgJsonPath);

    // Validate electron-builder config exists
    if (!pkgJson.build) {
      log(buildId, 'warn', 'No "build" key found in package.json — electron-builder may use defaults');
    }

    // IMPORTANT: Must install ALL deps (including devDependencies) because
    // electron itself lives in devDependencies and electron-builder needs it.
    // See: https://github.com/electron-userland/electron-builder/issues/3984
    broadcast({ type: 'status', buildId, status: 'installing' });
    log(buildId, 'info', 'Installing ALL dependencies (including devDependencies)...');
    log(buildId, 'info', 'Note: electron must be in devDependencies for this to work');
    await runNpmInstall(appDir, buildId);
    log(buildId, 'success', 'Dependencies installed');

    // Verify electron is present after install
    const electronBin = path.join(appDir, 'node_modules', '.bin', 'electron');
    const electronBinWin = electronBin + '.cmd';
    if (!fs.existsSync(electronBin) && !fs.existsSync(electronBinWin)) {
      log(buildId, 'warn', 'electron not found in node_modules/.bin — make sure "electron" is in devDependencies');
    } else {
      log(buildId, 'info', 'electron binary found ✓');
    }

    // Resolve electron-builder binary — prefer local (project's own) then fall back to ours
    // On Windows binaries have a .cmd extension
    const isWin = process.platform === 'win32';
    const binExt = isWin ? '.cmd' : '';

    const localBuilderBin = path.join(appDir, 'node_modules', '.bin', `electron-builder${binExt}`);
    const ownBuilderBin   = path.join(__dirname, 'node_modules', '.bin', `electron-builder${binExt}`);

    let electronBuilderBin;
    if (fs.existsSync(localBuilderBin)) {
      electronBuilderBin = localBuilderBin;
      log(buildId, 'info', 'Using project-local electron-builder');
    } else if (fs.existsSync(ownBuilderBin)) {
      electronBuilderBin = ownBuilderBin;
      log(buildId, 'info', 'Using bundled electron-builder');
    } else {
      throw new Error('electron-builder not found. Add it to devDependencies or ensure npm install succeeded.');
    }

    // ── Run framework build step (Vite, webpack) before electron-builder ──
    await runFrameworkBuild(appDir, pkgJson, buildId);

    // Build with electron-builder
    broadcast({ type: 'status', buildId, status: 'building' });
    log(buildId, 'info', 'Starting electron-builder...');

    // Filter out targets that can't be built on this platform
    const nativeTargets = NATIVE_TARGETS[PLATFORM] || {};
    const validTargets = (targets || []).filter(t => nativeTargets[t]);
    const skipped = (targets || []).filter(t => !nativeTargets[t]);
    if (skipped.length > 0) {
      log(buildId, 'warn', `Skipping incompatible targets on ${PLATFORM}: ${skipped.join(', ')}`);
      log(buildId, 'warn', `  mac builds require macOS, win builds require Windows`);
    }
    if (validTargets.length === 0) {
      throw new Error(`No valid build targets for this platform (${PLATFORM}). Selected: ${(targets||[]).join(', ')}`);
    }
    log(buildId, 'info', `Building for: ${validTargets.join(', ')}`);

    const builderArgs = buildElderBuilderArgs(validTargets, config, workDir);
    log(buildId, 'info', `electron-builder args: ${builderArgs.join(' ')}`);

    await runCommand(electronBuilderBin, builderArgs, appDir, buildId);

    // Collect output files — check both 'dist' and 'dist-electron' (vite-electron projects)
    const distDirs = ['dist', 'dist-electron', 'release', 'out'].map(d => path.join(appDir, d));
    const outputFiles = distDirs.flatMap(d => collectOutputFiles(d));
    if (outputFiles.length === 0) {
      log(buildId, 'warn', 'No output files found in dist/, dist-electron/, release/, or out/');
      log(buildId, 'warn', 'Check your electron-builder "directories.output" config in package.json');
    }

    // Move outputs to build dir
    const finalOutputDir = path.join(workDir, 'output');
    fs.mkdirSync(finalOutputDir, { recursive: true });

    outputFiles.forEach(f => {
      const dest = path.join(finalOutputDir, path.basename(f));
      fs.copyFileSync(f, dest);
      log(buildId, 'success', `Output: ${path.basename(f)} (${formatBytes(fs.statSync(dest).size)})`);
    });

    const duration = ((Date.now() - activeBuilds.get(buildId).startTime) / 1000).toFixed(1);
    log(buildId, 'success', `Build completed in ${duration}s! ${outputFiles.length} file(s) generated.`);

    activeBuilds.set(buildId, { status: 'complete', outputDir: finalOutputDir, outputFiles: outputFiles.map(f => path.basename(f)) });
    broadcast({
      type: 'status',
      buildId,
      status: 'complete',
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

function buildElderBuilderArgs(targets, config, workDir) {
  const args = [];

  if (targets && targets.length > 0) {
    targets.forEach(t => {
      switch (t) {
        case 'win': args.push('--win'); break;
        case 'mac': args.push('--mac'); break;
        case 'linux': args.push('--linux'); break;
      }
    });
  }

  args.push('--publish', 'never');
  return args;
}

function findPackageJson(dir) {
  const direct = path.join(dir, 'package.json');
  if (fs.existsSync(direct)) return direct;

  // Search one level deep
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    if (fs.statSync(entryPath).isDirectory()) {
      const nested = path.join(entryPath, 'package.json');
      if (fs.existsSync(nested)) return nested;
    }
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
      if (stat.isDirectory() && !f.startsWith('.') && f !== 'mac' && f !== 'linux-unpacked' && f !== 'win-unpacked') {
        scan(fp);
      } else if (exts.some(e => f.endsWith(e))) {
        files.push(fp);
      }
    });
  }

  scan(dir);
  return files;
}

// Electron-builder output keywords that map to meaningful progress stages
const EB_STAGES = [
  { re: /electron-builder\s+v/i,            msg: 'electron-builder starting up...' },
  { re: /installing app dependencies/i,       msg: 'Installing app dependencies...' },
  { re: /downloading electron/i,              msg: 'Downloading Electron runtime...' },
  { re: /downloaded electron/i,              msg: 'Electron runtime ready ✓' },
  { re: /building target.*nsis/i,            msg: 'Building Windows NSIS installer...' },
  { re: /building target.*msi/i,             msg: 'Building Windows MSI...' },
  { re: /building target.*dmg/i,             msg: 'Building macOS DMG...' },
  { re: /building target.*appimage/i,        msg: 'Building Linux AppImage...' },
  { re: /building target.*deb/i,             msg: 'Building Debian package...' },
  { re: /building target.*snap/i,            msg: 'Building Snap package...' },
  { re: /packaging for/i,                    msg: null },  // pass through raw
  { re: /signing/i,                          msg: null },
  { re: /built in \d/i,                     msg: null },
];

function parseElectronBuilderLine(line, buildId) {
  // Strip ANSI colour codes
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!plain) return;

  for (const stage of EB_STAGES) {
    if (stage.re.test(plain)) {
      const msg = stage.msg || plain;
      log(buildId, 'info', '  › ' + msg);
      broadcast({ type: 'progress_detail', buildId, detail: msg });
      return;
    }
  }
  // Default: show as stdout but only non-trivial lines
  if (plain.length > 3) log(buildId, 'stdout', plain);
}



async function runFrameworkBuild(appDir, pkgJson, buildId) {
  const isWin    = process.platform === 'win32';
  const binExt   = isWin ? '.cmd' : '';
  const nodeFs   = require('fs');
  const nodePath = require('path');

  // Check if dist/index.html already exists
  const distDirs = ['dist', 'build', 'out', 'renderer/dist'];
  const distExists = distDirs.some(d =>
    nodeFs.existsSync(nodePath.join(appDir, d, 'index.html'))
  );
  if (distExists) {
    log(buildId, 'info', 'Renderer build already exists — skipping framework build');
    return;
  }

  const scripts  = pkgJson.scripts || {};
  const deps     = Object.assign({}, pkgJson.devDependencies, pkgJson.dependencies);
  const viteBin  = nodePath.join(appDir, 'node_modules', '.bin', `vite${binExt}`);
  const wpBin    = nodePath.join(appDir, 'node_modules', '.bin', `webpack${binExt}`);

  if (deps.vite && nodeFs.existsSync(viteBin)) {
    // Ensure React is installed — projects often omit it from package.json
    const isWin2   = process.platform === 'win32';
    const npmBin2  = isWin2 ? 'npm.cmd' : 'npm';
    const reactDir = nodePath.join(appDir, 'node_modules', 'react');
    const hasReactPlugin = !!(deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-react-swc']);
    if (hasReactPlugin && !nodeFs.existsSync(reactDir)) {
      log(buildId, 'warn', 'react/react-dom not found but @vitejs/plugin-react is used — installing them now...');
      await runCommand(npmBin2, ['install', '--save', 'react', 'react-dom', '--no-fund', '--no-audit'], appDir, buildId);
      log(buildId, 'success', 'react + react-dom installed ✓');
    }
    log(buildId, 'info', 'Running Vite build to compile renderer (this is required before packaging)...');
    await runCommand(viteBin, ['build'], appDir, buildId);
    log(buildId, 'success', 'Vite renderer build complete ✓');
  } else if (deps.webpack && nodeFs.existsSync(wpBin)) {
    log(buildId, 'info', 'Running webpack to compile renderer...');
    await runCommand(wpBin, [], appDir, buildId);
    log(buildId, 'success', 'webpack renderer build complete ✓');
  } else if (scripts.build) {
    log(buildId, 'warn', 'Running npm run build (may call electron-builder internally — errors may be ignored)');
    const npmBin = isWin ? 'npm.cmd' : 'npm';
    try {
      await runCommand(npmBin, ['run', 'build'], appDir, buildId);
    } catch (e) {
      log(buildId, 'warn', 'npm run build exited non-zero — continuing (may be expected)');
    }
  } else {
    log(buildId, 'warn', 'No bundler found — if app shows blank screen, ensure dist/ is pre-built');
  }
}

function runNpmInstall(cwd, buildId) {
  return new Promise((resolve, reject) => {
    log(buildId, 'info', 'Running npm install --verbose (watching for activity)...');

    // --verbose gives us per-package lines we can parse
    // --no-fund / --no-audit suppress extra network requests
    const args = ['install', '--verbose', '--no-fund', '--no-audit'];
    const opts = { cwd, shell: process.platform === 'win32' };
    const proc = spawn('npm', args, opts);

    let addedCount   = 0;
    let fetchCount   = 0;
    let deprecCount  = 0;
    let warnCount    = 0;
    let lastLoggedFetch = '';
    const stderrErrors = [];

    // Live heartbeat every 3 s
    const heartbeat = setInterval(() => {
      broadcast({ type: 'heartbeat', buildId, ts: Date.now() });
    }, 3000);

    // Throttle: emit a "fetching X…" line at most once per package name
    function maybeLogFetch(pkg) {
      if (pkg && pkg !== lastLoggedFetch) {
        lastLoggedFetch = pkg;
        log(buildId, 'stdout', `  fetching  ${pkg}`);
        fetchCount++;
      }
    }

    function parseLine(line) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!plain) return;

      // ── suppress noise ──
      if (/^npm warn deprecated/i.test(plain)) { deprecCount++; return; }
      if (/^npm warn/i.test(plain))             { warnCount++;   return; }
      if (/^npm timing/i.test(plain))           { return; }
      if (/^npm http fetch (GET|HEAD)/i.test(plain)) {
        // e.g. "npm http fetch GET 200 https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
        const m = plain.match(/GET\s+\d+\s+https?:\/\/[^/]+\/([^/\s]+)/);
        maybeLogFetch(m ? m[1] : null);
        return;
      }

      // ── meaningful progress ──
      // "npm verb reify:loadIdealTree" etc — skip verb lines except useful ones
      if (/^npm verb/i.test(plain)) {
        const m = plain.match(/reify:([^\s]+)/i);
        if (m) maybeLogFetch(m[1]);
        return;
      }

      // "added 142 packages" / "changed 3 packages"
      if (/^added \d+|^changed \d+|^removed \d+|^audited \d+/i.test(plain)) {
        const m = plain.match(/(\d+)\s+package/);
        if (m) addedCount = parseInt(m[1], 10);
        log(buildId, 'success', '  ' + plain);
        broadcast({ type: 'npm_added', buildId, count: addedCount });
        return;
      }

      // "npm notice" lines — pass through briefly
      if (/^npm notice/i.test(plain)) {
        log(buildId, 'stdout', '  ' + plain);
        return;
      }

      // "npm error" — always surface
      if (/^npm error/i.test(plain)) {
        log(buildId, 'error', plain);
        stderrErrors.push(plain);
        return;
      }

      // anything else short / noisy — skip
    }

    proc.stdout.on('data', d => d.toString().split('\n').forEach(parseLine));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(parseLine));

    // Also watch node_modules grow on disk as a secondary progress signal
    const nmDir = require('path').join(cwd, 'node_modules');
    let lastPkgCount = 0;
    let diskTickCount = 0;
    const diskWatcher = setInterval(() => {
      diskTickCount++;
      try {
        const entries = require('fs').readdirSync(nmDir).filter(e => !e.startsWith('.')).length;
        broadcast({ type: 'heartbeat', buildId, ts: Date.now() });
        if (entries !== lastPkgCount) {
          lastPkgCount = entries;
          log(buildId, 'info', `  node_modules: ${entries} packages on disk...`);
          broadcast({ type: 'npm_disk', buildId, count: entries });
        } else if (diskTickCount % 3 === 0) {
          // Every ~12s, emit a "still unpacking" message so the UI doesn't look frozen
          log(buildId, 'info', `  unpacking… (${entries} pkgs, ${diskTickCount * 4}s elapsed)`);
        }
      } catch (_) {
        if (diskTickCount % 3 === 0) {
          log(buildId, 'info', `  npm install running… (${diskTickCount * 4}s elapsed)`);
        }
      }
    }, 4000);

    proc.on('close', code => {
      clearInterval(heartbeat);
      clearInterval(diskWatcher);
      if (deprecCount > 0) log(buildId, 'warn', `  npm: ${deprecCount} deprecated package warning(s) suppressed`);
      if (warnCount > 0)   log(buildId, 'warn', `  npm: ${warnCount} other warning(s) suppressed`);
      if (code === 0) {
        log(buildId, 'success', `npm install complete — ${addedCount || lastPkgCount} packages`);
        resolve();
      } else {
        const tail = stderrErrors.slice(-6).join(' | ');
        reject(new Error('npm install exited with code ' + code + (tail ? ': ' + tail : '')));
      }
    });

    proc.on('error', err => {
      clearInterval(heartbeat);
      clearInterval(diskWatcher);
      log(buildId, 'error', 'npm spawn error: ' + err.message);
      reject(err);
    });
  });
}

function runCommand(cmd, args, cwd, buildId) {
  const isElectronBuilder = cmd.includes('electron-builder');
  const isNpm = args[0] === 'install' || cmd === 'npm';

  return new Promise((resolve, reject) => {
    const opts = { cwd, shell: process.platform === 'win32' };
    const proc = spawn(cmd, args, opts);
    const stderrErrors = [];
    let deprecatedCount = 0;
    let warnCount = 0;

    // Heartbeat so the client knows the process is alive
    const heartbeat = setInterval(() => {
      broadcast({ type: 'heartbeat', buildId, ts: Date.now() });
    }, 3000);

    proc.stdout.on('data', d => {
      d.toString().split('\n').forEach(l => {
        const line = l.trim();
        if (!line) return;
        if (isElectronBuilder) {
          parseElectronBuilderLine(line, buildId);
        } else {
          log(buildId, 'stdout', line);
        }
      });
    });

    proc.stderr.on('data', d => {
      d.toString().split('\n').forEach(l => {
        const line = l.trim();
        if (!line) return;

        // Suppress noisy npm deprecation spam — just count
        if (isNpm && line.startsWith('npm warn deprecated')) {
          deprecatedCount++;
          return;
        }
        if (isNpm && line.startsWith('npm warn')) {
          warnCount++;
          return;
        }

        // Electron-builder progress often goes to stderr
        if (isElectronBuilder) {
          parseElectronBuilderLine(line, buildId);
        } else {
          log(buildId, 'stderr', line);
        }
        stderrErrors.push(line);
      });
    });

    proc.on('close', code => {
      clearInterval(heartbeat);
      if (deprecatedCount > 0) log(buildId, 'warn', `npm: ${deprecatedCount} deprecated package warning(s) suppressed`);
      if (warnCount > 0)       log(buildId, 'warn', `npm: ${warnCount} other warning(s) suppressed`);
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrErrors.slice(-6).join(' | ');
        reject(new Error('Command exited with code ' + code + (tail ? ' — ' + tail : '')));
      }
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      log(buildId, 'error', 'Failed to spawn: ' + err.message);
      if (err.code === 'ENOENT') log(buildId, 'error', 'Command not found: ' + cmd);
      reject(err);
    });
  });
}

function extractTar(filePath, destDir, buildId) {
  return new Promise((resolve, reject) => {
    const isGzip = filePath.endsWith('.gz') || filePath.endsWith('.tgz');
    const args = isGzip ? ['-xzf', filePath, '-C', destDir] : ['-xf', filePath, '-C', destDir];
    const proc = spawn('tar', args);
    proc.stderr.on('data', d => log(buildId, 'stderr', d.toString()));
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

// Global error handler — ensures every unhandled Express error returns JSON
app.use((err, req, res, next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, () => {
  console.log(`\n⚡ Electron Forge GUI running at http://localhost:${PORT}\n`);
});

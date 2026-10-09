'use strict';
/**
 * Workspace scanning service: finds candidate files, runs the scanner, caches per-file analyses,
 * watches for changes and publishes the resolved endpoint list.
 */
const vscode = require('vscode');
const path = require('path');
const scanner = require('./scanner');

const INCLUDE = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,java,kt,kts,cs,go,php,rb,rs,json,yaml,yml,properties}';
const DEFAULT_EXCLUDES = ['node_modules', 'bower_components', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.git', 'vendor', 'venv', '.venv', '__pycache__', '.next', '.nuxt', '.svelte-kit', 'coverage', '.gradle', '.idea', '.vs', '.routinel', 'site-packages', '.tox', '.mypy_cache', '.terraform', 'Pods', 'DerivedData', '.angular', '.turbo', '.cache'];
const SKIP_FILE = /(\.min\.js|\.d\.ts|\.map|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig.*\.json|jsconfig\.json|composer\.lock|\.eslintrc.*|\.prettierrc.*|angular\.json|nx\.json|project\.json|turbo\.json|lerna\.json|renovate\.json|\.babelrc|appsettings.*\.json|docker-compose.*\.ya?ml|\.gitlab-ci\.ya?ml|pubspec\.ya?ml|mkdocs\.ya?ml|Chart\.ya?ml|values.*\.ya?ml|kustomization\.ya?ml)$/i;
const TEST_FILE = /([._-](test|spec)s?\.[a-z]+$)|([\\/](tests?|__tests__|spec|e2e|cypress|playwright)[\\/])|(Tests?\.(java|kt|cs)$)|(_test\.(go|py)$)|(^|[\\/])test_[^\\/]*\.py$/i;

class ScanService {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.analyses = new Map();
    this.endpoints = [];
    this.byId = new Map();
    this.hints = { baseUrls: ['http://localhost:3000'] };
    this.scanning = false;
    this.lastScan = null;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._pending = new Set();
    this._timer = null;
  }

  config() {
    const c = vscode.workspace.getConfiguration('routinel');
    return {
      exclude: [...DEFAULT_EXCLUDES, ...(c.get('scan.excludeFolders') || [])],
      extraExcludeGlob: c.get('scan.exclude') || '',
      maxFiles: c.get('scan.maxFiles') || 20000,
      maxFileSizeKB: c.get('scan.maxFileSizeKB') || 768,
      includeTests: !!c.get('scan.includeTests'),
      autoScan: c.get('scan.autoRescan') !== false,
    };
  }

  isExcluded(fsPath, cfg = this.config()) {
    const norm = fsPath.replace(/\\/g, '/');
    const segs = norm.split('/');
    if (segs.some((s) => cfg.exclude.includes(s))) return true;
    if (SKIP_FILE.test(norm)) return true;
    if (!cfg.includeTests && TEST_FILE.test(norm)) return true;
    return false;
  }

  async scanAll() {
    if (this.scanning) return;
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length || vscode.workspace.getConfiguration('routinel').get('scan.workspace', true) === false) {
      this.endpoints = [];
      this._publish();
      return;
    }
    this.scanning = true;
    this._onDidChange.fire({ scanning: true });
    const started = Date.now();
    const cfg = this.config();
    try {
      await vscode.window.withProgress({ location: { viewId: 'routinel.apis' }, title: 'Scanning for APIs…' }, async () => {
        const excludeGlob = '**/{' + cfg.exclude.join(',') + '}/**';
        let uris = await vscode.workspace.findFiles(INCLUDE, excludeGlob, cfg.maxFiles);
        const envFiles = await vscode.workspace.findFiles('**/.env', excludeGlob, 50);
        uris = uris.concat(envFiles).filter((u) => !this.isExcluded(u.fsPath, cfg));
        if (cfg.extraExcludeGlob) {
          const extra = new Set((await vscode.workspace.findFiles(INCLUDE, cfg.extraExcludeGlob, cfg.maxFiles)).map((u) => u.toString()));
          uris = uris.filter((u) => extra.has(u.toString()));
        }
        const fileSet = new Set(uris.map((u) => u.fsPath));
        this.analyses.clear();
        const batch = 64;
        for (let i = 0; i < uris.length; i += batch) {
          await Promise.all(uris.slice(i, i + batch).map((u) => this._analyze(u, fileSet, cfg)));
        }
        this.fileSet = fileSet;
        this._resolve();
        this.lastScan = { files: uris.length, ms: Date.now() - started, at: new Date() };
        this._log(`Scanned ${uris.length} files in ${this.lastScan.ms} ms → ${this.endpoints.length} endpoints`);
        const byFw = {};
        for (const e of this.endpoints) byFw[e.framework] = (byFw[e.framework] || 0) + 1;
        for (const [fw, n] of Object.entries(byFw).sort((a, b) => b[1] - a[1])) this._log(`   ${fw}: ${n}`);
        for (const a of this.analyses.values()) if (a.error) this._log(`   ! ${a.file}: ${a.error}`);
      });
    } catch (e) {
      this._log('Scan failed: ' + (e && e.stack ? e.stack : e));
      vscode.window.showErrorMessage('Routinel: scan failed — ' + (e && e.message ? e.message : e));
    } finally {
      this.scanning = false;
      this._publish();
    }
  }

  async _analyze(uri, fileSet, cfg) {
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      if (buf.byteLength > cfg.maxFileSizeKB * 1024) return;
      const text = Buffer.from(buf).toString('utf8');
      this.analyses.set(uri.fsPath, scanner.analyzeFile(uri.fsPath, text, { fileSet }));
    } catch (e) {
      // unreadable file: ignore
    }
  }

  _resolve() {
    const res = scanner.resolve([...this.analyses.values()]);
    this.endpoints = res.endpoints;
    this.hints = res.hints;
    this.byId = new Map(this.endpoints.map((e) => [e.id, e]));
  }

  _publish() {
    this._onDidChange.fire({ scanning: this.scanning });
  }

  _log(msg) {
    if (this.output) this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  startWatching() {
    const watcher = vscode.workspace.createFileSystemWatcher(INCLUDE);
    const queue = (uri) => {
      if (!this.config().autoScan) return;
      if (vscode.workspace.getConfiguration('routinel').get('scan.workspace', true) === false) return;
      if (this.isExcluded(uri.fsPath)) return;
      this._pending.add(uri.toString());
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), 700);
    };
    watcher.onDidChange(queue);
    watcher.onDidCreate(queue);
    watcher.onDidDelete((uri) => {
      if (this.analyses.delete(uri.fsPath)) {
        this._resolve();
        this._publish();
      }
    });
    this.context.subscriptions.push(watcher);
  }

  async _flush() {
    if (this.scanning) {
      this._timer = setTimeout(() => this._flush(), 700);
      return;
    }
    const uris = [...this._pending].map((s) => vscode.Uri.parse(s));
    this._pending.clear();
    const cfg = this.config();
    this.fileSet = this.fileSet || new Set();
    for (const u of uris) this.fileSet.add(u.fsPath);
    for (const u of uris) {
      this.analyses.delete(u.fsPath);
      await this._analyze(u, this.fileSet, cfg);
    }
    const before = this.endpoints.length;
    this._resolve();
    if (before !== this.endpoints.length) this._log(`Re-scanned ${uris.length} changed file(s) → ${this.endpoints.length} endpoints`);
    this._publish();
  }

  get(id) {
    return this.byId.get(id) || (this.projects ? this.projects.getEndpoint(id) : undefined);
  }

  forFile(fsPath) {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const target = norm(fsPath);
    const own = this.endpoints.filter((e) => norm(e.file) === target);
    return own.length || !this.projects ? own : this.projects.forFile(fsPath);
  }

  relative(file) {
    const proj = this.projects && this.projects.projectOfFile(file);
    if (proj) return proj.name + '/' + require('path').relative(proj.root, file).replace(/\\/g, '/');
    return vscode.workspace.asRelativePath(file, (vscode.workspace.workspaceFolders || []).length > 1);
  }

  basename(file) {
    return path.basename(file);
  }
}

module.exports = { ScanService, DEFAULT_EXCLUDES, SKIP_FILE, TEST_FILE };

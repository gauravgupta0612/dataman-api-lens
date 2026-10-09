'use strict';
/**
 * Projects: folders or Git repositories that YOU point Routinel at (they do not need to be open in VS Code).
 * Each project is scanned with the same detectors, its APIs are saved (globalStorage/projects.json) so they are
 * available in every window and after restarts, and it is re-scanned when its files change.
 */
const vscode = require('vscode');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const scanner = require('./scanner');
const { DEFAULT_EXCLUDES, SKIP_FILE, TEST_FILE } = require('./service');

const EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|kts|cs|go|php|rb|rs|json|ya?ml|properties)$|(^|[\\/])\.env$/i;

class ProjectService {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.projects = [];
    this.byId = new Map();
    this.scanning = new Set();
    this.watchers = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  file() {
    return path.join(this.context.globalStorageUri.fsPath, 'projects.json');
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file(), 'utf8'));
      this.projects = Array.isArray(data.projects) ? data.projects : [];
    } catch (e) {
      this.projects = [];
    }
    this._reindex();
    for (const p of this.projects) this._watch(p);
    this._onDidChange.fire();
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file()), { recursive: true });
    await fsp.writeFile(this.file(), JSON.stringify({ version: 1, projects: this.projects }, null, 2));
  }

  _reindex() {
    this.byId = new Map();
    for (const p of this.projects) for (const e of p.endpoints || []) this.byId.set(e.id, e);
  }

  _log(m) {
    if (this.output) this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  }

  get(id) {
    return this.projects.find((p) => p.id === id);
  }

  getEndpoint(id) {
    return this.byId.get(id);
  }

  projectOfFile(file) {
    const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const f = norm(file);
    return this.projects.find((p) => f.startsWith(norm(p.root + path.sep)) || f === norm(p.root));
  }

  forFile(file) {
    const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const f = norm(file);
    const p = this.projectOfFile(file);
    return p ? (p.endpoints || []).filter((e) => norm(e.file) === f) : [];
  }

  allEndpoints() {
    return this.projects.flatMap((p) => p.endpoints || []);
  }

  // ---------------------------------------------------------------- add
  async addFolder(root, name) {
    root = path.resolve(root.trim().replace(/^"|"$/g, ''));
    const st = await fsp.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('Folder not found: ' + root);
    const existing = this.projects.find((p) => path.resolve(p.root).toLowerCase() === root.toLowerCase());
    if (existing) {
      await this.rescan(existing.id);
      return existing;
    }
    const project = { id: crypto.randomBytes(6).toString('hex'), name: name || path.basename(root), root, addedAt: Date.now(), endpoints: [], hints: null, git: await gitInfo(root) };
    this.projects.push(project);
    await this.save();
    this._watch(project);
    await this.rescan(project.id);
    return project;
  }

  async addGit(url, parentDir, branch) {
    const repoName = url.replace(/\.git$/, '').replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || 'repo';
    let dest = path.join(parentDir, repoName);
    let i = 2;
    while (fs.existsSync(dest)) dest = path.join(parentDir, `${repoName}-${i++}`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Routinel: cloning ${repoName}…`, cancellable: true }, (progress, token) =>
      runGit(['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), url, dest], parentDir, token, (line) => progress.report({ message: line.slice(0, 80) }))
    );
    const p = await this.addFolder(dest, repoName);
    p.git = { ...(p.git || {}), url: url.replace(/\/\/[^@/]+@/, '//'), cloned: true };
    await this.save();
    return p;
  }

  // ---------------------------------------------------------------- scan
  config() {
    const c = vscode.workspace.getConfiguration('routinel');
    return {
      exclude: [...DEFAULT_EXCLUDES, ...(c.get('scan.excludeFolders') || [])],
      maxFiles: c.get('scan.maxFiles') || 20000,
      maxFileSizeKB: c.get('scan.maxFileSizeKB') || 768,
      includeTests: !!c.get('scan.includeTests'),
    };
  }

  async listFiles(root, cfg) {
    const out = [];
    const walk = async (dir) => {
      if (out.length >= cfg.maxFiles) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const ent of entries) {
        if (out.length >= cfg.maxFiles) return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (cfg.exclude.includes(ent.name) || ent.name.startsWith('.git')) continue;
          await walk(p);
        } else if (ent.isFile() && EXT.test(ent.name)) {
          const norm = p.replace(/\\/g, '/');
          if (SKIP_FILE.test(norm)) continue;
          if (!cfg.includeTests && TEST_FILE.test(norm)) continue;
          out.push(p);
        }
      }
    };
    await walk(root);
    return out;
  }

  async rescan(id) {
    const p = this.get(id);
    if (!p || this.scanning.has(id)) return;
    this.scanning.add(id);
    this._onDidChange.fire();
    const started = Date.now();
    try {
      if (!fs.existsSync(p.root)) throw new Error('Folder no longer exists: ' + p.root);
      const cfg = this.config();
      const files = await this.listFiles(p.root, cfg);
      const fileSet = new Set(files);
      const analyses = [];
      for (let i = 0; i < files.length; i += 64) {
        await Promise.all(files.slice(i, i + 64).map(async (f) => {
          try {
            const st = await fsp.stat(f);
            if (st.size > cfg.maxFileSizeKB * 1024) return;
            analyses.push(scanner.analyzeFile(f, await fsp.readFile(f, 'utf8'), { fileSet }));
          } catch (e) { /* unreadable */ }
        }));
      }
      const res = scanner.resolve(analyses);
      p.endpoints = res.endpoints;
      p.hints = res.hints;
      p.lastScan = { at: Date.now(), files: files.length, ms: Date.now() - started };
      p.error = null;
      p.git = (await gitInfo(p.root)) || p.git;
      this._log(`Project "${p.name}": scanned ${files.length} files in ${p.lastScan.ms} ms → ${p.endpoints.length} endpoints`);
    } catch (e) {
      p.error = e.message || String(e);
      this._log(`Project "${p.name}": ${p.error}`);
    } finally {
      this.scanning.delete(id);
      this._reindex();
      await this.save();
      this._onDidChange.fire();
    }
  }

  async rescanAll() {
    for (const p of this.projects) await this.rescan(p.id);
  }

  async pull(id) {
    const p = this.get(id);
    if (!p) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Routinel: git pull ${p.name}…`, cancellable: true }, (progress, token) =>
      runGit(['pull', '--ff-only'], p.root, token, (line) => progress.report({ message: line.slice(0, 80) }))
    );
    await this.rescan(id);
  }

  async rename(id, name) {
    const p = this.get(id);
    if (!p) return;
    p.name = name;
    await this.save();
    this._onDidChange.fire();
  }

  async remove(id) {
    const w = this.watchers.get(id);
    if (w) w.dispose();
    this.watchers.delete(id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this._reindex();
    await this.save();
    this._onDidChange.fire();
  }

  _watch(p) {
    if (this.watchers.has(p.id)) return;
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(p.root), '**/*.{js,jsx,mjs,cjs,ts,tsx,py,java,kt,cs,go,php,rb,rs,json,yaml,yml,properties}'));
      let timer = null;
      const kick = (uri) => {
        if (/[\\/](node_modules|\.git|dist|build|target|bin|obj)[\\/]/.test(uri.fsPath)) return;
        if (!vscode.workspace.getConfiguration('routinel').get('scan.autoRescan', true)) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.rescan(p.id), 1500);
      };
      watcher.onDidChange(kick);
      watcher.onDidCreate(kick);
      watcher.onDidDelete(kick);
      this.watchers.set(p.id, watcher);
      this.context.subscriptions.push(watcher);
    } catch (e) {
      // watching folders outside the workspace may be unsupported on some hosts — manual rescan still works
    }
  }
}

function runGit(args, cwd, token, onLine) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    } catch (e) {
      reject(new Error('Git is not installed or not on PATH'));
      return;
    }
    let err = '';
    const onData = (d) => {
      const s = d.toString();
      err += s;
      const last = s.split(/[\r\n]+/).filter(Boolean).pop();
      if (last && onLine) onLine(last);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    if (token) token.onCancellationRequested(() => child.kill());
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'Git is not installed or not on PATH' : e.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        let msg = err.trim().split('\n').slice(-3).join(' ');
        if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(err)) msg += ' — sign in once with git in a terminal (or use a URL with an access token / SSH key), then try again.';
        reject(new Error(`git ${args[0]} failed: ${msg}`));
      }
    });
  });
}

async function gitInfo(root) {
  try {
    const head = (await fsp.readFile(path.join(root, '.git', 'HEAD'), 'utf8')).trim();
    const branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 8);
    let url;
    try {
      const cfg = await fsp.readFile(path.join(root, '.git', 'config'), 'utf8');
      const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
      if (m) url = m[1].replace(/\/\/[^@/]+@/, '//'); // never keep embedded credentials
    } catch (e) { /* no config */ }
    return { branch, url };
  } catch (e) {
    return null;
  }
}

module.exports = { ProjectService };

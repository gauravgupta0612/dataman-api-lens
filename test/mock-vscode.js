'use strict';
/* Minimal VS Code API mock — enough to run activate() and drive the extension headlessly in tests. */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const state = { commands: new Map(), panels: [], treeViews: {}, config: {}, root: null, messages: [], quickPickAnswers: [], inputAnswers: [] };

class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose: () => {} }; }; }
  fire(e) { for (const l of this.listeners) l(e); }
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; this.path = fsPath; }
  static file(p) { return new Uri(p); }
  static parse(s) { return new Uri(s.replace(/^file:\/\//, '')); }
  static joinPath(u, ...parts) { return new Uri(path.join(u.fsPath, ...parts)); }
  toString() { return 'file://' + this.fsPath; }
}
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
ThemeIcon.File = new ThemeIcon('file');
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { constructor(v) { this.value = v || ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s) { this.value += '\n```\n' + s + '\n```\n'; return this; } }
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }

const SKIP = /^(node_modules|\.git|dist|build|target|bin|obj|venv|\.venv|__pycache__|\.routinel)$/;
function walk(dir, acc) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { if (!SKIP.test(f)) walk(p, acc); } else acc.push(p);
  }
  return acc;
}

function makeWebviewPanel(viewType, title) {
  const recv = new EventEmitter();
  const dispose = new EventEmitter();
  const panel = {
    viewType,
    title,
    viewColumn: 1,
    posted: [],
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u) => u,
      postMessage: (m) => { panel.posted.push(m); if (panel.onPost) panel.onPost(m); return Promise.resolve(true); },
      onDidReceiveMessage: recv.event,
    },
    reveal() {},
    onDidDispose: dispose.event,
    dispose() { dispose.fire(); },
    receive: (m) => Promise.all(recv.listeners.map((l) => l(m))),
  };
  state.panels.push(panel);
  return panel;
}

const vscode = {
  EventEmitter, Uri, RelativePattern, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Range, Position, CodeLens,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    get workspaceFolders() { return state.root ? [{ uri: Uri.file(state.root), name: path.basename(state.root), index: 0 }] : undefined; },
    async findFiles(include) {
      if (!state.root) return [];
      const exts = /\{([^}]*)\}/.exec(include);
      const list = walk(state.root, []);
      if (include === '**/.env') return list.filter((f) => path.basename(f) === '.env').map(Uri.file);
      const allowed = exts ? exts[1].split(',') : [];
      return list.filter((f) => allowed.includes(path.extname(f).slice(1))).map(Uri.file);
    },
    fs: {
      readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
      writeFile: async (u, b) => { fs.mkdirSync(path.dirname(u.fsPath), { recursive: true }); fs.writeFileSync(u.fsPath, Buffer.from(b)); },
      createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
      stat: async (u) => fs.statSync(u.fsPath),
    },
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    asRelativePath: (p) => path.relative(state.root, typeof p === 'string' ? p : p.fsPath).replace(/\\/g, '/'),
    openTextDocument: async (arg) => ({ uri: arg, lineCount: 1000, getText: () => (arg && arg.content) || '' }),
  },
  window: {
    createOutputChannel: () => ({ appendLine: (s) => state.messages.push(s), show() {}, dispose() {} }),
    createTreeView: (id, opts) => { state.treeViews[id] = opts.treeDataProvider; return { dispose() {}, description: '', badge: undefined }; },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
    withProgress: async (o, fn) => fn({ report() {} }, { onCancellationRequested() {} }),
    createWebviewPanel: makeWebviewPanel,
    showQuickPick: async (items) => { const a = state.quickPickAnswers.shift(); return typeof a === 'function' ? a(items) : a; },
    showInputBox: async () => state.inputAnswers.shift(),
    showInformationMessage: async (m) => { state.messages.push('INFO ' + m); },
    showWarningMessage: async (m) => { state.messages.push('WARN ' + m); return state.quickPickAnswers.shift(); },
    showErrorMessage: async (m) => { state.messages.push('ERROR ' + m); },
    setStatusBarMessage: (m) => state.messages.push('SB ' + m),
    showTextDocument: async () => ({}),
    showSaveDialog: async () => state.saveTo && Uri.file(state.saveTo),
    showOpenDialog: async () => state.openFrom && [Uri.file(state.openFrom)],
  },
  commands: {
    registerCommand: (id, fn) => { state.commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (id, ...args) => (state.commands.has(id) ? state.commands.get(id)(...args) : undefined),
  },
  languages: { registerCodeLensProvider: (sel, p) => { state.codeLens = p; return { dispose() {} }; } },
  env: { clipboard: { text: '', writeText: async (t) => { vscode.env.clipboard.text = t; } } },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-mock';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-mock'] = { id: 'vscode-mock', filename: 'vscode-mock', loaded: true, exports: vscode };

function makeContext(extPath, storage) {
  const mem = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => m.set(k, v), keys: () => [...m.keys()] }; };
  const secrets = new Map();
  return {
    subscriptions: [],
    extensionUri: Uri.file(extPath),
    extensionPath: extPath,
    globalStorageUri: Uri.file(storage),
    workspaceState: mem(),
    globalState: mem(),
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
  };
}

module.exports = { vscode, state, makeContext };

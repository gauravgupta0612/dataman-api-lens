'use strict';
/** Sidebar tree views: Discovered APIs, Collections, History — plus the CodeLens provider. */
const vscode = require('vscode');
const path = require('path');

const METHOD_COLORS = {
  GET: 'charts.green',
  POST: 'charts.yellow',
  PUT: 'charts.blue',
  PATCH: 'charts.purple',
  DELETE: 'charts.red',
  HEAD: 'charts.orange',
  OPTIONS: 'descriptionForeground',
};

function methodIcon(method) {
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(METHOD_COLORS[method] || 'descriptionForeground'));
}

function methodLabel(method, text) {
  const label = `${method} ${text}`;
  return { label, highlights: [[0, method.length]] };
}

// ------------------------------------------------------------------ Discovered APIs
class ApiTreeProvider {
  constructor(service, context, projects) {
    this.service = service;
    this.projects = projects;
    this.context = context;
    this.filter = '';
    this.groupBy = context.workspaceState.get('routinel.groupBy') || vscode.workspace.getConfiguration('routinel').get('groupBy') || 'file';
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    service.onDidChange(() => this.refresh());
    if (projects) projects.onDidChange(() => this.refresh());
  }

  hasProjects() {
    return !!(this.projects && this.projects.projects.length);
  }

  sources() {
    const res = [];
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws.length && vscode.workspace.getConfiguration('routinel').get('scan.workspace', true) !== false) {
      res.push({ kind: 'source', id: 'ws', name: ws.length > 1 ? 'Workspace' : ws[0].name, endpoints: this.service.endpoints, isWorkspace: true });
    }
    for (const p of this.projects ? this.projects.projects : []) res.push({ kind: 'source', id: p.id, name: p.name, endpoints: p.endpoints || [], project: p });
    return res;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  setFilter(text) {
    this.filter = (text || '').trim();
    vscode.commands.executeCommand('setContext', 'routinel.filtered', !!this.filter);
    this.refresh();
  }

  async setGroupBy(g) {
    this.groupBy = g;
    await this.context.workspaceState.update('routinel.groupBy', g);
    this.refresh();
  }

  visible(list) {
    if (!list) list = this.sources().flatMap((s) => s.endpoints);
    const f = this.filter.toLowerCase();
    if (!f) return list;
    const terms = f.split(/\s+/).filter(Boolean);
    return list.filter((e) => {
      const hay = `${e.method} ${e.path} ${e.framework} ${e.language} ${this.service.relative(e.file)} ${e.handler || ''} ${e.summary || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  groupKey(e) {
    switch (this.groupBy) {
      case 'framework':
        return e.framework;
      case 'language':
        return e.language;
      case 'resource': {
        const segs = e.path.split('/').filter((s) => s && !s.startsWith(':') && !/^(api|v\d+(\.\d+)?|rest|public|internal)$/i.test(s));
        return '/' + (segs[0] || '');
      }
      case 'method':
        return e.method;
      case 'none':
        return null;
      default:
        return e.file;
    }
  }

  groupsOf(list, sourceId) {
    if (this.groupBy === 'none') return list.map((e) => ({ kind: 'endpoint', endpoint: e, sourceId }));
    const groups = new Map();
    for (const e of list) {
      const k = this.groupKey(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const keys = [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)));
    return keys.map((k) => ({ kind: 'group', key: k, items: groups.get(k), many: keys.length > 12, sourceId }));
  }

  getChildren(element) {
    if (!element) {
      if (!this.hasProjects()) {
        const list = this.visible(this.service.endpoints);
        return list.length ? this.groupsOf(list, 'ws') : [];
      }
      // one node per source: the open workspace + every project you added
      return this.sources().filter((s) => !this.filter || this.visible(s.endpoints).length);
    }
    if (element.kind === 'source') return this.groupsOf(this.visible(element.endpoints), element.id);
    if (element.kind === 'group') return element.items.map((e) => ({ kind: 'endpoint', endpoint: e, sourceId: element.sourceId }));
    return [];
  }

  getTreeItem(el) {
    if (el.kind === 'source') {
      const p = el.project;
      const scanning = p ? this.projects.scanning.has(p.id) : this.service.scanning;
      const n = this.visible(el.endpoints).length;
      const item = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'src:' + el.id + (this.filter ? ':f' : '');
      item.contextValue = p ? (p.git && p.git.branch ? 'project-git' : 'project') : 'workspaceSource';
      item.iconPath = new vscode.ThemeIcon(scanning ? 'sync~spin' : p ? (p.error ? 'warning' : p.git ? 'repo' : 'folder-library') : 'root-folder');
      item.description = scanning ? 'scanning…' : p && p.error ? 'error — ' + p.error : `${n} API${n === 1 ? '' : 's'}${p && p.git && p.git.branch ? ' · ' + p.git.branch : ''}${p ? '' : ' · open workspace'}`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${el.name}**${p ? '' : ' (open workspace)'}\n\n`);
      if (p) {
        md.appendMarkdown(`Folder: \`${p.root}\`\n\n`);
        if (p.git && p.git.url) md.appendMarkdown(`Repo: ${p.git.url}${p.git.branch ? ' (' + p.git.branch + ')' : ''}\n\n`);
        if (p.lastScan) md.appendMarkdown(`Last scan: ${new Date(p.lastScan.at).toLocaleString()} — ${p.lastScan.files} files, ${p.lastScan.ms} ms\n`);
      }
      item.tooltip = md;
      return item;
    }
    if (el.kind === 'group') {
      const isFile = this.groupBy === 'file';
      const label = isFile ? path.basename(el.key) : String(el.key);
      const item = new vscode.TreeItem(label, this.filter || !el.many ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = (isFile ? path.dirname(this.service.relative(el.key)).replace(/^\.$/, '') + '  ' : '') + `${el.items.length}`;
      item.contextValue = isFile ? 'apiFileGroup' : 'apiGroup';
      if (isFile) {
        item.resourceUri = vscode.Uri.file(el.key);
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = this.service.relative(el.key);
      } else item.iconPath = new vscode.ThemeIcon(this.groupBy === 'framework' ? 'symbol-namespace' : this.groupBy === 'language' ? 'code' : this.groupBy === 'method' ? 'symbol-event' : 'symbol-folder');
      item.id = 'g:' + (el.sourceId || '') + ':' + this.groupBy + ':' + el.key + ':' + (this.filter ? 'f' : '');
      return item;
    }
    const e = el.endpoint;
    const item = new vscode.TreeItem(methodLabel(e.method, e.path), vscode.TreeItemCollapsibleState.None);
    item.id = 'e:' + (el.sourceId || '') + ':' + e.id + (this.filter ? ':f' : '');
    item.iconPath = methodIcon(e.method);
    item.description = this.groupBy === 'framework' ? path.basename(e.file) : e.handler ? `${e.framework} · ${e.handler}` : e.framework;
    item.contextValue = 'endpoint';
    item.command = { command: 'routinel.openEndpoint', title: 'Open Request', arguments: [e.id] };
    item.tooltip = endpointTooltip(e, this.service.relative(e.file));
    return item;
  }
}

function endpointTooltip(e, rel) {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${e.method}** \`${e.path}\`\n\n`);
  md.appendMarkdown(`$(symbol-namespace) ${e.framework} · $(file-code) ${rel}:${e.line + 1}${e.handler ? ' · `' + e.handler + '`' : ''}\n\n`);
  if (e.summary) md.appendMarkdown(e.summary + '\n\n');
  if (e.params.length) {
    md.appendMarkdown('| in | name | type | req |\n|---|---|---|---|\n');
    for (const p of e.params) md.appendMarkdown(`| ${p.in} | \`${p.name}\` | ${String(p.type || '').replace(/\|/g, '\\|')} | ${p.required ? '✓' : ''} |\n`);
  }
  if (e.body && e.body.mode !== 'none') {
    md.appendMarkdown(`\nBody: **${e.body.mode}**\n`);
    if (e.body.example !== undefined) md.appendCodeblock(JSON.stringify(e.body.example, null, 2).slice(0, 600), 'json');
  }
  return md;
}

// ------------------------------------------------------------------ Collections
class CollectionTreeProvider {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onDidChange((what) => {
      if (what === 'collections') this.refresh();
    });
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(el) {
    if (!el) {
      const data = await this.store.getCollections();
      return data.collections.map((c) => ({ kind: 'collection', node: c, collectionId: c.id }));
    }
    return (el.node.items || []).map((it) => ({ kind: it.type === 'folder' ? 'folder' : 'request', node: it, collectionId: el.collectionId }));
  }

  getTreeItem(el) {
    const n = el.node;
    if (el.kind === 'request') {
      const req = n.request || {};
      const item = new vscode.TreeItem(methodLabel(req.method || 'GET', n.name), vscode.TreeItemCollapsibleState.None);
      item.id = 'c:' + n.id;
      item.iconPath = methodIcon(req.method || 'GET');
      item.description = (req.url || '').replace(/^\{\{baseUrl\}\}/, '');
      item.contextValue = 'collectionRequest';
      item.command = { command: 'routinel.openCollectionItem', title: 'Open', arguments: [n.id] };
      item.tooltip = `${req.method} ${req.url}`;
      return item;
    }
    const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'c:' + n.id;
    item.iconPath = new vscode.ThemeIcon(el.kind === 'collection' ? 'library' : 'folder');
    item.contextValue = el.kind === 'collection' ? 'collection' : 'collectionFolder';
    item.description = `${countRequests(n)}`;
    return item;
  }
}

function countRequests(n) {
  return (n.items || []).reduce((acc, it) => acc + (it.type === 'folder' ? countRequests(it) : 1), 0);
}

// ------------------------------------------------------------------ History
class HistoryTreeProvider {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onDidChange((what) => {
      if (what === 'history') this.refresh();
    });
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getChildren(el) {
    if (el) return [];
    return this.store.getHistory();
  }

  getTreeItem(h) {
    const url = (h.resolvedUrl || h.request.url || '').replace(/^https?:\/\/[^/]+/, '');
    const item = new vscode.TreeItem(methodLabel(h.request.method, url || '/'), vscode.TreeItemCollapsibleState.None);
    item.id = 'h:' + h.id;
    const ok = h.status && h.status < 400;
    item.iconPath = new vscode.ThemeIcon(h.error ? 'error' : ok ? 'pass' : 'warning', new vscode.ThemeColor(h.error ? 'charts.red' : ok ? 'charts.green' : 'charts.orange'));
    item.description = `${h.error ? 'ERR' : h.status} · ${h.timeMs ?? '?'} ms · ${ago(h.at)}`;
    item.tooltip = `${h.request.method} ${h.resolvedUrl || h.request.url}\n${h.error || h.status + ' ' + (h.statusText || '')}\n${new Date(h.at).toLocaleString()}`;
    item.contextValue = 'historyItem';
    item.command = { command: 'routinel.openHistoryItem', title: 'Open', arguments: [h.id] };
    return item;
  }
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ------------------------------------------------------------------ CodeLens
class EndpointCodeLensProvider {
  constructor(service) {
    this.service = service;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
    service.onDidChange(() => this._onDidChange.fire());
  }

  provideCodeLenses(doc) {
    if (!vscode.workspace.getConfiguration('routinel').get('codeLens.enabled', true)) return [];
    const lenses = [];
    const seen = new Map();
    for (const e of this.service.forFile(doc.uri.fsPath)) {
      if (e.line >= doc.lineCount) continue;
      const range = new vscode.Range(e.line, 0, e.line, 0);
      const n = seen.get(e.line) || 0;
      seen.set(e.line, n + 1);
      if (n >= 4) continue;
      lenses.push(new vscode.CodeLens(range, { title: `$(play) ${e.method} ${e.path}`, command: 'routinel.openEndpoint', arguments: [e.id], tooltip: 'Open in Routinel' }));
      if (n === 0) lenses.push(new vscode.CodeLens(range, { title: '$(terminal) cURL', command: 'routinel.copyCurl', arguments: [e.id], tooltip: 'Copy as cURL' }));
    }
    return lenses;
  }
}

module.exports = { ApiTreeProvider, CollectionTreeProvider, HistoryTreeProvider, EndpointCodeLensProvider, methodIcon };

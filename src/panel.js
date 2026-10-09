'use strict';
/** Postman-like request editor implemented as a webview panel (one editor tab per request). */
const vscode = require('vscode');
const crypto = require('crypto');
const httpClient = require('./http');
const model = require('./model');

class PanelManager {
  constructor(context, service, store) {
    this.context = context;
    this.service = service;
    this.store = store;
    this.panels = new Map();
    store.onDidChange((what) => {
      if (what === 'environments') for (const p of this.panels.values()) p.postEnv();
    });
  }

  /** origin: { kind: 'endpoint'|'collection'|'history'|'new', id } */
  open(key, request, origin, options = {}) {
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn || vscode.ViewColumn.Active, false);
      if (options.autoSend) existing.post({ type: 'triggerSend' });
      return existing;
    }
    const p = new RequestPanel(this, key, request, origin, options);
    this.panels.set(key, p);
    return p;
  }

  rekey(oldKey, newKey) {
    const p = this.panels.get(oldKey);
    if (!p) return;
    this.panels.delete(oldKey);
    p.key = newKey;
    this.panels.set(newKey, p);
  }
}

class RequestPanel {
  constructor(manager, key, request, origin, options) {
    this.manager = manager;
    this.key = key;
    this.request = request;
    this.origin = origin;
    this.options = options || {};
    this.abort = null;
    const media = vscode.Uri.joinPath(manager.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('routinel.request', titleOf(request), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'request-light.svg'), dark: vscode.Uri.joinPath(media, 'request-dark.svg') };
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => {
      if (this.abort) this.abort.abort();
      manager.panels.delete(this.key);
    });
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg).catch((e) => this.post({ type: 'toast', level: 'error', text: String(e && e.message ? e.message : e) })));
  }

  post(msg) {
    return this.panel.webview.postMessage(msg);
  }

  async envPayload() {
    const { vars, activeName, names, secretNames, authSummary } = await this.manager.store.getVariables();
    const shown = {};
    for (const [k, v] of Object.entries(vars)) shown[k] = secretNames.includes(k) ? '••••••' : v;
    return { names, active: activeName, vars: shown, auth: authSummary };
  }

  async postEnv() {
    this.post({ type: 'env', env: await this.envPayload() });
  }

  endpointMeta() {
    if (!this.request.source || !this.request.source.endpointId) return null;
    const ep = this.manager.service.get(this.request.source.endpointId);
    const src = this.request.source;
    return {
      framework: (ep && ep.framework) || src.framework,
      file: src.file ? vscode.workspace.asRelativePath(src.file) : '',
      line: (ep ? ep.line : src.line) + 1,
      handler: ep && ep.handler,
      language: ep && ep.language,
      summary: ep && ep.summary,
      params: ep ? ep.params : [],
      body: ep ? ep.body : null,
      path: ep ? ep.path : '',
      method: ep ? ep.method : '',
      stale: !ep,
    };
  }

  async onMessage(msg) {
    const store = this.manager.store;
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          request: this.request,
          origin: this.origin,
          meta: this.endpointMeta(),
          env: await this.envPayload(),
          settings: { wrap: vscode.workspace.getConfiguration('routinel').get('response.wordWrap', true) },
          response: this.options.response || null,
        });
        if (this.options.autoSend) this.post({ type: 'triggerSend' });
        break;
      case 'changed':
        this.request = msg.request;
        this.panel.title = titleOf(msg.request);
        break;
      case 'send':
        await this.send(msg.request);
        break;
      case 'cancel':
        if (this.abort) this.abort.abort();
        break;
      case 'save':
        await this.save(msg.request, false);
        break;
      case 'saveAs':
        await this.save(msg.request, true);
        break;
      case 'codegen': {
        const { vars, auth } = await store.getVariables();
        let code;
        try {
          code = model.generate(msg.lang, httpClient.prepare(msg.request, vars, auth), msg.request, vars, httpClient.resolveVars);
        } catch (e) {
          code = '// ' + e.message;
        }
        this.post({ type: 'code', lang: msg.lang, code });
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text || '');
        vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
        break;
      case 'openSource':
        await openSource(this.request.source, this.manager.service);
        break;
      case 'pickFile': {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach' });
        if (uris && uris[0]) this.post({ type: 'filePicked', index: msg.index, path: uris[0].fsPath });
        break;
      }
      case 'selectEnv':
        await store.setActiveEnvironment(msg.name);
        break;
      case 'editEnvs':
        await vscode.commands.executeCommand('routinel.editEnvironments', msg.focus);
        break;
      case 'setVar':
        await store.setVariable(msg.name, msg.value);
        vscode.window.setStatusBarMessage(`$(check) {{${msg.name}}} updated in the active environment`, 3000);
        break;
      case 'regenerate': {
        const ep = this.request.source && this.manager.service.get(this.request.source.endpointId);
        if (!ep) {
          vscode.window.showWarningMessage('The source endpoint is no longer detected — rescan the workspace.');
          break;
        }
        const fresh = model.endpointToRequest(ep);
        fresh.id = this.request.id;
        this.request = fresh;
        this.post({ type: 'replace', request: fresh, meta: this.endpointMeta() });
        break;
      }
      case 'openInEditor': {
        const doc = await vscode.workspace.openTextDocument({ content: msg.content || '', language: msg.language || 'plaintext' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        break;
      }
      case 'saveResponse': {
        const uri = await vscode.window.showSaveDialog({ saveLabel: 'Save response', defaultUri: msg.suggestedName ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : vscode.Uri.file(require('os').homedir()), msg.suggestedName) : undefined });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, msg.isBinary ? Buffer.from(msg.body, 'base64') : Buffer.from(msg.body || '', 'utf8'));
          vscode.window.setStatusBarMessage('$(check) Response saved', 2500);
        }
        break;
      }
      default:
        break;
    }
  }

  async send(request) {
    this.request = request;
    const store = this.manager.store;
    const cfg = vscode.workspace.getConfiguration('routinel');
    const { vars, auth } = await store.getVariables();
    const missing = [...new Set([request.url, ...(request.headers || []).map((h) => h.value), ...(request.params || []).map((p) => p.value), ...(request.pathVars || []).map((p) => p.value)].flatMap((s) => httpClient.unresolvedVars(s, vars)))];
    let prepared;
    try {
      prepared = httpClient.prepare(request, vars, auth);
    } catch (e) {
      this.post({ type: 'requestError', message: e.message, timeMs: 0 });
      return;
    }
    if (this.abort) this.abort.abort();
    this.abort = new AbortController();
    this.post({ type: 'sending', url: prepared.url, warnings: missing.length ? [`Unresolved variable(s): ${missing.map((m) => '{{' + m + '}}').join(', ')} — define them in the environment.`] : [] });
    const started = Date.now();
    try {
      const res = await httpClient.execute(prepared, {
        timeoutMs: cfg.get('http.timeoutMs', 30000),
        rejectUnauthorized: cfg.get('http.rejectUnauthorized', true),
        followRedirects: cfg.get('http.followRedirects', true),
        useCookieJar: cfg.get('http.cookieJar', true),
        signal: this.abort.signal,
      });
      res.requestHeaders = prepared.headers;
      res.method = prepared.method;
      this.post({ type: 'response', response: res });
      await store.addHistory({
        request: stripForHistory(request),
        resolvedUrl: prepared.url,
        status: res.status,
        statusText: res.statusText,
        timeMs: res.timeMs,
        size: res.size,
        response: { status: res.status, statusText: res.statusText, headers: res.headers, contentType: res.contentType, isBinary: res.isBinary, body: res.body.length > 65536 ? res.body.slice(0, 65536) : res.body, truncated: res.body.length > 65536 || res.truncated, size: res.size, timeMs: res.timeMs, url: res.url },
        source: request.source,
      });
    } catch (e) {
      const timeMs = Date.now() - started;
      this.post({ type: 'requestError', message: e.message || String(e), code: e.code, timeMs });
      if (!/cancelled/i.test(e.message || '')) await store.addHistory({ request: stripForHistory(request), resolvedUrl: prepared.url, error: e.message || String(e), timeMs, source: request.source });
    } finally {
      this.abort = null;
    }
  }

  async save(request, forceNew) {
    const store = this.manager.store;
    if (!forceNew && this.origin && this.origin.kind === 'collection') {
      const ok = await store.updateRequest(this.origin.id, request);
      if (ok) {
        this.post({ type: 'saved' });
        vscode.window.setStatusBarMessage('$(check) Request saved', 2000);
        return;
      }
    }
    const data = await store.getCollections();
    const picks = data.collections.map((c) => ({ label: '$(library) ' + c.name, id: c.id }));
    picks.push({ label: '$(add) New collection…', id: '__new__' });
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Save request to collection' });
    if (!pick) return;
    let collectionId = pick.id;
    if (collectionId === '__new__') {
      const name = await vscode.window.showInputBox({ prompt: 'Collection name', value: defaultCollectionName() });
      if (!name) return;
      collectionId = (await store.createCollection(name)).id;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Request name', value: request.name || titleOf(request) });
    if (!name) return;
    const item = await store.saveRequestToCollection(collectionId, name, request);
    this.origin = { kind: 'collection', id: item.id };
    this.manager.rekey(this.key, 'col:' + item.id);
    this.post({ type: 'saved', origin: this.origin, name });
    vscode.window.setStatusBarMessage(`$(check) Saved to collection`, 2000);
  }

  html(media) {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Routinel Request</title>
</head>
<body>
<div id="app" class="loading">Loading…</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function stripForHistory(req) {
  const copy = JSON.parse(JSON.stringify(req));
  // never keep secrets typed directly into auth fields in history
  if (copy.auth && copy.auth.type !== 'none') {
    for (const k of ['token', 'password', 'value']) if (copy.auth[k] && !/^\{\{.*\}\}$/.test(copy.auth[k])) copy.auth[k] = '';
  }
  return copy;
}

function titleOf(req) {
  const name = req.name && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(req.name) ? req.name : String(req.url || '').replace(/^\{\{baseUrl\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || '/';
  return `${req.method} ${name}`.slice(0, 60);
}

function defaultCollectionName() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].name : 'My Collection';
}

async function openSource(source, service) {
  if (!source || !source.file) return;
  const ep = source.endpointId ? service.get(source.endpointId) : null;
  const line = ep ? ep.line : source.line || 0;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ep ? ep.file : source.file));
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
}

module.exports = { PanelManager, openSource, titleOf };

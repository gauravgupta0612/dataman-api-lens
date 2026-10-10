'use strict';
/** Shows the generated API documentation in a webview, with Try it / Source / Save HTML / Save Markdown. */
const vscode = require('vscode');
const crypto = require('crypto');
const docs = require('./docs');

class DocsPanel {
  /** getSources(): [{ name, endpoints, root }]  — re-evaluated on refresh */
  static show(ctx, key, title, getSources) {
    const existing = DocsPanel.panels.get(key);
    if (existing) {
      existing.render();
      existing.panel.reveal();
      return existing;
    }
    const p = new DocsPanel(ctx, key, title, getSources);
    DocsPanel.panels.set(key, p);
    return p;
  }

  constructor(ctx, key, title, getSources) {
    this.ctx = ctx; // { store, service, openEndpoint(id), goToSource(id), baseUrl(): Promise<string> }
    this.key = key;
    this.title = title;
    this.getSources = getSources;
    this.panel = vscode.window.createWebviewPanel('routinel.docs', 'API Docs: ' + title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
    this.panel.onDidDispose(() => DocsPanel.panels.delete(key));
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage('Routinel: ' + e.message)));
    this.render();
  }

  async options(forFile) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return {
      title: this.title + ' — API Documentation',
      baseUrl: await this.ctx.baseUrl(),
      mocks: await this.ctx.store.getMocks(),
      roots: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      vscode: !forFile,
      nonce: forFile ? undefined : nonce,
      cspSource: forFile ? undefined : this.panel.webview.cspSource,
    };
  }

  async render() {
    this.panel.webview.html = docs.renderHtml(this.getSources(), await this.options(false));
  }

  async onMessage(m) {
    switch (m.type) {
      case 'open':
        return this.ctx.openEndpoint(m.id);
      case 'source':
        return this.ctx.goToSource(m.id);
      case 'copy':
        await vscode.env.clipboard.writeText(m.text || '');
        return vscode.window.setStatusBarMessage('$(check) Copied', 1500);
      case 'refresh':
        return this.render();
      case 'exportHtml':
      case 'exportMd': {
        const md = m.type === 'exportMd';
        const name = this.title.replace(/[^\w.-]+/g, '_') + (md ? '-api.md' : '-api.html');
        const ws = vscode.workspace.workspaceFolders;
        const uri = await vscode.window.showSaveDialog({ defaultUri: ws && ws.length ? vscode.Uri.joinPath(ws[0].uri, name) : undefined, filters: md ? { Markdown: ['md'] } : { HTML: ['html'] } });
        if (!uri) return;
        const opts = await this.options(true);
        const text = md ? docs.renderMarkdown(this.getSources(), opts) : docs.renderHtml(this.getSources(), opts);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        const open = await vscode.window.showInformationMessage(`Routinel: documentation saved to ${uri.fsPath.split(/[\\/]/).pop()}`, md ? 'Open' : 'Open in browser');
        if (open) md ? vscode.window.showTextDocument(uri) : vscode.env.openExternal(uri);
        return;
      }
      default:
        return;
    }
  }
}
DocsPanel.panels = new Map();

module.exports = { DocsPanel };

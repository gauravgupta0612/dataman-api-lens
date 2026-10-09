'use strict';
/** Environment manager: a form-based editor for environments, variables and default authentication. */
const vscode = require('vscode');
const crypto = require('crypto');

class EnvPanel {
  static show(context, store, focus) {
    if (EnvPanel.current) {
      EnvPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (focus) EnvPanel.current.panel.webview.postMessage({ type: 'focus', focus });
      return EnvPanel.current;
    }
    EnvPanel.current = new EnvPanel(context, store, focus);
    return EnvPanel.current;
  }

  constructor(context, store, focus) {
    this.store = store;
    this.focus = focus;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('routinel.environments', 'Routinel: Environments', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'request-light.svg'), dark: vscode.Uri.joinPath(media, 'request-dark.svg') };
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'env.js'));
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Environments</title></head>
<body><div id="app" class="loading">Loading…</div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    this.panel.onDidDispose(() => { EnvPanel.current = null; });
    webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => webview.postMessage({ type: 'error', text: e.message || String(e) })));
    this.sub = store.onDidChange((what) => { if (what === 'environments' && !this.saving) this.post({ type: 'externalChange' }); });
    this.panel.onDidDispose(() => this.sub && this.sub.dispose && this.sub.dispose());
  }

  post(m) {
    return this.panel.webview.postMessage(m);
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
      case 'reload':
        this.post({ type: 'init', data: await this.store.getEnvironmentDetails(), focus: this.focus });
        this.focus = null;
        break;
      case 'save':
        this.saving = true;
        try {
          await this.store.saveEnvironmentDetails(m.data);
        } finally {
          this.saving = false;
        }
        this.post({ type: 'saved', data: await this.store.getEnvironmentDetails() });
        vscode.window.setStatusBarMessage('$(check) Routinel environments saved', 2500);
        break;
      case 'openJson': {
        const doc = await vscode.workspace.openTextDocument(this.store.fileUri('environments.json'));
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        break;
      }
      case 'confirmDelete': {
        const ok = await vscode.window.showWarningMessage(`Delete environment "${m.name}"? (takes effect when you click Save)`, { modal: true }, 'Delete');
        this.post({ type: 'deleteConfirmed', index: m.index, ok: ok === 'Delete' });
        break;
      }
      default:
        break;
    }
  }
}

module.exports = { EnvPanel };

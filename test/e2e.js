'use strict';
/* Headless end-to-end check: real extension code + mocked VS Code API + real webview UI in Chromium. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { state, makeContext } = require('./mock-vscode');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'test', 'screenshots');

const THEME = `:root{--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-font-family:-apple-system,"Segoe UI",sans-serif;--vscode-font-size:13px;
--vscode-editor-font-family:Consolas,"Courier New",monospace;--vscode-editor-font-size:13px;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;
--vscode-input-border:#3c3c3c;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-panel-border:#3c3c3c;--vscode-descriptionForeground:#9d9d9d;
--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-focusBorder:#007fd4;--vscode-textLink-foreground:#3794ff;--vscode-editorWidget-background:#252526}`;

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'routinel-ws-'));
  fs.cpSync(path.join(__dirname, 'fixtures'), ws, { recursive: true });
  state.root = ws;
  const ctx = makeContext(ROOT, path.join(ws, '.global'));
  const ext = require('../extension');
  const api = ext.activate(ctx);
  for (let i = 0; i < 100 && !api.getEndpoints().length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  const eps = api.getEndpoints();
  console.log('activated, endpoints:', eps.length);
  assert.ok(eps.length > 50);

  // tree view
  const tree = state.treeViews['routinel.apis'];
  const groups = tree.getChildren();
  const children = tree.getChildren(groups[0]);
  const item = tree.getTreeItem(children[0]);
  console.log('tree groups:', groups.length, '| first item:', item.label.label, '|', item.description);
  assert.ok(groups.length > 5 && item.command.command === 'routinel.openEndpoint');

  // codelens
  const lenses = state.codeLens.provideCodeLenses({ uri: { fsPath: path.join(ws, 'spring', 'UserController.java') }, lineCount: 200 });
  console.log('codelenses in UserController.java:', lenses.map((l) => l.command.title).join(' | '));
  assert.ok(lenses.length >= 4);

  // environment pointing to a local echo server
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Powered-By': 'demo' });
      res.end(JSON.stringify({ id: 101, received: body ? JSON.parse(body) : null, path: req.url, auth: req.headers.authorization || null, token: 'eyJhbGciOiJIUzI1NiJ9.demo' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const envFile = path.join(ws, '.routinel', 'environments.json');
  const envs = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  console.log('auto-created environment:', JSON.stringify(envs.environments[0]));
  envs.environments[0].variables.baseUrl = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(envFile, JSON.stringify(envs, null, 2));

  // open the Spring "create user" endpoint in the request editor
  const target = eps.find((e) => e.method === 'POST' && e.path === '/svc/api/v1/users');
  await state.commands.get('routinel.openEndpoint')(target.id);
  const panel = state.panels[state.panels.length - 1];
  console.log('panel title:', panel.title);

  // copy curl command
  await state.commands.get('routinel.copyCurl')(target.id);
  const { vscode } = require('./mock-vscode');
  console.log('cURL:\n' + vscode.env.clipboard.text);

  // ---- real webview UI in Chromium ----
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  await page.exposeFunction('__dmPost', (m) => panel.receive(m));
  panel.onPost = (m) => page.evaluate((msg) => window.postMessage(msg, '*'), m).catch(() => {});
  const css = fs.readFileSync(path.join(ROOT, 'media', 'panel.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
  await page.setContent(`<!DOCTYPE html><html><head><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><div id="app" class="loading">Loading…</div>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__dmPost(m),getState:()=>null,setState:()=>{}});</script><script>${js}</script></body></html>`);
  await page.waitForSelector('#url');
  fs.mkdirSync(OUT, { recursive: true });
  await page.click('text=Headers');
  await page.screenshot({ path: path.join(OUT, '1-request-headers.png') });
  await page.click('button.tab:has-text("Body")');
  await page.click('#sendbtn');
  await page.waitForSelector('.status');
  await page.screenshot({ path: path.join(OUT, '2-response.png') });
  const statusText = await page.textContent('.status');
  console.log('response status in UI:', statusText);
  assert.ok(/201/.test(statusText));
  await page.click('text={{ }} Save to variable');
  await page.waitForSelector('.extract');
  await page.click('.extract button.primary');
  await new Promise((r) => setTimeout(r, 300));
  const env2 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  console.log('token saved to env:', env2.environments[0].variables.token);
  assert.ok(env2.environments[0].variables.token.startsWith('eyJ'));
  await page.click('button.tab:has-text("Code")');
  await page.waitForFunction(() => /curl/.test(document.querySelector('#codeblock').textContent));
  await page.screenshot({ path: path.join(OUT, '3-code.png') });
  await page.click('button.tab:has-text("Endpoint")');
  await page.screenshot({ path: path.join(OUT, '4-endpoint-info.png') });

  // history recorded
  const hist = state.treeViews['routinel.history'].getChildren();
  console.log('history entries:', hist.length, '→', hist[0] && hist[0].resolvedUrl, hist[0] && hist[0].status);
  assert.strictEqual(hist.length, 1);

  // save to a new collection via the panel
  state.quickPickAnswers.push((items) => items.find((i) => i.id === '__new__'));
  state.inputAnswers.push('Demo collection', 'Create user');
  await panel.receive({ type: 'save', request: panel.posted.find((m) => m.type === 'init').request });
  const cols = await state.treeViews['routinel.collections'].getChildren();
  console.log('collections:', cols.map((c) => c.node.name + ' (' + c.node.items.length + ')').join(', '));
  assert.strictEqual(cols.length, 1);

  // export Postman + OpenAPI
  state.saveTo = path.join(ws, 'out.postman_collection.json');
  await state.commands.get('routinel.exportPostman')();
  const pm = JSON.parse(fs.readFileSync(state.saveTo, 'utf8'));
  console.log('postman export folders:', pm.item.length, 'schema:', pm.info.schema.split('/').slice(-2).join('/'));
  state.saveTo = path.join(ws, 'openapi.yaml');
  await state.commands.get('routinel.exportOpenApi')();
  console.log('openapi export bytes:', fs.statSync(state.saveTo).size);
  state.openFrom = path.join(ws, 'out.postman_collection.json');
  await state.commands.get('routinel.importPostman')();
  console.log('collections after import:', (await state.treeViews['routinel.collections'].getChildren()).length);

  // a standalone request (third-party usage like Postman)
  await state.commands.get('routinel.newRequest')();
  const p2 = state.panels[state.panels.length - 1];
  const page2 = await browser.newPage({ viewport: { width: 1180, height: 700 } });
  await page2.exposeFunction('__dmPost', (m) => p2.receive(m));
  p2.onPost = (m) => page2.evaluate((msg) => window.postMessage(msg, '*'), m).catch(() => {});
  await page2.setContent(`<!DOCTYPE html><html><head><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__dmPost(m),getState:()=>null,setState:()=>{}});</script><script>${js}</script></body></html>`);
  await page2.waitForSelector('#url');
  await page2.fill('#url', 'http://127.0.0.1:' + server.address().port + '/anything/:id?search=hello&page=2');
  await page2.press('#url', 'Tab');
  await page2.fill('table.kv:nth-of-type(2) tbody tr:first-child td.val input', '7').catch(() => {});
  await page2.click('#sendbtn');
  await page2.waitForSelector('.status');
  await page2.screenshot({ path: path.join(OUT, '5-standalone.png') });
  const shown = await page2.textContent('#resbody pre');
  console.log('standalone response path:', JSON.parse(shown).path);

  // ---- environment manager: Basic Auth username/password on "Local" ----
  await state.commands.get('routinel.editEnvironments')();
  const envPanel = state.panels[state.panels.length - 1];
  const page3 = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  page3.on('pageerror', (e) => { console.error('PAGE ERROR (env)', e); process.exitCode = 1; });
  await page3.exposeFunction('__dmPost', (m) => envPanel.receive(m));
  envPanel.onPost = (m) => page3.evaluate((msg) => window.postMessage(msg, '*'), m).catch(() => {});
  const envJs = fs.readFileSync(path.join(ROOT, 'media', 'env.js'), 'utf8');
  await page3.setContent(`<!DOCTYPE html><html><head><style>${THEME}</style><style>${css}</style></head><body class="vscode-dark"><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__dmPost(m),getState:()=>null,setState:()=>{}});</script><script>${envJs}</script></body></html>`);
  await page3.waitForSelector('.env-editor select');
  await page3.selectOption('.env-editor select', 'basic');
  await page3.fill('input[placeholder="user"]', 'demo-user');
  await page3.fill('input[type=password]', 's3cret!');
  await page3.fill('tbody tr.ghost td input.mono >> nth=0', 'tenantId');
  await page3.fill('tbody tr:nth-last-child(2) td.val input', 'acme');
  await page3.screenshot({ path: path.join(OUT, '6-environments.png') });
  await page3.click('button:has-text("Save")');
  await new Promise((r) => setTimeout(r, 400));
  const envSaved = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  console.log('environment saved:', JSON.stringify(envSaved.environments[0]));
  assert.strictEqual(envSaved.environments[0].auth.type, 'basic');
  assert.ok(!JSON.stringify(envSaved).includes('s3cret!'), 'password must not be written to the JSON file');
  await page3.screenshot({ path: path.join(OUT, '7-environments-saved.png') });

  // request with "Inherit from environment" auth now sends Basic credentials
  await page.click('button.tab:has-text("Auth")');
  await page.click('#sendbtn');
  await page.waitForFunction(() => /Basic/.test(document.querySelector('#resbody pre') ? document.querySelector('#resbody pre').textContent : ''));
  const authEcho = JSON.parse(await page.textContent('#resbody pre')).auth;
  console.log('inherited auth header:', authEcho, '→', Buffer.from(authEcho.split(' ')[1], 'base64').toString());
  assert.strictEqual(Buffer.from(authEcho.split(' ')[1], 'base64').toString(), 'demo-user:s3cret!');
  await page.screenshot({ path: path.join(OUT, '8-auth-inherit.png') });

  // ---- projects: a folder OUTSIDE the workspace + a Git repository ----
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routinel-proj-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'spring'), path.join(extDir, 'orders-service'), { recursive: true });
  await state.commands.get('routinel.addProjectFolder')(path.join(extDir, 'orders-service'));
  const { execSync } = require('child_process');
  const repoSrc = path.join(extDir, 'billing-src');
  fs.cpSync(path.join(__dirname, 'fixtures', 'fastapi'), repoSrc, { recursive: true });
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repoSrc });
  const cloneParent = path.join(extDir, 'clones');
  fs.mkdirSync(cloneParent);
  const proj = api.projects;
  await proj.addGit(repoSrc, cloneParent);
  const roots = tree.getChildren();
  for (const r of roots) {
    const ti = tree.getTreeItem(r);
    const n = tree.getChildren(r).reduce((acc, g) => acc + tree.getChildren(g).length, 0);
    console.log(`source: ${ti.label}  [${ti.contextValue}]  ${ti.description}  (${n} endpoints under it)`);
  }
  assert.ok(roots.some((r) => r.name === 'orders-service' && r.endpoints.length === 4));
  assert.ok(roots.some((r) => r.name === 'billing-src' && r.endpoints.length >= 3));
  const saved = JSON.parse(fs.readFileSync(path.join(ws, '.global', 'projects.json'), 'utf8'));
  console.log('projects saved:', saved.projects.map((p) => `${p.name} (${p.endpoints.length} APIs, git: ${p.git ? p.git.branch : '-'})`).join(', '));
  const projEp = saved.projects[0].endpoints[0];
  await state.commands.get('routinel.openEndpoint')(projEp.id);
  console.log('opened project endpoint in editor:', state.panels[state.panels.length - 1].title);

  await browser.close();
  server.close();
  console.log('\nE2E OK — screenshots in', OUT);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

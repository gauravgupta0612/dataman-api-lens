'use strict';
/**
 * Routinel
 * Automatically discovers every HTTP API in the workspace (any language / framework), with its parameters,
 * and lets you call them from a Postman-like client inside VS Code — or use the client on its own for any URL.
 */
const vscode = require('vscode');
const path = require('path');
const { ScanService } = require('./src/service');
const { Store } = require('./src/store');
const { ProjectService } = require('./src/projects');
const { EnvPanel } = require('./src/envPanel');
const { PanelManager, openSource } = require('./src/panel');
const { ApiTreeProvider, CollectionTreeProvider, HistoryTreeProvider, EndpointCodeLensProvider } = require('./src/trees');
const model = require('./src/model');
const httpClient = require('./src/http');

let yaml = null;
try { yaml = require('js-yaml'); } catch (e) { yaml = null; }

function activate(context) {
  const output = vscode.window.createOutputChannel('Routinel');
  const store = new Store(context);
  const service = new ScanService(context, output);
  const projects = new ProjectService(context, output);
  service.projects = projects;
  const panels = new PanelManager(context, service, store);
  const allEndpoints = () => [...service.endpoints, ...projects.allEndpoints()];

  // ---------------------------------------------------------------- views
  const apiTree = new ApiTreeProvider(service, context, projects);
  const apiView = vscode.window.createTreeView('routinel.apis', { treeDataProvider: apiTree, showCollapseAll: true });
  const colTree = new CollectionTreeProvider(store);
  const colView = vscode.window.createTreeView('routinel.collections', { treeDataProvider: colTree, showCollapseAll: true });
  const histTree = new HistoryTreeProvider(store);
  const histView = vscode.window.createTreeView('routinel.history', { treeDataProvider: histTree });
  context.subscriptions.push(apiView, colView, histView, output);
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }], new EndpointCodeLensProvider(service)));

  // ---------------------------------------------------------------- status bar
  const sbApis = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  sbApis.command = 'routinel.quickOpen';
  const sbEnv = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  sbEnv.command = 'routinel.selectEnvironment';
  context.subscriptions.push(sbApis, sbEnv);
  const refreshStatus = async () => {
    const n = allEndpoints().length;
    const busy = service.scanning || projects.scanning.size > 0;
    sbApis.text = busy ? '$(sync~spin) Routinel' : `$(radio-tower) ${n} API${n === 1 ? '' : 's'}`;
    sbApis.tooltip = 'Routinel — click to search discovered APIs';
    sbApis.show();
    const { activeName } = await store.getVariables();
    sbEnv.text = `$(globe) ${activeName || 'No environment'}`;
    sbEnv.tooltip = 'Routinel: active environment (click to switch)';
    sbEnv.show();
    apiView.description = busy ? 'scanning…' : apiTree.filter ? `filter: ${apiTree.filter}` : n ? `${n}` : '';
    apiView.badge = n ? { value: n, tooltip: `${n} APIs discovered` } : undefined;
  };
  let envEnsured = false;
  service.onDidChange(async (e) => {
    vscode.commands.executeCommand('setContext', 'routinel.hasApis', allEndpoints().length > 0);
    if (!e.scanning && !envEnsured && vscode.workspace.workspaceFolders) {
      envEnsured = true;
      if (service.endpoints.length) await store.ensureEnvironment(service.hints.baseUrls);
    }
    refreshStatus();
  });
  projects.onDidChange(async () => {
    vscode.commands.executeCommand('setContext', 'routinel.hasApis', allEndpoints().length > 0);
    vscode.commands.executeCommand('setContext', 'routinel.hasProjects', projects.projects.length > 0);
    const withHints = projects.projects.find((p) => p.hints && p.endpoints && p.endpoints.length);
    if (withHints) {
      const envs = await store.getEnvironments();
      if (!envs.environments.length) await store.ensureEnvironment(withHints.hints.baseUrls);
    }
    refreshStatus();
  });
  store.onDidChange((what) => { if (what === 'environments') refreshStatus(); });

  // ---------------------------------------------------------------- helpers
  const pickEndpoint = async (placeHolder) => {
    if (!allEndpoints().length) {
      vscode.window.showInformationMessage('Routinel: no APIs discovered yet. Add a project folder/repository or open a workspace.');
      return null;
    }
    const items = allEndpoints().map((e) => ({ label: `${e.method} ${e.path}`, description: e.framework + (e.handler ? ' · ' + e.handler : ''), detail: `${service.relative(e.file)}:${e.line + 1}`, id: e.id }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: placeHolder || 'Search discovered APIs (method, path, framework, file)…', matchOnDescription: true, matchOnDetail: true });
    return pick ? service.get(pick.id) : null;
  };
  const endpointFrom = async (arg) => {
    if (typeof arg === 'string') return service.get(arg);
    if (arg && arg.endpoint) return arg.endpoint;
    if (arg && arg.kind === 'endpoint') return arg.endpoint;
    return pickEndpoint();
  };
  const requestFrom = async (arg) => {
    if (arg && arg.kind === 'request' && arg.node) return arg.node.request;
    if (arg && arg.request && arg.at) return arg.request; // history entry
    const ep = await endpointFrom(arg);
    return ep ? model.endpointToRequest(ep) : null;
  };
  const openEndpoint = (ep, autoSend) => panels.open('ep:' + ep.id, model.endpointToRequest(ep), { kind: 'endpoint', id: ep.id }, { autoSend });
  const workspaceName = () => (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].name : 'workspace');
  const defaultUri = (file) => {
    const ws = vscode.workspace.workspaceFolders;
    return ws && ws.length ? vscode.Uri.joinPath(ws[0].uri, file) : undefined;
  };
  const endpointsAsCollection = (endpoints, name) => {
    const groups = new Map();
    for (const e of endpoints) {
      const key = service.relative(e.file);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return {
      id: model.newId(),
      name,
      items: [...groups.entries()].map(([file, eps]) => ({
        id: model.newId(),
        type: 'folder',
        name: file,
        items: eps.map((e) => ({ id: model.newId(), type: 'request', name: `${e.method} ${e.path}`, request: model.endpointToRequest(e) })),
      })),
    };
  };

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ---------------------------------------------------------------- discovery commands
  reg('routinel.refresh', async () => {
    await Promise.all([service.scanAll(), projects.rescanAll()]);
  });
  reg('routinel.quickOpen', async () => {
    const ep = await pickEndpoint();
    if (ep) openEndpoint(ep);
  });
  reg('routinel.openEndpoint', async (arg) => {
    const ep = await endpointFrom(arg);
    if (ep) openEndpoint(ep);
  });
  reg('routinel.sendEndpoint', async (arg) => {
    const ep = await endpointFrom(arg);
    if (ep) openEndpoint(ep, true);
  });
  reg('routinel.goToSource', async (arg) => {
    const ep = await endpointFrom(arg);
    if (ep) await openSource({ file: ep.file, line: ep.line, endpointId: ep.id }, service);
  });
  reg('routinel.copyCurl', async (arg) => {
    const req = await requestFrom(arg);
    if (!req) return;
    const { vars, auth } = await store.getVariables();
    await vscode.env.clipboard.writeText(model.generate('curl', httpClient.prepare(req, vars, auth), req, vars, httpClient.resolveVars));
    vscode.window.setStatusBarMessage('$(check) cURL copied to clipboard', 2500);
  });
  reg('routinel.copyUrl', async (arg) => {
    const req = await requestFrom(arg);
    if (!req) return;
    const { vars, auth } = await store.getVariables();
    await vscode.env.clipboard.writeText(httpClient.buildUrl(req, vars, auth));
    vscode.window.setStatusBarMessage('$(check) URL copied to clipboard', 2500);
  });
  reg('routinel.filter', async () => {
    const text = await vscode.window.showInputBox({ prompt: 'Filter discovered APIs (method, path, framework, file, handler)', value: apiTree.filter, placeHolder: 'e.g.  POST users   or   spring   or   /orders' });
    if (text !== undefined) {
      apiTree.setFilter(text);
      refreshStatus();
    }
  });
  reg('routinel.clearFilter', () => {
    apiTree.setFilter('');
    refreshStatus();
  });
  reg('routinel.groupBy', async () => {
    const opts = [
      { label: 'File', value: 'file' },
      { label: 'Framework', value: 'framework' },
      { label: 'Language', value: 'language' },
      { label: 'Resource (first path segment)', value: 'resource' },
      { label: 'HTTP method', value: 'method' },
      { label: 'No grouping', value: 'none' },
    ].map((o) => ({ ...o, description: o.value === apiTree.groupBy ? '(current)' : '' }));
    const pick = await vscode.window.showQuickPick(opts, { placeHolder: 'Group discovered APIs by…' });
    if (pick) apiTree.setGroupBy(pick.value);
  });
  reg('routinel.showLog', () => output.show());

  // ---------------------------------------------------------------- client commands
  reg('routinel.newRequest', async () => {
    const req = model.emptyRequest('New Request');
    panels.open('new:' + req.id, req, { kind: 'new' });
  });
  reg('routinel.openCollectionItem', async (id) => {
    const data = await store.getCollections();
    const found = Store.find(data, typeof id === 'string' ? id : id && id.node && id.node.id);
    if (!found || !found.item.request) return;
    const req = JSON.parse(JSON.stringify(found.item.request));
    req.name = found.item.name;
    panels.open('col:' + found.item.id, req, { kind: 'collection', id: found.item.id });
  });
  reg('routinel.openHistoryItem', async (id) => {
    const entry = store.getHistory().find((h) => h.id === (typeof id === 'string' ? id : id && id.id));
    if (!entry) return;
    const req = JSON.parse(JSON.stringify(entry.request));
    req.id = model.newId();
    panels.open('hist:' + entry.id, req, { kind: 'history', id: entry.id }, { response: entry.response ? { ...entry.response, method: entry.request.method, headers: entry.response.headers || [] } : null });
  });
  reg('routinel.deleteHistoryItem', (h) => h && store.deleteHistory(h.id));
  reg('routinel.clearHistory', async () => {
    const ok = await vscode.window.showWarningMessage('Clear the request history for this workspace?', { modal: true }, 'Clear');
    if (ok) await store.clearHistory();
  });
  reg('routinel.clearCookies', () => {
    httpClient.clearCookies();
    vscode.window.setStatusBarMessage('$(check) Routinel cookie jar cleared', 2500);
  });

  // ---------------------------------------------------------------- collections
  reg('routinel.newCollection', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'New collection name', value: workspaceName() });
    if (name) await store.createCollection(name);
  });
  reg('routinel.newFolder', async (el) => {
    if (!el || !el.node) return;
    const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
    if (name) await store.addFolder(el.node.id, name);
  });
  reg('routinel.renameItem', async (el) => {
    if (!el || !el.node) return;
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: el.node.name });
    if (name) await store.renameItem(el.node.id, name);
  });
  reg('routinel.deleteItem', async (el) => {
    if (!el || !el.node) return;
    const ok = await vscode.window.showWarningMessage(`Delete "${el.node.name}"?`, { modal: true }, 'Delete');
    if (ok) await store.deleteItem(el.node.id);
  });
  const endpointsOfArg = (arg) => (arg && arg.kind === 'source' ? apiTree.visible(arg.endpoints) : apiTree.visible());
  const nameOfArg = (arg) => (arg && arg.kind === 'source' ? arg.name : workspaceName());
  reg('routinel.addAllToCollection', async (arg) => {
    const eps = endpointsOfArg(arg);
    if (!eps.length) return vscode.window.showInformationMessage('Routinel: nothing to add — no APIs discovered.');
    const name = await vscode.window.showInputBox({ prompt: `Create a collection from ${eps.length} discovered API(s)`, value: `${nameOfArg(arg)} (discovered)` });
    if (!name) return;
    await store.addCollection(endpointsAsCollection(eps, name));
    vscode.window.showInformationMessage(`Routinel: collection "${name}" created with ${eps.length} request(s).`);
  });

  // ---------------------------------------------------------------- import / export
  reg('routinel.exportPostman', async (arg) => {
    const eps = endpointsOfArg(arg);
    if (!eps.length) return vscode.window.showInformationMessage('Routinel: no APIs to export.');
    const { vars } = await store.getVariables();
    const json = model.collectionToPostman(endpointsAsCollection(eps, `${nameOfArg(arg)} API`), { baseUrl: vars.baseUrl || service.hints.baseUrls[0] });
    const uri = await vscode.window.showSaveDialog({ defaultUri: defaultUri(`${nameOfArg(arg).replace(/[^\w.-]+/g, '_')}.postman_collection.json`), filters: { 'Postman collection': ['json'] } });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(json, null, 2), 'utf8'));
    vscode.window.showInformationMessage(`Routinel: exported ${eps.length} request(s) to ${path.basename(uri.fsPath)} — import it in Postman, Insomnia, Bruno or Hoppscotch.`);
  });
  reg('routinel.exportOpenApi', async (arg) => {
    const eps = endpointsOfArg(arg).filter((e) => !e.fromSpec);
    if (!eps.length) return vscode.window.showInformationMessage('Routinel: no code-discovered APIs to export.');
    const { vars } = await store.getVariables();
    const doc = model.endpointsToOpenApi(eps, `${nameOfArg(arg)} API`, vars.baseUrl || service.hints.baseUrls[0]);
    const uri = await vscode.window.showSaveDialog({ defaultUri: defaultUri('openapi.discovered.' + (yaml ? 'yaml' : 'json')), filters: { OpenAPI: ['yaml', 'yml', 'json'] } });
    if (!uri) return;
    const text = /\.json$/i.test(uri.fsPath) || !yaml ? JSON.stringify(doc, null, 2) : yaml.dump(JSON.parse(JSON.stringify(doc)), { noRefs: true, lineWidth: 140 });
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    const open = await vscode.window.showInformationMessage(`Routinel: OpenAPI document written (${eps.length} operations).`, 'Open');
    if (open) vscode.window.showTextDocument(uri);
  });
  reg('routinel.exportCollection', async (el) => {
    let collection = el && el.node;
    if (!collection) {
      const data = await store.getCollections();
      const pick = await vscode.window.showQuickPick(data.collections.map((c) => ({ label: c.name, c })), { placeHolder: 'Collection to export' });
      if (!pick) return;
      collection = pick.c;
    }
    const { vars } = await store.getVariables();
    const json = model.collectionToPostman(collection, { baseUrl: vars.baseUrl || '' });
    const uri = await vscode.window.showSaveDialog({ defaultUri: defaultUri(`${collection.name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`), filters: { 'Postman collection': ['json'] } });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(json, null, 2), 'utf8'));
    vscode.window.setStatusBarMessage('$(check) Collection exported', 2500);
  });
  reg('routinel.importPostman', async () => {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'Postman collection': ['json'] }, openLabel: 'Import' });
    if (!uris) return;
    for (const uri of uris) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const { collection, variables } = model.postmanToCollection(text);
        await store.addCollection(collection);
        // merge collection variables into the active environment without overwriting existing values
        const envs = await store.getEnvironments();
        if (Object.keys(variables).length) {
          if (!envs.environments.length) envs.environments.push({ name: 'Local', variables: {} });
          const active = envs.environments.find((e) => e.name === envs.active) || envs.environments[0];
          envs.active = active.name;
          for (const [k, v] of Object.entries(variables)) if (!(k in active.variables)) active.variables[k] = v;
          await store.saveEnvironments(envs);
        }
        vscode.window.showInformationMessage(`Routinel: imported "${collection.name}".`);
      } catch (e) {
        vscode.window.showErrorMessage(`Routinel: could not import ${path.basename(uri.fsPath)} — ${e.message}`);
      }
    }
  });

  // ---------------------------------------------------------------- environments
  reg('routinel.selectEnvironment', async () => {
    const envs = await store.getEnvironments();
    const items = envs.environments.map((e) => ({ label: (e.name === envs.active ? '$(check) ' : '$(globe) ') + e.name, description: e.variables.baseUrl || '', name: e.name }));
    items.push({ label: '$(settings-gear) Manage environments (base URL, auth, variables)…', name: '__edit__' }, { label: '$(add) New environment…', name: '__new__' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select the active environment' });
    if (!pick) return;
    if (pick.name === '__edit__') return vscode.commands.executeCommand('routinel.editEnvironments');
    if (pick.name === '__new__') {
      const name = await vscode.window.showInputBox({ prompt: 'Environment name', placeHolder: 'e.g. Dev, Staging, Production' });
      if (!name) return;
      const baseUrl = await vscode.window.showInputBox({ prompt: 'Base URL for ' + name, value: service.hints.baseUrls[0] || 'http://localhost:3000' });
      envs.environments.push({ name, variables: { baseUrl: baseUrl || '', token: '' } });
      envs.active = name;
      await store.saveEnvironments(envs);
      return;
    }
    await store.setActiveEnvironment(pick.name);
  });
  const bestBaseUrls = () => {
    const p = projects.projects.find((x) => x.hints);
    return service.endpoints.length || !p ? service.hints.baseUrls : p.hints.baseUrls;
  };
  reg('routinel.editEnvironments', async (focus) => {
    await store.ensureEnvironment(bestBaseUrls());
    EnvPanel.show(context, store, typeof focus === 'string' ? focus : undefined);
  });
  reg('routinel.openEnvironmentsJson', async () => {
    await store.ensureEnvironment(bestBaseUrls());
    const doc = await vscode.workspace.openTextDocument(store.fileUri('environments.json'));
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  // ---------------------------------------------------------------- projects (folders / repositories you point Routinel at)
  const projectOf = (arg) => (arg && arg.project ? arg.project : arg && arg.id ? projects.get(arg.id) : null);
  const addFolderFlow = async (folder) => {
    try {
      const p = await projects.addFolder(folder);
      vscode.window.showInformationMessage(`Routinel: project "${p.name}" added — ${(p.endpoints || []).length} API(s) found.`);
      return p;
    } catch (e) {
      vscode.window.showErrorMessage('Routinel: ' + e.message);
    }
  };
  reg('routinel.addProject', async () => {
    const pick = await vscode.window.showQuickPick([
      { label: '$(folder-opened) Choose a folder…', description: 'any project folder on this computer', v: 'browse' },
      { label: '$(edit) Type or paste a folder path…', description: 'e.g. C:\\src\\my-service', v: 'path' },
      { label: '$(repo-clone) Clone a Git repository…', description: 'HTTPS or SSH URL — cloned, then scanned', v: 'git' },
    ], { placeHolder: 'Where are the APIs? Routinel will scan that location and save it as a project' });
    if (!pick) return;
    if (pick.v === 'browse') {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Scan for APIs' });
      if (uris) for (const u of uris) await addFolderFlow(u.fsPath);
    } else if (pick.v === 'path') {
      const p = await vscode.window.showInputBox({ prompt: 'Folder to scan for APIs', placeHolder: 'C:\\Users\\you\\source\\repos\\my-api', ignoreFocusOut: true });
      if (p) await addFolderFlow(p);
    } else {
      await vscode.commands.executeCommand('routinel.cloneProject');
    }
  });
  reg('routinel.addProjectFolder', async (folder) => {
    if (typeof folder === 'string') return addFolderFlow(folder);
    if (folder && folder.fsPath) return addFolderFlow(folder.fsPath);
    return vscode.commands.executeCommand('routinel.addProject');
  });
  reg('routinel.cloneProject', async () => {
    const url = await vscode.window.showInputBox({ prompt: 'Git repository URL', placeHolder: 'https://github.com/org/repo.git  or  git@gitlab.example.com:group/repo.git', ignoreFocusOut: true });
    if (!url) return;
    const branch = await vscode.window.showInputBox({ prompt: 'Branch (leave empty for the default branch)', ignoreFocusOut: true });
    if (branch === undefined) return;
    const def = vscode.workspace.getConfiguration('routinel').get('projects.cloneFolder') || '';
    let parent = def;
    if (!parent) {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone into this folder' });
      if (!uris) return;
      parent = uris[0].fsPath;
    }
    try {
      const p = await projects.addGit(url.trim(), parent, branch.trim() || undefined);
      vscode.window.showInformationMessage(`Routinel: cloned and scanned "${p.name}" — ${(p.endpoints || []).length} API(s) found.`);
    } catch (e) {
      vscode.window.showErrorMessage('Routinel: ' + e.message);
    }
  });
  reg('routinel.rescanProject', async (arg) => {
    const p = projectOf(arg);
    if (p) await projects.rescan(p.id);
    else if (arg && arg.isWorkspace) await service.scanAll();
  });
  reg('routinel.pullProject', async (arg) => {
    const p = projectOf(arg);
    if (!p) return;
    try {
      await projects.pull(p.id);
    } catch (e) {
      vscode.window.showErrorMessage('Routinel: ' + e.message);
    }
  });
  reg('routinel.renameProject', async (arg) => {
    const p = projectOf(arg);
    if (!p) return;
    const name = await vscode.window.showInputBox({ prompt: 'Project name', value: p.name });
    if (name) await projects.rename(p.id, name);
  });
  reg('routinel.removeProject', async (arg) => {
    const p = projectOf(arg);
    if (!p) return;
    const ok = await vscode.window.showWarningMessage(`Remove project "${p.name}" from Routinel? (Files on disk are not touched.)`, { modal: true }, 'Remove');
    if (ok) await projects.remove(p.id);
  });
  reg('routinel.openProjectFolder', async (arg) => {
    const p = projectOf(arg);
    if (p) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.root), { forceNewWindow: true });
  });
  reg('routinel.revealProject', async (arg) => {
    const p = projectOf(arg);
    if (p) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p.root));
  });
  reg('routinel.setSecret', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Secret variable name (use it as {{name}})', placeHolder: 'token' });
    if (!name) return;
    const value = await vscode.window.showInputBox({ prompt: `Value for {{${name}}} — stored in the OS keychain via VS Code SecretStorage`, password: true });
    if (value === undefined) return;
    await store.setSecret(name.trim(), value);
    vscode.window.showInformationMessage(`Routinel: secret {{${name}}} saved securely.`);
  });
  reg('routinel.deleteSecret', async () => {
    const names = store.secretNames();
    if (!names.length) return vscode.window.showInformationMessage('Routinel: no secret variables stored.');
    const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Secret variable to delete' });
    if (pick) await store.deleteSecret(pick);
  });

  // reload environments when the file is edited by hand
  const envWatcher = vscode.workspace.createFileSystemWatcher('**/.routinel/*.json');
  envWatcher.onDidChange((uri) => store._onDidChange.fire(/collections/.test(uri.fsPath) ? 'collections' : 'environments'));
  envWatcher.onDidCreate((uri) => store._onDidChange.fire(/collections/.test(uri.fsPath) ? 'collections' : 'environments'));
  context.subscriptions.push(envWatcher);

  // ---------------------------------------------------------------- lifecycle
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => service.scanAll()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('routinel.scan')) service.scanAll();
      if (e.affectsConfiguration('routinel.projects.paths')) {
        for (const folder of vscode.workspace.getConfiguration('routinel').get('projects.paths') || []) {
          if (!projects.projects.some((p) => p.root.toLowerCase() === require('path').resolve(folder).toLowerCase())) projects.addFolder(folder).catch((err) => output.appendLine(err.message));
        }
      }
      if (e.affectsConfiguration('routinel.codeLens')) service._publish();
    })
  );
  service.startWatching();
  refreshStatus();
  const cfg = vscode.workspace.getConfiguration('routinel');
  if (cfg.get('scan.onStartup', true)) service.scanAll();
  // projects: load saved ones, add folders listed in settings, refresh in the background
  projects.load().then(async () => {
    for (const folder of cfg.get('projects.paths') || []) {
      if (!projects.projects.some((p) => p.root.toLowerCase() === require('path').resolve(folder).toLowerCase())) {
        try { await projects.addFolder(folder); } catch (e) { output.appendLine('Project path from settings skipped: ' + e.message); }
      }
    }
    if (cfg.get('scan.onStartup', true)) projects.rescanAll();
  });

  return { getEndpoints: () => service.endpoints, getAllEndpoints: allEndpoints, projects };
}

function deactivate() {}

module.exports = { activate, deactivate };

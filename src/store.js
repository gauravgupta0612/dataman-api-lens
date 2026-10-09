'use strict';
/**
 * Persistent state:
 *  - environments + collections live in  <workspace>/.routinel/*.json  (shareable through git, like a Postman workspace)
 *    or in the extension's global storage when no folder is open
 *  - history lives in workspaceState
 *  - secret variables live in VS Code SecretStorage (never written to disk in clear text)
 */
const vscode = require('vscode');
const { newId } = require('./model');

const HISTORY_KEY = 'routinel.history';
const SECRET_INDEX_KEY = 'routinel.secretNames';
const MAX_HISTORY = 200;
const AUTH_SECRET_FIELDS = ['password', 'token', 'value'];

function summarizeAuth(a) {
  if (!a || !a.type || a.type === 'none') return { type: 'none', label: 'No Auth' };
  if (a.type === 'basic') return { type: 'basic', label: 'Basic Auth' + (a.username ? ' (user: ' + a.username + ')' : '') };
  if (a.type === 'bearer') return { type: 'bearer', label: 'Bearer Token' };
  if (a.type === 'apikey') return { type: 'apikey', label: 'API Key' + (a.key ? ' (' + a.key + ' in ' + (a.addTo === 'query' ? 'query' : 'header') + ')' : '') };
  return { type: a.type, label: a.type };
}

class Store {
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event; // fires 'environments' | 'collections' | 'history'
    this._cache = {};
  }

  baseDir() {
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws.length) return vscode.Uri.joinPath(ws[0].uri, '.routinel');
    return this.context.globalStorageUri;
  }

  fileUri(name) {
    return vscode.Uri.joinPath(this.baseDir(), name);
  }

  async readJson(name, fallback) {
    try {
      const buf = await vscode.workspace.fs.readFile(this.fileUri(name));
      return JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch (e) {
      return fallback;
    }
  }

  async writeJson(name, value) {
    await vscode.workspace.fs.createDirectory(this.baseDir());
    await vscode.workspace.fs.writeFile(this.fileUri(name), Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
    await this.ensureGitignore();
  }

  async ensureGitignore() {
    // keep local-only secrets/history out of git; environments/collections stay shareable
    const uri = this.fileUri('.gitignore');
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (e) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('# Routinel\n# environments.local.json holds machine-specific values and is not shared\nenvironments.local.json\n', 'utf8'));
    }
  }

  // ---------------------------------------------------------------- environments
  async getEnvironments() {
    const data = await this.readJson('environments.json', null);
    if (data && Array.isArray(data.environments)) return { active: data.active || (data.environments[0] && data.environments[0].name), environments: data.environments, globals: data.globals || {} };
    return { active: null, environments: [], globals: {} };
  }

  async saveEnvironments(envs) {
    await this.writeJson('environments.json', envs);
    this._onDidChange.fire('environments');
  }

  /** Create a "Local" environment with a detected baseUrl if none exists (or fill a missing baseUrl). */
  async ensureEnvironment(baseUrls) {
    const envs = await this.getEnvironments();
    const best = (baseUrls && baseUrls[0]) || 'http://localhost:3000';
    if (!envs.environments.length) {
      envs.environments.push({ name: 'Local', variables: { baseUrl: best }, auth: { type: 'none' } });
      for (const extra of (baseUrls || []).slice(1, 4)) {
        if (/localhost/.test(extra)) continue;
        envs.environments.push({ name: extra.replace(/^https?:\/\//, '').split('/')[0], variables: { baseUrl: extra }, auth: { type: 'none' } });
      }
      envs.active = 'Local';
      await this.saveEnvironments(envs);
      return envs;
    }
    const active = envs.environments.find((e) => e.name === envs.active) || envs.environments[0];
    if (active && !active.variables.baseUrl) {
      active.variables.baseUrl = best;
      await this.saveEnvironments(envs);
    }
    return envs;
  }

  async setActiveEnvironment(name) {
    const envs = await this.getEnvironments();
    envs.active = name;
    await this.saveEnvironments(envs);
  }

  envSecretKey(envName, name) {
    return 'routinel.env.' + envName + '.' + name;
  }

  /** All variables for the active environment: globals < environment < local overrides < secret vars < global secrets.
   *  Also returns the environment's default authentication (with its secret fields resolved). */
  async getVariables() {
    const envs = await this.getEnvironments();
    const local = await this.readJson('environments.local.json', {});
    const active = envs.environments.find((e) => e.name === envs.active) || envs.environments[0];
    const vars = { ...(envs.globals || {}), ...((active && active.variables) || {}), ...((active && local[active.name]) || {}) };
    const secretNames = [...this.secretNames()];
    if (active) {
      for (const name of active.secretVars || []) {
        const v = await this.context.secrets.get(this.envSecretKey(active.name, name));
        vars[name] = v !== undefined ? v : '';
        secretNames.push(name);
      }
    }
    for (const name of this.secretNames()) {
      const v = await this.context.secrets.get('routinel.secret.' + name);
      if (v !== undefined) vars[name] = v;
    }
    let auth = { type: 'none' };
    if (active && active.auth && active.auth.type && active.auth.type !== 'none') {
      auth = { ...active.auth };
      for (const f of AUTH_SECRET_FIELDS) {
        const v = await this.context.secrets.get(this.envSecretKey(active.name, '__auth_' + f));
        if (v !== undefined) auth[f] = v;
      }
    }
    return {
      vars,
      auth,
      activeName: active ? active.name : null,
      names: envs.environments.map((e) => e.name),
      secretNames,
      authSummary: summarizeAuth(active && active.auth),
    };
  }

  /** Environments for the editor UI. Secret values are never sent to the UI — only whether they are set. */
  async getEnvironmentDetails() {
    const envs = await this.getEnvironments();
    const out = [];
    for (const e of envs.environments) {
      const variables = [];
      for (const [key, value] of Object.entries(e.variables || {})) variables.push({ key, value: String(value), secret: false });
      for (const key of e.secretVars || []) {
        const v = await this.context.secrets.get(this.envSecretKey(e.name, key));
        variables.push({ key, value: '', secret: true, isSet: v !== undefined && v !== '' });
      }
      const auth = { type: 'none', ...(e.auth || {}) };
      const authSet = {};
      for (const f of AUTH_SECRET_FIELDS) {
        const v = await this.context.secrets.get(this.envSecretKey(e.name, '__auth_' + f));
        authSet[f] = v !== undefined && v !== '';
        auth[f] = '';
      }
      out.push({ name: e.name, variables, auth, authSet });
    }
    return { active: envs.active, environments: out };
  }

  /** Save from the editor UI. payload.environments[i] = { name, oldName, variables:[{key,value,secret,keep}], auth:{...}, authKeep:{password,token,value} } */
  async saveEnvironmentDetails(payload) {
    const before = await this.getEnvironments();
    const result = { active: payload.active, environments: [], globals: before.globals || {} };
    const seen = new Set();
    for (const e of payload.environments) {
      const name = String(e.name || '').trim() || 'Environment';
      if (seen.has(name)) throw new Error('Two environments are named "' + name + '"');
      seen.add(name);
      const old = before.environments.find((x) => x.name === (e.oldName || name));
      const variables = {};
      const secretVars = [];
      for (const v of e.variables || []) {
        const key = String(v.key || '').trim();
        if (!key) continue;
        if (v.secret) {
          secretVars.push(key);
          const k = this.envSecretKey(name, key);
          if (v.keep && old) {
            const prev = await this.context.secrets.get(this.envSecretKey(old.name, v.oldKey || key));
            if (prev !== undefined) await this.context.secrets.store(k, prev);
          } else await this.context.secrets.store(k, String(v.value || ''));
        } else variables[key] = String(v.value === undefined ? '' : v.value);
      }
      const auth = { ...(e.auth || { type: 'none' }) };
      for (const f of AUTH_SECRET_FIELDS) {
        const k = this.envSecretKey(name, '__auth_' + f);
        if (e.authKeep && e.authKeep[f] && old) {
          const prev = await this.context.secrets.get(this.envSecretKey(old.name, '__auth_' + f));
          if (prev !== undefined) await this.context.secrets.store(k, prev);
        } else if (auth[f]) await this.context.secrets.store(k, String(auth[f]));
        else await this.context.secrets.delete(k);
        delete auth[f];
      }
      result.environments.push({ name, variables, secretVars, auth });
    }
    // clean secrets of removed / renamed environments and removed secret vars
    for (const old of before.environments) {
      const now = result.environments.find((x) => x.name === old.name);
      for (const key of [...(old.secretVars || []), ...AUTH_SECRET_FIELDS.map((f) => '__auth_' + f)]) {
        const stillUsed = now && (key.startsWith('__auth_') ? true : now.secretVars.includes(key));
        if (!stillUsed) await this.context.secrets.delete(this.envSecretKey(old.name, key));
      }
    }
    if (!result.environments.find((x) => x.name === result.active)) result.active = result.environments[0] ? result.environments[0].name : null;
    await this.saveEnvironments(result);
  }

  async setVariable(name, value) {
    const envs = await this.getEnvironments();
    const active = envs.environments.find((e) => e.name === envs.active) || envs.environments[0];
    if (!active) return;
    active.variables[name] = value;
    await this.saveEnvironments(envs);
  }

  secretNames() {
    return this.context.globalState.get(SECRET_INDEX_KEY, []);
  }

  async setSecret(name, value) {
    await this.context.secrets.store('routinel.secret.' + name, value);
    const names = new Set(this.secretNames());
    names.add(name);
    await this.context.globalState.update(SECRET_INDEX_KEY, [...names]);
    this._onDidChange.fire('environments');
  }

  async deleteSecret(name) {
    await this.context.secrets.delete('routinel.secret.' + name);
    await this.context.globalState.update(SECRET_INDEX_KEY, this.secretNames().filter((n) => n !== name));
    this._onDidChange.fire('environments');
  }

  // ---------------------------------------------------------------- collections
  async getCollections() {
    const data = await this.readJson('collections.json', { version: 1, collections: [] });
    if (!Array.isArray(data.collections)) data.collections = [];
    return data;
  }

  async saveCollections(data) {
    await this.writeJson('collections.json', data);
    this._onDidChange.fire('collections');
  }

  async addCollection(collection) {
    const data = await this.getCollections();
    data.collections.push(collection);
    await this.saveCollections(data);
    return collection;
  }

  async createCollection(name) {
    return this.addCollection({ id: newId(), name, items: [] });
  }

  /** Find an item (collection, folder or request) and its parent list by id. */
  static find(data, id) {
    for (const c of data.collections) {
      if (c.id === id) return { item: c, parentList: data.collections, collection: c };
      const walk = (items) => {
        for (const it of items || []) {
          if (it.id === id) return { item: it, parentList: items, collection: c };
          if (it.type === 'folder') {
            const r = walk(it.items);
            if (r) return r;
          }
        }
        return null;
      };
      const r = walk(c.items);
      if (r) return r;
    }
    return null;
  }

  async saveRequestToCollection(collectionId, name, request) {
    const data = await this.getCollections();
    const found = Store.find(data, collectionId);
    if (!found) throw new Error('Collection not found');
    const item = { id: newId(), type: 'request', name, request: { ...request, name } };
    found.item.items = found.item.items || [];
    found.item.items.push(item);
    await this.saveCollections(data);
    return item;
  }

  async updateRequest(itemId, request) {
    const data = await this.getCollections();
    const found = Store.find(data, itemId);
    if (!found) return false;
    found.item.request = { ...request, name: found.item.name };
    await this.saveCollections(data);
    return true;
  }

  async renameItem(id, name) {
    const data = await this.getCollections();
    const found = Store.find(data, id);
    if (!found) return;
    found.item.name = name;
    if (found.item.request) found.item.request.name = name;
    await this.saveCollections(data);
  }

  async deleteItem(id) {
    const data = await this.getCollections();
    const found = Store.find(data, id);
    if (!found) return;
    found.parentList.splice(found.parentList.indexOf(found.item), 1);
    await this.saveCollections(data);
  }

  async addFolder(parentId, name) {
    const data = await this.getCollections();
    const found = Store.find(data, parentId);
    if (!found) return;
    found.item.items = found.item.items || [];
    found.item.items.push({ id: newId(), type: 'folder', name, items: [] });
    await this.saveCollections(data);
  }

  // ---------------------------------------------------------------- history
  getHistory() {
    return this.context.workspaceState.get(HISTORY_KEY, []);
  }

  async addHistory(entry) {
    const list = this.getHistory();
    list.unshift({ id: newId(), at: Date.now(), ...entry });
    await this.context.workspaceState.update(HISTORY_KEY, list.slice(0, MAX_HISTORY));
    this._onDidChange.fire('history');
  }

  async deleteHistory(id) {
    await this.context.workspaceState.update(HISTORY_KEY, this.getHistory().filter((h) => h.id !== id));
    this._onDidChange.fire('history');
  }

  async clearHistory() {
    await this.context.workspaceState.update(HISTORY_KEY, []);
    this._onDidChange.fire('history');
  }
}

module.exports = { Store };

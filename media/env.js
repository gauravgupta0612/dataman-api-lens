// Routinel — environment manager webview
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const S = { data: null, sel: 0, dirty: false };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  const post = (m) => vscode.postMessage(m);
  const $ = (s) => document.querySelector(s);

  function prepare(data) {
    for (const e of data.environments) {
      e.oldName = e.name;
      e.auth = Object.assign({ type: 'none' }, e.auth || {});
      e.authSet = e.authSet || {};
      e.authCleared = {};
      for (const v of e.variables) { v.oldKey = v.key; v.cleared = false; }
    }
    return data;
  }
  function cur() { return S.data.environments[S.sel]; }
  function markDirty() {
    S.dirty = true;
    const d = $('#dirty');
    if (d) d.textContent = '● unsaved changes';
  }
  function toast(text, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' error' : '') }, text);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ------------------------------------------------------------------ render
  function render() {
    const app = $('#app');
    app.className = '';
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'topbar' },
      h('div', { class: 'crumb' }, h('span', { class: 'badge' }, 'Routinel'), h('span', { class: 'name' }, 'Environments'), h('span', { id: 'dirty', class: 'metric', style: { color: 'var(--dm-post)' } }, S.dirty ? '● unsaved changes' : '')),
      h('button', { class: 'ghost', title: 'Open the environments.json file', onclick: () => post({ type: 'openJson' }) }, 'Open JSON'),
      h('button', { class: 'ghost', title: 'Discard changes and reload', onclick: () => post({ type: 'reload' }) }, 'Reload'),
      h('button', { class: 'primary', title: 'Save (Ctrl+S)', onclick: save }, 'Save')
    ));
    const layout = h('div', { class: 'env-layout' });
    layout.appendChild(renderList());
    layout.appendChild(renderEditor());
    app.appendChild(layout);
  }

  function renderList() {
    const list = h('div', { class: 'env-list' });
    list.appendChild(h('div', { class: 'section-title' }, 'Environments'));
    S.data.environments.forEach((e, i) => {
      const radio = h('input', { type: 'radio', name: 'active', checked: S.data.active === e.name, title: 'Make this the active environment' });
      radio.addEventListener('click', (ev) => { ev.stopPropagation(); S.data.active = e.name; markDirty(); render(); });
      list.appendChild(h('div', { class: 'env-item' + (i === S.sel ? ' sel' : ''), onclick: () => { S.sel = i; render(); } },
        radio, h('span', { class: 'env-name' }, e.name || '(unnamed)'), S.data.active === e.name ? h('span', { class: 'pill' }, 'active') : null));
    });
    if (!S.data.environments.length) list.appendChild(h('div', { class: 'empty-note' }, 'No environments yet.'));
    list.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { onclick: addEnv }, '+ New'),
      S.data.environments.length ? h('button', { class: 'ghost', onclick: duplicateEnv }, 'Duplicate') : null,
      S.data.environments.length ? h('button', { class: 'ghost', onclick: () => post({ type: 'confirmDelete', index: S.sel, name: cur().name }) }, 'Delete') : null));
    list.appendChild(h('div', { class: 'hint' }, 'The active environment (radio button) is used when you send requests. You can also switch it from the status bar or the request editor.'));
    return list;
  }

  function field(label, input, help) {
    return [h('label', {}, label), h('div', {}, input, help ? h('div', { class: 'hint', style: { marginTop: '3px' } }, help) : null)];
  }

  function renderEditor() {
    const box = h('div', { class: 'env-editor' });
    const e = cur();
    if (!e) {
      box.appendChild(h('div', { class: 'placeholder' }, 'Create an environment to store your base URL, credentials and variables.', h('br'), h('button', { class: 'primary', style: { marginTop: '10px' }, onclick: addEnv }, '+ New environment')));
      return box;
    }
    // ---- general
    box.appendChild(h('div', { class: 'section-title' }, 'General'));
    const name = h('input', { type: 'text', value: e.name, spellcheck: 'false' });
    name.addEventListener('input', () => {
      if (S.data.active === e.name) S.data.active = name.value;
      e.name = name.value;
      markDirty();
      const items = document.querySelectorAll('.env-item .env-name');
      if (items[S.sel]) items[S.sel].textContent = name.value || '(unnamed)';
    });
    let base = e.variables.find((v) => v.key === 'baseUrl');
    const baseIn = h('input', { type: 'text', class: 'mono', value: base ? base.value : '', placeholder: 'http://localhost:8080', spellcheck: 'false' });
    baseIn.addEventListener('input', () => {
      if (!base) { base = { key: 'baseUrl', value: '', secret: false, oldKey: 'baseUrl' }; e.variables.unshift(base); }
      base.value = baseIn.value;
      const row = document.querySelector('tr[data-key="baseUrl"] td.val input');
      if (row) row.value = baseIn.value;
      markDirty();
    });
    box.appendChild(h('div', { class: 'form-grid wide' }, ...field('Name', name), ...field('Base URL', baseIn, 'Used as {{baseUrl}} — every discovered API starts with it.')));

    // ---- auth
    box.appendChild(h('div', { class: 'section-title' }, 'Authorization'));
    box.appendChild(h('div', { class: 'hint', style: { marginTop: 0, marginBottom: '8px' } }, 'Default credentials for this environment. Every request whose Auth is "Inherit from environment" (the default) uses them.'));
    const a = e.auth;
    const type = h('select', {}, [['none', 'No Auth'], ['basic', 'Basic Auth (username / password)'], ['bearer', 'Bearer Token'], ['apikey', 'API Key']].map(([v, l]) => h('option', { value: v, selected: a.type === v ? true : undefined }, l)));
    type.addEventListener('change', () => { a.type = type.value; markDirty(); render(); });
    const grid = h('div', { class: 'form-grid wide' }, ...field('Type', type));
    const text = (label, key, ph) => {
      const inp = h('input', { type: 'text', class: 'mono', value: a[key] || '', placeholder: ph || '', spellcheck: 'false' });
      inp.addEventListener('input', () => { a[key] = inp.value; markDirty(); });
      grid.append(...field(label, inp));
    };
    const secret = (label, key, ph) => {
      const isSet = e.authSet[key] && !e.authCleared[key];
      const inp = h('input', { type: 'password', class: 'mono', value: a[key] || '', placeholder: isSet ? '•••••••• saved securely — type to replace' : ph || '', autocomplete: 'off' });
      const show = h('button', { class: 'ghost', title: 'Show / hide' }, '👁');
      show.addEventListener('click', () => { inp.type = inp.type === 'password' ? 'text' : 'password'; });
      inp.addEventListener('input', () => { a[key] = inp.value; markDirty(); });
      const clear = isSet ? h('button', { class: 'ghost', title: 'Remove the saved value' }, 'Clear') : null;
      if (clear) clear.addEventListener('click', () => { e.authCleared[key] = true; a[key] = ''; markDirty(); render(); });
      grid.append(...field(label, h('div', { class: 'row', style: { margin: 0, flexWrap: 'nowrap' } }, inp, show, clear), 'Stored in the OS keychain (VS Code SecretStorage), never in the JSON file.'));
    };
    if (a.type === 'basic') { text('Username', 'username', 'user'); secret('Password', 'password', 'password'); }
    if (a.type === 'bearer') { secret('Token', 'token', 'eyJhbGciOi…'); text('Prefix', 'prefix', 'Bearer'); }
    if (a.type === 'apikey') {
      text('Key name', 'key', 'X-API-Key');
      secret('Value', 'value', 'api key');
      const addTo = h('select', {}, h('option', { value: 'header', selected: a.addTo !== 'query' ? true : undefined }, 'Header'), h('option', { value: 'query', selected: a.addTo === 'query' ? true : undefined }, 'Query parameter'));
      addTo.addEventListener('change', () => { a.addTo = addTo.value; markDirty(); });
      grid.append(...field('Add to', addTo));
    }
    box.appendChild(grid);

    // ---- variables
    box.appendChild(h('div', { class: 'section-title' }, 'Variables'));
    box.appendChild(variablesTable(e));
    box.appendChild(h('div', { class: 'hint', html: 'Use variables anywhere in a request as <code>{{name}}</code> — URL, params, headers, body or auth. Tick <b>Secret</b> for passwords, tokens and keys: their value goes to the OS keychain instead of <code>.routinel/environments.json</code> (which can be shared through git). Built-in: <code>{{$guid}}</code> <code>{{$timestamp}}</code> <code>{{$isoTimestamp}}</code> <code>{{$randomInt}}</code>.' }));
    return box;
  }

  function variablesTable(e) {
    const table = h('table', { class: 'kv' });
    table.appendChild(h('colgroup', {}, h('col', { style: { width: '32%' } }), h('col', {}), h('col', { style: { width: '70px' } }), h('col', { style: { width: '34px' } })));
    table.appendChild(h('thead', {}, h('tr', {}, h('th', {}, 'Variable'), h('th', {}, 'Value'), h('th', {}, 'Secret'), h('th', {}))));
    const tbody = h('tbody', {});
    table.appendChild(tbody);
    const makeRow = (v, ghost) => {
      const tr = h('tr', { class: ghost ? 'ghost' : '', 'data-key': v.key });
      const ensure = () => {
        if (!tr.classList.contains('ghost')) return;
        tr.classList.remove('ghost');
        e.variables.push(v);
        tbody.appendChild(makeRow({ key: '', value: '', secret: false }, true));
        del.disabled = false;
        sec.disabled = false;
      };
      const key = h('input', { type: 'text', class: 'mono', value: v.key, placeholder: 'name', spellcheck: 'false' });
      key.addEventListener('input', () => { ensure(); v.key = key.value; tr.setAttribute('data-key', v.key); markDirty(); });
      const isSet = v.secret && v.isSet && !v.cleared;
      const val = h('input', { type: v.secret ? 'password' : 'text', class: 'mono', value: v.value, placeholder: isSet ? '•••••• saved securely — type to replace' : 'value', spellcheck: 'false', autocomplete: 'off' });
      val.addEventListener('input', () => {
        ensure();
        v.value = val.value;
        markDirty();
        if (v.key === 'baseUrl') { const b = document.querySelector('.form-grid input.mono'); if (b) b.value = val.value; }
      });
      const sec = h('input', { type: 'checkbox', checked: v.secret, disabled: ghost ? true : undefined, title: 'Store this value in the OS keychain' });
      sec.addEventListener('change', () => { v.secret = sec.checked; if (!sec.checked) v.isSet = false; val.type = sec.checked ? 'password' : 'text'; markDirty(); });
      const del = h('button', { class: 'danger', title: 'Remove', disabled: ghost ? true : undefined }, '✕');
      del.addEventListener('click', () => { const i = e.variables.indexOf(v); if (i >= 0) e.variables.splice(i, 1); tr.remove(); markDirty(); });
      tr.append(h('td', {}, key), h('td', { class: 'val' }, val), h('td', { class: 'chk' }, sec), h('td', { class: 'del' }, del));
      return tr;
    };
    for (const v of e.variables) tbody.appendChild(makeRow(v, false));
    tbody.appendChild(makeRow({ key: '', value: '', secret: false }, true));
    return table;
  }

  // ------------------------------------------------------------------ actions
  function uniqueName(base) {
    let n = base;
    let i = 2;
    while (S.data.environments.some((e) => e.name === n)) n = base + ' ' + i++;
    return n;
  }
  function addEnv() {
    const first = S.data.environments[0];
    const baseVar = first && first.variables.find((v) => v.key === 'baseUrl');
    S.data.environments.push({ name: uniqueName(S.data.environments.length ? 'Dev' : 'Local'), oldName: null, variables: [{ key: 'baseUrl', value: baseVar ? baseVar.value : 'http://localhost:8080', secret: false }], auth: { type: 'none' }, authSet: {}, authCleared: {} });
    if (!S.data.active) S.data.active = S.data.environments[0].name;
    S.sel = S.data.environments.length - 1;
    markDirty();
    render();
  }
  function duplicateEnv() {
    const e = cur();
    const copy = JSON.parse(JSON.stringify(e));
    copy.name = uniqueName(e.name + ' copy');
    copy.oldName = null;
    // secrets cannot be copied from the UI (they are never sent to it)
    copy.authSet = {};
    copy.variables = copy.variables.map((v) => (v.secret ? { ...v, isSet: false, value: '' } : v));
    S.data.environments.push(copy);
    S.sel = S.data.environments.length - 1;
    markDirty();
    render();
    toast('Duplicated — secret values must be entered again');
  }
  function save() {
    const names = S.data.environments.map((e) => (e.name || '').trim());
    if (names.some((n) => !n)) return toast('Every environment needs a name', true);
    if (new Set(names).size !== names.length) return toast('Environment names must be unique', true);
    const payload = {
      active: S.data.active,
      environments: S.data.environments.map((e) => ({
        name: e.name.trim(),
        oldName: e.oldName,
        auth: { ...e.auth },
        authKeep: Object.fromEntries(['password', 'token', 'value'].map((f) => [f, !!(e.authSet[f] && !e.authCleared[f] && !e.auth[f])])),
        variables: e.variables.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value, secret: !!v.secret, oldKey: v.oldKey, keep: !!(v.secret && v.isSet && !v.cleared && v.value === '' && e.oldName) })),
      })),
    };
    post({ type: 'save', data: payload });
  }

  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); save(); }
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        S.data = prepare(m.data);
        S.dirty = false;
        S.sel = Math.max(0, S.data.environments.findIndex((e) => e.name === (m.focus || S.data.active)));
        if (!S.data.environments.length) addEnv();
        render();
        break;
      case 'saved': {
        const selName = cur() && cur().name;
        S.data = prepare(m.data);
        S.dirty = false;
        S.sel = Math.max(0, S.data.environments.findIndex((e) => e.name === selName));
        render();
        toast('Saved ✓');
        break;
      }
      case 'focus': {
        const i = S.data.environments.findIndex((e) => e.name === m.focus);
        if (i >= 0) { S.sel = i; render(); }
        break;
      }
      case 'deleteConfirmed':
        if (m.ok) {
          const [gone] = S.data.environments.splice(m.index, 1);
          if (S.data.active === gone.name) S.data.active = S.data.environments[0] ? S.data.environments[0].name : null;
          S.sel = 0;
          markDirty();
          render();
        }
        break;
      case 'externalChange':
        if (!S.dirty) post({ type: 'reload' });
        break;
      case 'error':
        toast(m.text, true);
        break;
    }
  });
  post({ type: 'ready' });
})();

// Routinel — request editor webview
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_MODES = [
    ['none', 'none'],
    ['json', 'JSON'],
    ['text', 'Text'],
    ['xml', 'XML'],
    ['urlencoded', 'x-www-form-urlencoded'],
    ['formdata', 'form-data'],
  ];
  const CODE_LANGS = [
    ['curl', 'cURL (bash)'],
    ['powershell', 'PowerShell'],
    ['fetch', 'JavaScript – fetch'],
    ['python', 'Python – requests'],
    ['http', 'HTTP file (.http)'],
  ];

  const saved = vscode.getState() || {};
  const S = {
    request: null,
    origin: null,
    meta: null,
    env: { names: [], active: null, vars: {} },
    settings: { wrap: true },
    response: saved.response || null,
    error: null,
    sending: false,
    tab: saved.tab || 'params',
    resTab: 'body',
    resView: 'pretty',
    dirty: false,
    codeLang: saved.codeLang || 'curl',
    code: '',
    warnings: [],
    split: saved.split || null,
    showExtract: false,
  };

  // ------------------------------------------------------------------ helpers
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
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const post = (msg) => vscode.postMessage(msg);
  function persist() {
    vscode.setState({ response: S.response && S.response.body && S.response.body.length < 2000000 ? S.response : null, tab: S.tab, codeLang: S.codeLang, split: S.split });
  }
  let changeTimer = null;
  function changed(opts) {
    S.dirty = true;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => post({ type: 'changed', request: S.request }), 150);
    renderCrumb();
    renderResolved();
    if (!opts || !opts.keepCounts) renderTabs();
    if (S.tab === 'code') requestCode();
  }
  function toast(text, level) {
    const t = h('div', { class: 'toast ' + (level || '') }, text);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function normalizeRequest(r) {
    r.params = r.params || [];
    r.pathVars = r.pathVars || [];
    r.headers = r.headers || [];
    r.auth = r.auth && r.auth.type ? r.auth : { type: 'inherit' };
    r.body = r.body || { mode: 'none' };
    r.body.raw = r.body.raw || '';
    r.body.urlencoded = r.body.urlencoded || [];
    r.body.formdata = r.body.formdata || [];
    return r;
  }

  // ------------------------------------------------------------------ URL logic
  function syncPathVars() {
    const r = S.request;
    const keys = [];
    const path = String(r.url || '').split('?')[0].replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\{\{[^}]+\}\}/, '');
    const re = /\/:([A-Za-z_][\w-]*)/g;
    let m;
    while ((m = re.exec(path))) if (!keys.includes(m[1])) keys.push(m[1]);
    const old = r.pathVars;
    const next = keys.map((k) => old.find((p) => p.key === k) || { key: k, value: '', description: '', enabled: true });
    const changedKeys = next.length !== old.length || next.some((p, i) => old[i] !== p);
    r.pathVars = next;
    return changedKeys;
  }
  function absorbQueryFromUrl() {
    const r = S.request;
    const idx = r.url.indexOf('?');
    if (idx === -1) return false;
    const qs = r.url.slice(idx + 1);
    r.url = r.url.slice(0, idx);
    const pairs = qs.split('&').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      const k = i === -1 ? p : p.slice(0, i);
      const v = i === -1 ? '' : p.slice(i + 1);
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } };
      return { key: dec(k), value: dec(v), description: '', enabled: true };
    });
    for (const p of pairs) {
      const ex = r.params.find((x) => x.key === p.key);
      if (ex) { ex.value = p.value; ex.enabled = true; } else r.params.push(p);
    }
    return true;
  }
  function resolveVarsHtml(s) {
    return esc(s).replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (m, name) => {
      if (Object.prototype.hasOwnProperty.call(S.env.vars || {}, name)) return esc(String(S.env.vars[name]));
      if (/^\$/.test(name)) return '<i>' + esc(m) + '</i>';
      return '<span class="unres" title="Variable not defined in the active environment">' + esc(m) + '</span>';
    });
  }
  function previewUrl() {
    const r = S.request;
    let url = r.url || '';
    for (const pv of r.pathVars) {
      if (!pv.key || pv.value === '') continue;
      url = url.replace(new RegExp('(/):' + pv.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[/?#.;])', 'g'), '$1' + pv.value);
    }
    const q = r.params.filter((p) => p.enabled !== false && p.key).map((p) => p.key + '=' + p.value);
    if (r.auth && r.auth.type === 'apikey' && r.auth.addTo === 'query' && r.auth.key) q.push(r.auth.key + '=' + (r.auth.value || ''));
    if (q.length) url += (url.includes('?') ? '&' : '?') + q.join('&');
    return url;
  }

  // ------------------------------------------------------------------ layout
  function renderAll() {
    const app = $('#app');
    app.className = '';
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'topbar', id: 'topbar' }, h('div', { class: 'crumb', id: 'crumb' }), envBox()));
    const reqSection = h('div', { class: 'request', id: 'reqsection' },
      requestLine(),
      h('div', { class: 'resolved', id: 'resolved' }),
      h('div', { id: 'warnings' }),
      h('div', { class: 'tabs', id: 'tabs' }),
      h('div', { class: 'tabbody', id: 'tabbody' })
    );
    app.appendChild(reqSection);
    app.appendChild(splitter());
    app.appendChild(h('div', { class: 'response', id: 'response' }));
    applySplit();
    renderCrumb();
    renderResolved();
    renderTabs();
    renderTabBody();
    renderResponse();
  }

  function applySplit() {
    const sec = $('#reqsection');
    if (!sec) return;
    const total = window.innerHeight;
    const hgt = S.split ? Math.min(Math.max(S.split, 150), total - 120) : Math.round(total * 0.5);
    sec.style.height = hgt + 'px';
  }

  function splitter() {
    const el = h('div', { class: 'splitter', title: 'Drag to resize' });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('drag');
      const sec = $('#reqsection');
      const startY = e.clientY;
      const startH = sec.getBoundingClientRect().height;
      const move = (ev) => {
        S.split = Math.min(Math.max(startH + ev.clientY - startY, 150), window.innerHeight - 100);
        sec.style.height = S.split + 'px';
      };
      const up = () => {
        el.classList.remove('drag');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        persist();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return el;
  }

  function renderCrumb() {
    const c = $('#crumb');
    if (!c) return;
    c.innerHTML = '';
    const o = S.origin || {};
    const m = S.meta;
    if (m) {
      c.appendChild(h('span', { class: 'badge', title: m.language || '' }, m.framework || 'Code'));
      if (m.file) c.appendChild(h('a', { title: 'Go to source', onclick: () => post({ type: 'openSource' }) }, `${m.file}:${m.line}`));
      if (m.handler && m.handler !== S.request.name) c.appendChild(h('span', { class: 'mono' }, m.handler));
      if (m.stale) c.appendChild(h('span', { class: 'pill', title: 'This endpoint is no longer detected in the workspace' }, 'stale'));
    } else if (o.kind === 'collection') {
      c.appendChild(h('span', { class: 'badge' }, 'Collection'));
    } else if (o.kind === 'history') {
      c.appendChild(h('span', { class: 'badge' }, 'History'));
    } else c.appendChild(h('span', { class: 'badge' }, 'New request'));
    const nameInput = h('span', { class: 'name', title: 'Request name' }, S.request.name || '');
    c.appendChild(nameInput);
    if (S.dirty && o.kind === 'collection') c.appendChild(h('span', { class: 'dirty', title: 'Unsaved changes' }, '•'));
  }

  function envBox() {
    const sel = h('select', { id: 'envsel', title: 'Active environment', onchange: (e) => post({ type: 'selectEnv', name: e.target.value }) });
    fillEnv(sel);
    return h('div', { class: 'envbox' },
      h('label', {}, 'Env'),
      sel,
      h('button', { class: 'ghost', title: 'Edit environments & variables', onclick: () => post({ type: 'editEnvs' }) }, '⚙')
    );
  }
  function fillEnv(sel) {
    sel.innerHTML = '';
    if (!S.env.names.length) sel.appendChild(h('option', { value: '' }, 'No environment'));
    for (const n of S.env.names) sel.appendChild(h('option', { value: n, selected: n === S.env.active ? true : undefined }, n));
    sel.value = S.env.active || '';
  }

  function requestLine() {
    const r = S.request;
    const method = h('select', { class: 'method-select m-' + r.method, id: 'method', title: 'HTTP method' },
      METHODS.map((m) => h('option', { value: m, class: 'm-' + m, selected: m === r.method ? true : undefined }, m))
    );
    method.addEventListener('change', () => {
      r.method = method.value;
      method.className = 'method-select m-' + r.method;
      changed();
      if (S.tab === 'body') renderTabBody();
    });
    const url = h('input', { type: 'text', class: 'url', id: 'url', value: r.url, spellcheck: 'false', placeholder: 'Enter request URL, e.g. {{baseUrl}}/api/users/:id' });
    url.addEventListener('input', () => {
      r.url = url.value;
      const pvChanged = syncPathVars();
      changed();
      if (pvChanged && S.tab === 'params') renderTabBody();
    });
    url.addEventListener('change', () => {
      if (absorbQueryFromUrl()) {
        url.value = r.url;
        changed();
        if (S.tab === 'params') renderTabBody();
      }
    });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { url.dispatchEvent(new Event('change')); send(); } });
    const sendBtn = h('button', { class: 'primary send', id: 'sendbtn', title: 'Send (Ctrl+Enter)', onclick: () => (S.sending ? post({ type: 'cancel' }) : send()) }, 'Send');
    const saveBtn = h('button', { title: 'Save to collection (Ctrl+S)', onclick: () => post({ type: 'save', request: S.request }) }, 'Save');
    const saveAs = h('button', { class: 'ghost', title: 'Save as a new request in a collection', onclick: () => post({ type: 'saveAs', request: S.request }) }, 'Save as…');
    return h('div', { class: 'reqline' }, method, url, sendBtn, saveBtn, saveAs);
  }

  function renderResolved() {
    const el = $('#resolved');
    if (!el) return;
    const u = previewUrl();
    el.innerHTML = /\{\{|:/.test(u) ? '→ ' + resolveVarsHtml(u) : '';
    el.title = el.textContent;
  }

  function renderWarnings() {
    const el = $('#warnings');
    if (!el) return;
    el.innerHTML = '';
    for (const w of S.warnings) el.appendChild(h('div', { class: 'warn' }, '⚠ ' + w));
  }

  // ------------------------------------------------------------------ tabs
  function tabDefs() {
    const r = S.request;
    const n = (rows) => rows.filter((x) => x.enabled !== false && x.key).length;
    const defs = [
      ['params', 'Params', n(r.params) + r.pathVars.length],
      ['headers', 'Headers', n(r.headers)],
      ['body', 'Body', r.body.mode !== 'none' ? '●' : 0],
      ['auth', 'Auth', r.auth.type !== 'none' && (r.auth.type !== 'inherit' || (S.env.auth && S.env.auth.type !== 'none')) ? '●' : 0],
      ['code', 'Code', 0],
    ];
    if (S.meta) defs.push(['info', 'Endpoint', 0]);
    return defs;
  }
  function renderTabs() {
    const el = $('#tabs');
    if (!el) return;
    el.innerHTML = '';
    for (const [id, label, count] of tabDefs()) {
      el.appendChild(h('button', { class: 'tab' + (S.tab === id ? ' active' : ''), onclick: () => { S.tab = id; persist(); renderTabs(); renderTabBody(); } }, label, count ? h('span', { class: 'count' }, String(count)) : null));
    }
  }
  function renderTabBody() {
    const el = $('#tabbody');
    if (!el) return;
    el.innerHTML = '';
    const r = S.request;
    switch (S.tab) {
      case 'params':
        el.appendChild(h('div', { class: 'section-title' }, 'Query parameters'));
        el.appendChild(kvTable(r.params, { keyPh: 'parameter', valPh: 'value' }));
        if (r.pathVars.length) {
          el.appendChild(h('div', { class: 'section-title' }, 'Path variables'));
          el.appendChild(kvTable(r.pathVars, { fixedKeys: true, valPh: 'value (required)' }));
        }
        break;
      case 'headers':
        el.appendChild(h('div', { class: 'section-title' }, 'Headers', h('button', { class: 'ghost', title: 'Add common headers', onclick: addCommonHeader }, '+ common')));
        el.appendChild(kvTable(r.headers, { keyPh: 'Header', valPh: 'value', datalist: 'hdrs' }));
        el.appendChild(headerDatalist());
        break;
      case 'body':
        renderBodyTab(el);
        break;
      case 'auth':
        renderAuthTab(el);
        break;
      case 'code':
        renderCodeTab(el);
        break;
      case 'info':
        renderInfoTab(el);
        break;
    }
  }

  function headerDatalist() {
    const names = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'User-Agent', 'X-API-Key', 'X-Request-Id', 'X-Correlation-Id', 'X-Tenant-Id'];
    return h('datalist', { id: 'hdrs' }, names.map((n) => h('option', { value: n })));
  }
  function addCommonHeader() {
    const r = S.request;
    const has = (k) => r.headers.some((x) => x.key.toLowerCase() === k.toLowerCase());
    if (!has('Accept')) r.headers.push({ key: 'Accept', value: 'application/json', enabled: true, description: '' });
    if (r.body.mode === 'json' && !has('Content-Type')) r.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true, description: '' });
    changed();
    renderTabBody();
  }

  /** Editable key/value table. rows is mutated in place. */
  function kvTable(rows, opts) {
    opts = opts || {};
    const table = h('table', { class: 'kv' });
    const cols = [h('col', { style: { width: '30px' } }), h('col', { style: { width: '30%' } })];
    if (opts.fileType) cols.push(h('col', { class: 'c-type' }));
    cols.push(h('col', {}), h('col', { style: { width: '26%' } }), h('col', { style: { width: '30px' } }));
    table.appendChild(h('colgroup', {}, cols));
    table.appendChild(h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Key'), opts.fileType ? h('th', {}, 'Type') : null, h('th', {}, 'Value'), h('th', {}, 'Description'), h('th', {}))));
    const tbody = h('tbody', {});
    table.appendChild(tbody);
    const makeRow = (row, ghost) => {
      const tr = h('tr', { class: ghost ? 'ghost' : row.enabled === false ? 'off' : '' });
      const ensure = () => {
        if (tr.classList.contains('ghost')) {
          tr.classList.remove('ghost');
          rows.push(row);
          tbody.appendChild(makeRow({ key: '', value: '', description: '', enabled: true, type: opts.fileType ? 'text' : undefined }, true));
          chk.disabled = false;
          del.disabled = false;
        }
      };
      const chk = h('input', { type: 'checkbox', checked: row.enabled !== false, disabled: ghost || opts.fixedKeys ? true : undefined, title: 'Enable / disable' });
      chk.addEventListener('change', () => { row.enabled = chk.checked; tr.className = row.enabled ? '' : 'off'; changed(); });
      const key = h('input', { type: 'text', value: row.key, placeholder: opts.keyPh || 'key', spellcheck: 'false', readonly: opts.fixedKeys ? true : undefined, class: opts.fixedKeys ? 'readonly mono' : 'mono', list: opts.datalist });
      key.addEventListener('input', () => { ensure(); row.key = key.value; changed(); });
      const val = h('input', { type: 'text', value: row.value, placeholder: row.type === 'file' ? 'click "File…" to choose' : opts.valPh || 'value', spellcheck: 'false', class: 'mono' });
      val.addEventListener('input', () => { ensure(); row.value = val.value; changed({ keepCounts: true }); });
      const desc = h('input', { type: 'text', value: row.description || '', placeholder: 'description', spellcheck: 'false' });
      desc.addEventListener('input', () => { ensure(); row.description = desc.value; changed({ keepCounts: true }); });
      const del = h('button', { class: 'danger', title: 'Remove', disabled: ghost || opts.fixedKeys ? true : undefined }, '✕');
      del.addEventListener('click', () => { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); tr.remove(); changed(); });
      const valWrap = h('div', { class: 'valwrap' });
      const valCell = h('td', { class: 'val' }, valWrap);
      if (opts.fileType && row.type === 'file') {
        const pick = h('button', { title: 'Choose file' }, 'File…');
        pick.addEventListener('click', () => { ensure(); filePickTargets.set(rows.indexOf(row), (p) => { row.value = p; val.value = p; changed({ keepCounts: true }); }); post({ type: 'pickFile', index: rows.indexOf(row) }); });
        valWrap.appendChild(pick);
      }
      valWrap.appendChild(val);
      tr.appendChild(h('td', { class: 'chk' }, chk));
      tr.appendChild(h('td', {}, key));
      if (opts.fileType) {
        const type = h('select', { title: 'Field type' }, h('option', { value: 'text', selected: row.type !== 'file' ? true : undefined }, 'Text'), h('option', { value: 'file', selected: row.type === 'file' ? true : undefined }, 'File'));
        type.addEventListener('change', () => { ensure(); row.type = type.value; changed(); const fresh = makeRow(row, false); tr.replaceWith(fresh); });
        tr.appendChild(h('td', {}, type));
      }
      tr.appendChild(valCell);
      tr.appendChild(h('td', {}, desc));
      tr.appendChild(h('td', { class: 'del' }, del));
      return tr;
    };
    for (const row of rows) tbody.appendChild(makeRow(row, false));
    if (!opts.fixedKeys) tbody.appendChild(makeRow({ key: '', value: '', description: '', enabled: true, type: opts.fileType ? 'text' : undefined }, true));
    return table;
  }
  const filePickTargets = new Map();

  function renderBodyTab(el) {
    const r = S.request;
    const b = r.body;
    const modes = h('div', { class: 'modes' });
    for (const [id, label] of BODY_MODES) {
      const radio = h('input', { type: 'radio', name: 'bodymode', value: id, checked: b.mode === id });
      radio.addEventListener('change', () => {
        b.mode = id;
        if ((id === 'json') && !b.raw.trim()) b.raw = '{\n  \n}';
        changed();
        renderTabBody();
      });
      modes.appendChild(h('label', {}, radio, label));
    }
    modes.appendChild(h('span', { class: 'spacer' }));
    if (b.mode === 'json') modes.appendChild(h('button', { class: 'ghost', title: 'Format JSON', onclick: beautify }, 'Beautify'));
    if (S.meta && S.meta.body && S.meta.body.example !== undefined && b.mode === 'json') modes.appendChild(h('button', { class: 'ghost', title: 'Reset body to the sample generated from code', onclick: () => { b.raw = JSON.stringify(S.meta.body.example, null, 2); changed(); renderTabBody(); } }, 'Sample from code'));
    el.appendChild(modes);
    if (['GET', 'HEAD'].includes(r.method) && b.mode !== 'none') el.appendChild(h('div', { class: 'hint' }, 'Note: most servers ignore a body on ' + r.method + ' requests.'));
    if (b.mode === 'none') {
      el.appendChild(h('div', { class: 'empty-note' }, 'This request does not have a body.'));
      return;
    }
    if (b.mode === 'urlencoded') { el.appendChild(kvTable(b.urlencoded, { keyPh: 'field', valPh: 'value' })); return; }
    if (b.mode === 'formdata') { el.appendChild(kvTable(b.formdata, { keyPh: 'field', valPh: 'value', fileType: true })); return; }
    const ta = h('textarea', { class: 'code', spellcheck: 'false', value: b.raw, placeholder: b.mode === 'json' ? '{ "key": "value" }' : '' });
    const status = h('div', { class: 'json-status' });
    const validate = () => {
      if (b.mode !== 'json') { status.textContent = ''; return; }
      const raw = b.raw.replace(/\{\{\s*[$\w.-]+\s*\}\}/g, '0');
      if (!raw.trim()) { status.textContent = ''; return; }
      try { JSON.parse(raw); status.textContent = '✓ valid JSON'; status.className = 'json-status'; } catch (e) { status.textContent = '✗ ' + e.message; status.className = 'json-status bad'; }
    };
    ta.addEventListener('input', () => { b.raw = ta.value; validate(); changed({ keepCounts: true }); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('  ', s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    el.appendChild(h('div', { class: 'editor-wrap' }, ta, status));
    validate();
  }
  function beautify() {
    const b = S.request.body;
    try {
      // protect {{vars}} that are used as bare values
      const holders = [];
      const protectedRaw = b.raw.replace(/(:\s*)(\{\{\s*[$\w.-]+\s*\}\})/g, (m, p, v) => { holders.push(v); return p + '"__RT_VAR_' + (holders.length - 1) + '__"'; });
      let out = JSON.stringify(JSON.parse(protectedRaw), null, 2);
      out = out.replace(/"__RT_VAR_(\d+)__"/g, (m, i) => holders[+i]);
      b.raw = out;
      changed({ keepCounts: true });
      renderTabBody();
    } catch (e) {
      toast('Cannot format: ' + e.message, 'error');
    }
  }

  function renderAuthTab(el) {
    const a = S.request.auth;
    const type = h('select', {}, [['inherit', 'Inherit from environment'], ['none', 'No Auth'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key']].map(([v, l]) => h('option', { value: v, selected: a.type === v ? true : undefined }, l)));
    type.addEventListener('change', () => { a.type = type.value; changed(); renderTabBody(); });
    const field = (label, key, ph, password) => {
      const inp = h('input', { type: password ? 'password' : 'text', value: a[key] || '', placeholder: ph || '', spellcheck: 'false', class: 'mono' });
      inp.addEventListener('input', () => { a[key] = inp.value; changed({ keepCounts: true }); });
      return [h('label', {}, label), inp];
    };
    const grid = h('div', { class: 'form-grid' }, h('label', {}, 'Type'), type);
    if (a.type === 'bearer') grid.append(...field('Token', 'token', '{{token}}'), ...field('Prefix', 'prefix', 'Bearer'));
    if (a.type === 'basic') grid.append(...field('Username', 'username', '{{username}}'), ...field('Password', 'password', '{{password}}', true));
    if (a.type === 'apikey') {
      grid.append(...field('Key', 'key', 'X-API-Key'), ...field('Value', 'value', '{{apiKey}}'));
      const addTo = h('select', {}, h('option', { value: 'header', selected: a.addTo !== 'query' ? true : undefined }, 'Header'), h('option', { value: 'query', selected: a.addTo === 'query' ? true : undefined }, 'Query Params'));
      addTo.addEventListener('change', () => { a.addTo = addTo.value; changed(); });
      grid.append(h('label', {}, 'Add to'), addTo);
    }
    if (a.type === 'inherit') {
      const envAuth = S.env.auth || { type: 'none', label: 'No Auth' };
      grid.append(h('label', {}, 'Environment'), h('div', {}, h('b', {}, S.env.active || 'No environment'), ' → ', envAuth.label || envAuth.type, ' ',
        h('button', { class: 'ghost', title: 'Set username / password, token or API key for this environment', onclick: () => post({ type: 'editEnvs', focus: S.env.active }) }, 'Edit environment auth…')));
    }
    el.appendChild(grid);
    if (a.type === 'inherit') {
      el.appendChild(h('div', { class: 'hint' }, 'This request uses the credentials stored in the active environment. Switch environment (top-right) to call the same API as a different user or on another server.'));
    } else if (a.type !== 'none') {
      el.appendChild(h('div', { class: 'hint', html: 'Tip: reference variables such as <code>{{token}}</code> instead of pasting secrets. Use <b>Routinel: Set Secret Variable</b> to store a value in the OS keychain — it is resolved at send time and never written to disk.' }));
    }
  }

  function renderCodeTab(el) {
    const sel = h('select', {}, CODE_LANGS.map(([v, l]) => h('option', { value: v, selected: v === S.codeLang ? true : undefined }, l)));
    sel.addEventListener('change', () => { S.codeLang = sel.value; persist(); requestCode(); });
    el.appendChild(h('div', { class: 'row' }, h('label', {}, 'Language'), sel, h('button', { onclick: () => post({ type: 'copy', text: S.code }) }, 'Copy'), h('span', { class: 'hint', style: { margin: 0 } }, 'Variables are resolved with the active environment.')));
    el.appendChild(h('pre', { class: 'codeblock', id: 'codeblock' }, S.code || 'Generating…'));
    requestCode();
  }
  let codeTimer = null;
  function requestCode() {
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => post({ type: 'codegen', lang: S.codeLang, request: S.request }), 120);
  }

  function renderInfoTab(el) {
    const m = S.meta;
    if (!m) return;
    el.appendChild(h('div', { class: 'info-grid' },
      h('div', {}, 'Endpoint'), h('div', { class: 'mono' }, h('b', { class: 'm-' + m.method }, m.method), ' ', m.path),
      h('div', {}, 'Framework'), h('div', {}, m.framework + (m.language ? ' (' + m.language + ')' : '')),
      h('div', {}, 'Source'), h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'openSource' }); } }, m.file + ':' + m.line)),
      m.handler ? h('div', {}, 'Handler') : null, m.handler ? h('div', { class: 'mono' }, m.handler) : null,
      m.summary ? h('div', {}, 'Summary') : null, m.summary ? h('div', {}, m.summary) : null
    ));
    el.appendChild(h('div', { class: 'section-title' }, 'Detected parameters'));
    if (!m.params.length) el.appendChild(h('div', { class: 'empty-note' }, 'No parameters detected.'));
    else el.appendChild(h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'In'), h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Required'), h('th', {}, 'Description'))),
      h('tbody', {}, m.params.map((p) => h('tr', {}, h('td', {}, h('span', { class: 'pill' }, p.in)), h('td', { class: 'mono' }, p.name), h('td', { class: 'mono' }, p.type || ''), h('td', {}, p.required ? '✓' : ''), h('td', {}, p.description || ''))))));
    if (m.body && m.body.mode !== 'none') {
      el.appendChild(h('div', { class: 'section-title' }, 'Detected body (' + m.body.mode + ')'));
      if (m.body.example !== undefined) el.appendChild(h('pre', { class: 'codeblock', html: highlightJson(JSON.stringify(m.body.example, null, 2)) }));
    }
    el.appendChild(h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { onclick: () => post({ type: 'regenerate' }), title: 'Discard edits and rebuild this request from the source code' }, '↺ Reset request from code')));
  }

  // ------------------------------------------------------------------ response
  function statusClass(s) {
    return 's' + String(s || 0)[0];
  }
  function highlightJson(text) {
    return esc(text).replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
      let cls = 'num';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'key' : 'str';
      else if (/^(true|false)$/.test(m)) cls = 'bool';
      else if (m === 'null') cls = 'null';
      return '<span class="j-' + cls + '">' + m + '</span>';
    });
  }
  function prettyXml(xml) {
    let pad = 0;
    return xml.replace(/>\s*</g, '>\n<').split('\n').map((line) => {
      if (/^<\/\w/.test(line)) pad = Math.max(pad - 1, 0);
      const out = '  '.repeat(pad) + line;
      if (/^<\w[^>]*[^/]>.*$/.test(line) && !/<\/\w/.test(line)) pad++;
      return out;
    }).join('\n');
  }
  function bodyInfo(res) {
    const ct = (res.contentType || '').toLowerCase();
    let json = null;
    if (!res.isBinary && (/json/.test(ct) || /^\s*[[{]/.test(res.body))) {
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
    }
    return { ct, json, isImage: /^image\//.test(ct) && res.isBinary, isXml: /xml/.test(ct), isHtml: /html/.test(ct) };
  }

  function renderResponse() {
    const el = $('#response');
    if (!el) return;
    el.innerHTML = '';
    const head = h('div', { class: 'res-head' }, h('span', { class: 'label' }, 'Response'));
    el.appendChild(head);
    if (S.sending) {
      head.appendChild(h('span', { class: 'metric' }, h('span', { class: 'spinner' }), ' Sending…'));
      head.appendChild(h('span', { class: 'spacer' }));
      head.appendChild(h('button', { onclick: () => post({ type: 'cancel' }) }, 'Cancel'));
      el.appendChild(h('div', { class: 'res-body' }, h('div', { class: 'placeholder' }, 'Waiting for ' + (S.sendingUrl || 'server') + ' …')));
      return;
    }
    if (S.error) {
      head.appendChild(h('span', { class: 'status s5' }, 'Error'));
      head.appendChild(h('span', { class: 'metric' }, 'Time ', h('b', {}, S.error.timeMs + ' ms')));
      const tips = [];
      if (/ECONNREFUSED|refused/i.test(S.error.message)) tips.push('Start your API locally, or switch the environment / {{baseUrl}} to a running server.');
      if (/certificate|CERT/i.test(S.error.message)) tips.push('For self-signed certificates set "routinel.http.rejectUnauthorized": false in Settings.');
      if (/ENOTFOUND/i.test(S.error.message)) tips.push('Check the host name and the value of {{baseUrl}} in the active environment.');
      el.appendChild(h('div', { class: 'res-body' }, h('div', { class: 'error-box' }, h('h4', {}, 'Could not get a response'), h('div', { class: 'mono' }, S.error.message), tips.length ? h('ul', {}, tips.map((t) => h('li', {}, t))) : null)));
      return;
    }
    const res = S.response;
    if (!res) {
      el.appendChild(h('div', { class: 'res-body' }, h('div', { class: 'placeholder', html: 'Enter the URL and click <b>Send</b> to get a response<br><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to send · <kbd>Ctrl</kbd> + <kbd>S</kbd> to save' })));
      return;
    }
    const info = bodyInfo(res);
    head.appendChild(h('span', { class: 'status ' + statusClass(res.status), title: res.statusText }, res.status + ' ' + (res.statusText || '')));
    head.appendChild(h('span', { class: 'metric' }, 'Time ', h('b', {}, res.timeMs + ' ms')));
    head.appendChild(h('span', { class: 'metric' }, 'Size ', h('b', {}, fmtSize(res.size))));
    if (res.redirects) head.appendChild(h('span', { class: 'metric' }, res.redirects + ' redirect(s)'));
    if (res.truncated) head.appendChild(h('span', { class: 'metric', title: 'Body was truncated' }, '(truncated)'));
    head.appendChild(h('span', { class: 'spacer' }));
    for (const [id, label] of [['body', 'Body'], ['headers', 'Headers (' + res.headers.length + ')'], ['cookies', 'Cookies'], ['sent', 'Request']]) {
      head.appendChild(h('button', { class: 'tab' + (S.resTab === id ? ' active' : ''), onclick: () => { S.resTab = id; renderResponse(); } }, label));
    }
    const body = h('div', { class: 'res-body', id: 'resbody' });
    if (S.resTab === 'body') {
      const tools = h('div', { class: 'row' });
      if (!res.isBinary) {
        for (const v of ['pretty', 'raw']) tools.appendChild(h('button', { class: S.resView === v ? '' : 'ghost', onclick: () => { S.resView = v; renderResponse(); } }, v === 'pretty' ? 'Pretty' : 'Raw'));
        tools.appendChild(h('button', { class: 'ghost', title: 'Toggle word wrap', onclick: () => { S.settings.wrap = !S.settings.wrap; renderResponse(); } }, S.settings.wrap ? 'Wrap: on' : 'Wrap: off'));
      }
      tools.appendChild(h('span', { style: { flex: 1 } }));
      if (info.json) tools.appendChild(h('button', { class: 'ghost', title: 'Save a value from this response into an environment variable', onclick: () => { S.showExtract = !S.showExtract; renderResponse(); } }, '{{ }} Save to variable'));
      if (!res.isBinary) tools.appendChild(h('button', { class: 'ghost', title: 'Copy body', onclick: () => post({ type: 'copy', text: info.json && S.resView === 'pretty' ? JSON.stringify(info.json, null, 2) : res.body }) }, 'Copy'));
      if (!res.isBinary) tools.appendChild(h('button', { class: 'ghost', title: 'Open the body in an editor tab', onclick: () => post({ type: 'openInEditor', content: info.json ? JSON.stringify(info.json, null, 2) : res.body, language: info.json ? 'json' : info.isXml ? 'xml' : info.isHtml ? 'html' : 'plaintext' }) }, 'Open in editor'));
      if (!res.isBinary) tools.appendChild(h('button', { class: 'ghost', title: 'Use this response in the Routinel mock server for this endpoint', onclick: () => post({ type: 'saveMock', status: res.status, body: res.body, contentType: res.contentType }) }, 'Save as mock'));
      tools.appendChild(h('button', { class: 'ghost', title: 'Save body to a file', onclick: () => post({ type: 'saveResponse', body: res.body, isBinary: res.isBinary, suggestedName: suggestName(res, info) }) }, 'Save'));
      body.appendChild(tools);
      if (S.showExtract && info.json) body.appendChild(extractForm(info.json));
      if (res.isBinary) {
        if (info.isImage) body.appendChild(h('img', { src: 'data:' + res.contentType.split(';')[0] + ';base64,' + res.body, alt: 'image response' }));
        else body.appendChild(h('div', { class: 'placeholder' }, `Binary response (${res.contentType || 'unknown type'}, ${fmtSize(res.decodedSize)}). Use Save to write it to a file.`));
      } else {
        const pre = h('pre', { class: S.settings.wrap ? 'wrap' : 'nowrap' });
        if (S.resView === 'pretty' && info.json !== null) {
          const txt = JSON.stringify(info.json, null, 2);
          if (txt.length < 400000) pre.innerHTML = highlightJson(txt);
          else pre.textContent = txt;
        } else if (S.resView === 'pretty' && info.isXml) pre.textContent = prettyXml(res.body);
        else pre.textContent = res.body || '(empty body)';
        body.appendChild(pre);
      }
    } else if (S.resTab === 'headers') {
      body.appendChild(h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'Header'), h('th', {}, 'Value'))), h('tbody', {}, res.headers.map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, v))))));
    } else if (S.resTab === 'cookies') {
      const cookies = res.cookies || [];
      body.appendChild(cookies.length ? h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'))), h('tbody', {}, cookies.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.name), h('td', { class: 'mono' }, c.value))))) : h('div', { class: 'empty-note' }, 'No cookies for this host.'));
    } else {
      body.appendChild(h('div', { class: 'info-grid' }, h('div', {}, 'Method'), h('div', { class: 'mono' }, res.method || S.request.method), h('div', {}, 'URL'), h('div', { class: 'mono' }, res.url || '')));
      body.appendChild(h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'Request header'), h('th', {}, 'Value'))), h('tbody', {}, (res.requestHeaders || []).map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, /authorization|api-key|token|cookie/i.test(k) ? String(v).slice(0, 12) + '…' : v))))));
    }
    el.appendChild(body);
  }

  function suggestName(res, info) {
    if (info.json) return 'response.json';
    if (info.isXml) return 'response.xml';
    if (info.isHtml) return 'response.html';
    const ext = ((res.contentType || '').split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '');
    return 'response.' + (ext || 'bin');
  }

  function extractForm(json) {
    const guess = findTokenPath(json) || '';
    const pathIn = h('input', { type: 'text', class: 'mono', value: guess, placeholder: 'JSON path, e.g. data.token or items[0].id' });
    const nameIn = h('input', { type: 'text', class: 'mono', value: /token/i.test(guess) ? 'token' : '', placeholder: 'variable name, e.g. token' });
    const preview = h('span', { class: 'metric mono' });
    const update = () => {
      const v = getPath(json, pathIn.value);
      preview.textContent = v === undefined ? '(no value at this path)' : '= ' + String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 80);
    };
    pathIn.addEventListener('input', update);
    update();
    const btn = h('button', { class: 'primary', onclick: () => {
      const v = getPath(json, pathIn.value);
      if (v === undefined || !nameIn.value.trim()) { toast('Pick a valid path and a variable name', 'error'); return; }
      post({ type: 'setVar', name: nameIn.value.trim(), value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
      S.showExtract = false;
      renderResponse();
    } }, 'Save');
    return h('div', { class: 'extract' }, pathIn, h('span', {}, '→ {{'), nameIn, h('span', {}, '}}'), btn, preview);
  }
  function getPath(obj, path) {
    if (!path) return undefined;
    const parts = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[p];
    }
    return cur;
  }
  function findTokenPath(obj, prefix, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 3) return null;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? prefix + '.' + k : k;
      if (/^(access_?token|token|jwt|id_?token|accessToken)$/i.test(k) && typeof v === 'string') return p;
      const sub = findTokenPath(v, p, depth + 1);
      if (sub) return sub;
    }
    return null;
  }

  // ------------------------------------------------------------------ actions
  function send() {
    if (S.sending) return;
    const urlEl = $('#url');
    if (urlEl && urlEl.value !== S.request.url) { S.request.url = urlEl.value; syncPathVars(); }
    absorbQueryFromUrl();
    if (urlEl) urlEl.value = S.request.url;
    const missing = S.request.pathVars.filter((p) => !String(p.value || '').trim()).map((p) => p.key);
    if (missing.length) {
      S.warnings = ['Path variable(s) without value: ' + missing.map((m) => ':' + m).join(', ')];
      renderWarnings();
    }
    post({ type: 'send', request: S.request });
  }

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); send(); }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); post({ type: e.shiftKey ? 'saveAs' : 'save', request: S.request }); }
  });
  window.addEventListener('resize', applySplit);

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'init':
        S.request = normalizeRequest(msg.request);
        S.origin = msg.origin;
        S.meta = msg.meta;
        S.env = msg.env;
        S.settings = Object.assign(S.settings, msg.settings || {});
        if (msg.response) S.response = msg.response;
        if (S.tab === 'info' && !S.meta) S.tab = 'params';
        syncPathVars();
        renderAll();
        break;
      case 'replace':
        S.request = normalizeRequest(msg.request);
        S.meta = msg.meta || S.meta;
        syncPathVars();
        S.dirty = true;
        renderAll();
        post({ type: 'changed', request: S.request });
        break;
      case 'env': {
        S.env = msg.env;
        const sel = $('#envsel');
        if (sel) fillEnv(sel);
        renderResolved();
        renderTabs();
        if (S.tab === 'code') requestCode();
        if (S.tab === 'auth') renderTabBody();
        break;
      }
      case 'triggerSend':
        send();
        break;
      case 'sending':
        S.sending = true;
        S.sendingUrl = msg.url;
        S.error = null;
        S.warnings = (S.warnings || []).filter((w) => /^Path variable/.test(w)).concat(msg.warnings || []);
        renderWarnings();
        updateSendButton();
        renderResponse();
        break;
      case 'response':
        S.sending = false;
        S.response = msg.response;
        S.error = null;
        S.resTab = 'body';
        S.showExtract = false;
        updateSendButton();
        renderResponse();
        persist();
        break;
      case 'requestError':
        S.sending = false;
        S.error = { message: msg.message, timeMs: msg.timeMs };
        updateSendButton();
        renderResponse();
        break;
      case 'code':
        if (msg.lang === S.codeLang) {
          S.code = msg.code;
          const cb = $('#codeblock');
          if (cb) cb.textContent = msg.code;
        }
        break;
      case 'filePicked': {
        const cb = filePickTargets.get(msg.index);
        if (cb) cb(msg.path);
        break;
      }
      case 'saved':
        S.dirty = false;
        if (msg.origin) S.origin = msg.origin;
        if (msg.name) S.request.name = msg.name;
        renderCrumb();
        break;
      case 'toast':
        toast(msg.text, msg.level);
        break;
    }
  });

  function updateSendButton() {
    const b = $('#sendbtn');
    if (!b) return;
    b.textContent = S.sending ? 'Cancel' : 'Send';
    b.title = S.sending ? 'Cancel request' : 'Send (Ctrl+Enter)';
  }

  post({ type: 'ready' });
})();

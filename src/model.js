'use strict';
/**
 * Request model helpers, code generators and Postman / OpenAPI converters.
 *
 * Request shape (shared by panels, collections and history):
 * { id, name, method, url, params: Row[], pathVars: Row[], headers: Row[],
 *   auth: { type: 'none'|'bearer'|'basic'|'apikey', token, prefix, username, password, key, value, addTo },
 *   body: { mode: 'none'|'json'|'text'|'xml'|'urlencoded'|'formdata', raw, urlencoded: Row[], formdata: Row[] } }
 * Row = { key, value, description, enabled, type? ('text'|'file' for formdata) }
 */
const crypto = require('crypto');

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function emptyRequest(name) {
  return {
    id: newId(),
    name: name || 'New Request',
    method: 'GET',
    url: '{{baseUrl}}/',
    params: [],
    pathVars: [],
    headers: [],
    auth: { type: 'inherit' },
    body: { mode: 'none', raw: '', urlencoded: [], formdata: [] },
  };
}

function sampleValue(p) {
  if (p.example !== undefined && p.example !== null) return typeof p.example === 'object' ? JSON.stringify(p.example) : String(p.example);
  if (p.enum && p.enum.length) return String(p.enum[0]);
  return '';
}

/** Convert a discovered endpoint into an editable request. */
function endpointToRequest(ep) {
  const req = emptyRequest(ep.summary || ep.handler || ep.method + ' ' + ep.path);
  req.method = ep.method;
  req.url = '{{baseUrl}}' + ep.path;
  const describe = (p) => [p.type && p.type !== 'string' ? p.type : '', p.required ? 'required' : '', p.description || ''].filter(Boolean).join(' · ');
  for (const p of ep.params) {
    const row = { key: p.name, value: sampleValue(p), description: describe(p), enabled: p.in === 'path' || !!p.required };
    if (p.in === 'path') req.pathVars.push({ ...row, enabled: true });
    else if (p.in === 'query') req.params.push(row);
    else if (p.in === 'header') req.headers.push(row);
    else if (p.in === 'cookie') req.headers.push({ ...row, key: 'Cookie', value: p.name + '=' + sampleValue(p) });
  }
  const forms = ep.params.filter((p) => p.in === 'form' || p.in === 'file');
  const mode = ep.body ? ep.body.mode : 'none';
  if (mode === 'json') {
    req.body.mode = 'json';
    req.body.raw = JSON.stringify(ep.body.example === undefined ? {} : ep.body.example, null, 2);
  } else if (mode === 'text' || mode === 'xml') {
    req.body.mode = mode;
    req.body.raw = typeof ep.body.example === 'string' ? ep.body.example : '';
  } else if (mode === 'urlencoded') {
    req.body.mode = 'urlencoded';
    req.body.urlencoded = forms.map((p) => ({ key: p.name, value: sampleValue(p), description: describe(p), enabled: true }));
  } else if (mode === 'formdata') {
    req.body.mode = 'formdata';
    req.body.formdata = forms.map((p) => ({ key: p.name, value: '', description: describe(p), enabled: true, type: p.in === 'file' ? 'file' : 'text' }));
  }
  req.source = { endpointId: ep.id, file: ep.file, line: ep.line, framework: ep.framework };
  return req;
}

// ------------------------------------------------------------------ code generation
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** prepared = output of http.prepare(); rawReq = original request (for formdata files) */
function generate(lang, prepared, rawReq, vars, resolveVars) {
  const bodyText = prepared.body && !/multipart/.test(prepared.body.contentType) ? prepared.body.buffer.toString('utf8') : null;
  const multipart = prepared.body && /multipart/.test(prepared.body.contentType);
  const formRows = multipart ? (rawReq.body.formdata || []).filter((r) => r.enabled !== false && r.key) : [];
  const headers = prepared.headers.filter(([k]) => !(multipart && /^content-type$/i.test(k)));
  const rv = (s) => resolveVars(s, vars);
  switch (lang) {
    case 'curl': {
      const lines = [`curl --location --request ${prepared.method} ${shellQuote(prepared.url)}`];
      for (const [k, v] of headers) lines.push(`--header ${shellQuote(k + ': ' + v)}`);
      if (bodyText !== null) lines.push(`--data-raw ${shellQuote(bodyText)}`);
      for (const r of formRows) lines.push(`--form ${shellQuote(rv(r.key) + '=' + (r.type === 'file' ? '@"' + rv(r.value) + '"' : rv(r.value)))}`);
      return lines.join(' \\\n  ');
    }
    case 'powershell': {
      const lines = ['$headers = @{'];
      for (const [k, v] of headers) lines.push(`    ${psQuote(k)} = ${psQuote(v)}`);
      lines.push('}');
      let extra = '';
      if (bodyText !== null) { lines.push(`$body = ${psQuote(bodyText)}`); extra = ' -Body $body'; }
      if (formRows.length) {
        lines.push('$form = @{');
        for (const r of formRows) lines.push(`    ${psQuote(rv(r.key))} = ${r.type === 'file' ? 'Get-Item -Path ' + psQuote(rv(r.value)) : psQuote(rv(r.value))}`);
        lines.push('}');
        extra = ' -Form $form';
      }
      lines.push(`$response = Invoke-RestMethod -Uri ${psQuote(prepared.url)} -Method ${prepared.method} -Headers $headers${extra}`);
      lines.push('$response | ConvertTo-Json -Depth 10');
      return lines.join('\n');
    }
    case 'fetch': {
      const opts = { method: prepared.method, headers: Object.fromEntries(headers) };
      const lines = [];
      if (formRows.length) {
        lines.push('const form = new FormData();');
        for (const r of formRows) lines.push(r.type === 'file' ? `form.append(${JSON.stringify(rv(r.key))}, fileInput.files[0], ${JSON.stringify(rv(r.value).split(/[\\/]/).pop())});` : `form.append(${JSON.stringify(rv(r.key))}, ${JSON.stringify(rv(r.value))});`);
      }
      let optStr = JSON.stringify(opts, null, 2);
      if (bodyText !== null) optStr = optStr.replace(/\n}$/, `,\n  "body": ${JSON.stringify(bodyText)}\n}`);
      if (formRows.length) optStr = optStr.replace(/\n}$/, ',\n  "body": form\n}');
      lines.push(`const response = await fetch(${JSON.stringify(prepared.url)}, ${optStr});`);
      lines.push('const data = await response.text();', 'console.log(response.status, data);');
      return lines.join('\n');
    }
    case 'python': {
      const lines = ['import requests', '', `url = ${JSON.stringify(prepared.url)}`, `headers = ${pyDict(Object.fromEntries(headers))}`];
      let extra = '';
      if (bodyText !== null) {
        let isJson = false;
        try { JSON.parse(bodyText); isJson = /json/i.test(prepared.body.contentType); } catch (e) { isJson = false; }
        if (isJson) { lines.push(`payload = ${pyLiteral(JSON.parse(bodyText))}`); extra = ', json=payload'; }
        else { lines.push(`payload = ${JSON.stringify(bodyText)}`); extra = ', data=payload'; }
      }
      if (formRows.length) {
        const data = formRows.filter((r) => r.type !== 'file').map((r) => `${JSON.stringify(rv(r.key))}: ${JSON.stringify(rv(r.value))}`);
        const files = formRows.filter((r) => r.type === 'file').map((r) => `${JSON.stringify(rv(r.key))}: open(${JSON.stringify(rv(r.value))}, "rb")`);
        lines.push(`data = {${data.join(', ')}}`, `files = {${files.join(', ')}}`);
        extra = ', data=data, files=files';
      }
      lines.push('', `response = requests.request(${JSON.stringify(prepared.method)}, url, headers=headers${extra})`, 'print(response.status_code)', 'print(response.text)');
      return lines.join('\n');
    }
    case 'http': {
      // VS Code REST Client / JetBrains .http format
      const lines = [`${prepared.method} ${prepared.url}`];
      for (const [k, v] of prepared.headers) lines.push(`${k}: ${v}`);
      if (bodyText !== null) lines.push('', bodyText);
      return lines.join('\n');
    }
    default:
      return '';
  }
}

function pyLiteral(v, indent = 0) {
  const pad = '    '.repeat(indent + 1);
  const end = '    '.repeat(indent);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => pad + pyLiteral(x, indent + 1)).join(',\n') + '\n' + end + ']' : '[]';
  if (typeof v === 'object') {
    const e = Object.entries(v);
    return e.length ? '{\n' + e.map(([k, x]) => pad + JSON.stringify(k) + ': ' + pyLiteral(x, indent + 1)).join(',\n') + '\n' + end + '}' : '{}';
  }
  return JSON.stringify(v);
}

function pyDict(o) {
  return pyLiteral(o);
}

// ------------------------------------------------------------------ Postman v2.1
const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function requestToPostmanItem(req) {
  const urlRaw = req.url || '';
  const pathPart = urlRaw.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const hostPart = urlRaw.slice(0, urlRaw.length - urlRaw.replace(/^\{\{[^}]+\}\}|^https?:\/\/[^/]+/, '').length) || urlRaw;
  const query = (req.params || []).filter((p) => p.key).map((p) => ({ key: p.key, value: p.value, description: p.description || undefined, disabled: p.enabled === false || undefined }));
  const qs = query.filter((q) => !q.disabled).map((q) => q.key + '=' + q.value).join('&');
  const item = {
    name: req.name || req.method + ' ' + pathPart,
    request: {
      method: req.method,
      header: (req.headers || []).filter((h) => h.key).map((h) => ({ key: h.key, value: h.value, description: h.description || undefined, disabled: h.enabled === false || undefined })),
      url: {
        raw: urlRaw + (qs ? '?' + qs : ''),
        host: [hostPart],
        path: pathPart.split('/').filter(Boolean),
        query: query.length ? query : undefined,
        variable: (req.pathVars || []).length ? req.pathVars.map((v) => ({ key: v.key, value: v.value, description: v.description || undefined })) : undefined,
      },
    },
    response: [],
  };
  const b = req.body || {};
  if (b.mode === 'json' || b.mode === 'text' || b.mode === 'xml') item.request.body = { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.mode === 'text' ? 'text' : b.mode } } };
  else if (b.mode === 'urlencoded') item.request.body = { mode: 'urlencoded', urlencoded: (b.urlencoded || []).map((r) => ({ key: r.key, value: r.value, disabled: r.enabled === false || undefined })) };
  else if (b.mode === 'formdata') item.request.body = { mode: 'formdata', formdata: (b.formdata || []).map((r) => (r.type === 'file' ? { key: r.key, type: 'file', src: r.value, disabled: r.enabled === false || undefined } : { key: r.key, value: r.value, type: 'text', disabled: r.enabled === false || undefined })) };
  const a = req.auth || {};
  if (a.type === 'bearer') item.request.auth = { type: 'bearer', bearer: [{ key: 'token', value: a.token || '', type: 'string' }] };
  else if (a.type === 'basic') item.request.auth = { type: 'basic', basic: [{ key: 'username', value: a.username || '', type: 'string' }, { key: 'password', value: a.password || '', type: 'string' }] };
  else if (a.type === 'apikey') item.request.auth = { type: 'apikey', apikey: [{ key: 'key', value: a.key || '', type: 'string' }, { key: 'value', value: a.value || '', type: 'string' }, { key: 'in', value: a.addTo === 'query' ? 'query' : 'header', type: 'string' }] };
  return item;
}

function collectionToPostman(collection, variables) {
  const conv = (items) => items.map((it) => (it.type === 'folder' ? { name: it.name, item: conv(it.items || []) } : requestToPostmanItem({ ...it.request, name: it.name })));
  return {
    info: { _postman_id: crypto.randomUUID(), name: collection.name, schema: POSTMAN_SCHEMA, description: 'Exported from Routinel' },
    item: conv(collection.items || []),
    variable: Object.entries(variables || {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

function postmanToCollection(json) {
  const col = typeof json === 'string' ? JSON.parse(json) : json;
  if (!col || !col.info || !Array.isArray(col.item)) throw new Error('Not a Postman v2.x collection (missing info/item).');
  const rows = (arr) => (arr || []).map((r) => ({ key: r.key || '', value: r.value !== undefined ? String(r.value) : r.src ? String(r.src) : '', description: typeof r.description === 'string' ? r.description : (r.description && r.description.content) || '', enabled: !r.disabled, type: r.type === 'file' ? 'file' : undefined }));
  const conv = (items) =>
    items.map((it) => {
      if (Array.isArray(it.item)) return { id: newId(), type: 'folder', name: it.name || 'Folder', items: conv(it.item) };
      const r = it.request || {};
      const req = emptyRequest(it.name);
      req.method = (r.method || 'GET').toUpperCase();
      if (typeof r.url === 'string') req.url = r.url.split('?')[0];
      else if (r.url) {
        req.url = (r.url.raw || '').split('?')[0];
        req.params = rows(r.url.query);
        req.pathVars = rows(r.url.variable).map((v) => ({ ...v, enabled: true }));
      }
      if (typeof r.url === 'string' && r.url.includes('?')) {
        for (const pair of r.url.split('?')[1].split('&')) {
          const [k, v = ''] = pair.split('=');
          if (k) req.params.push({ key: decodeURIComponent(k), value: decodeURIComponent(v), enabled: true });
        }
      }
      req.headers = rows(r.header);
      const b = r.body || {};
      if (b.mode === 'raw') {
        const lang = (b.options && b.options.raw && b.options.raw.language) || '';
        let mode = lang === 'xml' ? 'xml' : lang === 'json' ? 'json' : 'text';
        if (!lang) { try { JSON.parse(b.raw); mode = 'json'; } catch (e) { mode = 'text'; } }
        req.body = { mode, raw: b.raw || '', urlencoded: [], formdata: [] };
      } else if (b.mode === 'urlencoded') req.body = { mode: 'urlencoded', raw: '', urlencoded: rows(b.urlencoded), formdata: [] };
      else if (b.mode === 'formdata') req.body = { mode: 'formdata', raw: '', urlencoded: [], formdata: rows(b.formdata).map((x) => ({ ...x, type: x.type || 'text' })) };
      else if (b.mode === 'graphql' && b.graphql) req.body = { mode: 'json', raw: JSON.stringify({ query: b.graphql.query, variables: tryJson(b.graphql.variables) }, null, 2), urlencoded: [], formdata: [] };
      const a = r.auth || { type: 'inherit' };
      if (a.type === 'noauth') req.auth = { type: 'none' };
      const av = (list, key) => ((list || []).find((x) => x.key === key) || {}).value || '';
      if (a.type === 'bearer') req.auth = { type: 'bearer', token: av(a.bearer, 'token') };
      else if (a.type === 'basic') req.auth = { type: 'basic', username: av(a.basic, 'username'), password: av(a.basic, 'password') };
      else if (a.type === 'apikey') req.auth = { type: 'apikey', key: av(a.apikey, 'key'), value: av(a.apikey, 'value'), addTo: av(a.apikey, 'in') === 'query' ? 'query' : 'header' };
      return { id: newId(), type: 'request', name: it.name || req.method + ' ' + req.url, request: req };
    });
  const variables = {};
  for (const v of col.variable || []) if (v.key) variables[v.key] = v.value !== undefined ? String(v.value) : '';
  return { collection: { id: newId(), name: col.info.name || 'Imported', items: conv(col.item) }, variables };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (e) { return s || {}; }
}

// ------------------------------------------------------------------ OpenAPI 3 export
function endpointsToOpenApi(endpoints, title, serverUrl) {
  const paths = {};
  for (const ep of endpoints) {
    const p = ep.path.replace(/:(\w+)/g, '{$1}');
    paths[p] = paths[p] || {};
    const op = {
      summary: ep.summary || ep.handler || undefined,
      operationId: undefined,
      tags: ep.tags && ep.tags.length ? ep.tags : [ep.framework],
      parameters: ep.params.filter((x) => ['path', 'query', 'header', 'cookie'].includes(x.in)).map((x) => ({ name: x.name, in: x.in, required: x.in === 'path' ? true : !!x.required, description: x.description || undefined, schema: { type: oasType(x.type) } })),
      responses: { 200: { description: 'OK' } },
      'x-source': ep.fromSpec ? undefined : { file: ep.file, line: ep.line + 1, framework: ep.framework },
    };
    if (ep.body && ep.body.mode === 'json') op.requestBody = { content: { 'application/json': { example: ep.body.example } } };
    else if (ep.body && (ep.body.mode === 'urlencoded' || ep.body.mode === 'formdata')) {
      const props = {};
      for (const f of ep.params.filter((x) => x.in === 'form' || x.in === 'file')) props[f.name] = f.in === 'file' ? { type: 'string', format: 'binary' } : { type: oasType(f.type) };
      op.requestBody = { content: { [ep.body.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema: { type: 'object', properties: props } } } };
    }
    paths[p][ep.method.toLowerCase()] = op;
  }
  return { openapi: '3.0.3', info: { title: title || 'Discovered API', version: '1.0.0', description: 'Generated by Routinel from source code.' }, servers: serverUrl ? [{ url: serverUrl }] : [], paths };
}

function oasType(t) {
  const s = String(t || '').toLowerCase();
  if (/^(int|integer|long|short|i\d+|u\d+|int\d+|uint\d*|usize|biginteger)$/.test(s)) return 'integer';
  if (/^(float|double|decimal|number|f\d+|float\d+|bigdecimal)$/.test(s)) return 'number';
  if (/^(bool|boolean)$/.test(s)) return 'boolean';
  if (/^(list|array|\[\])|\[\]$|^vec</.test(s)) return 'array';
  return 'string';
}

module.exports = { newId, emptyRequest, endpointToRequest, generate, collectionToPostman, postmanToCollection, requestToPostmanItem, endpointsToOpenApi };

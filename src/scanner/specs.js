'use strict';
/**
 * Spec & config detectors:
 *  - OpenAPI 3.x / Swagger 2.0 documents (JSON or YAML)
 *  - Postman collections found in the workspace (*.postman_collection.json)
 *  - Spring Boot application.properties / application.yml (server.port, context-path)
 *  - ASP.NET launchSettings.json, .env files (PORT=)
 */
const U = require('./util');
let yaml = null;
try { yaml = require('js-yaml'); } catch (e) { yaml = null; }

function analyze(text, file, out) {
  const base = file.replace(/\\/g, '/').split('/').pop();
  if (/^application(-\w+)?\.(properties|ya?ml)$/.test(base) || /^bootstrap\.(properties|ya?ml)$/.test(base)) return springConfig(text, file, out);
  if (base === 'launchSettings.json') return launchSettings(text, file, out);
  if (/^\.env(\.\w+)?$/.test(base)) {
    const m = /^\s*PORT\s*=\s*(\d{2,5})/m.exec(text);
    if (m) out.hints.ports.push({ port: +m[1], source: file });
    return;
  }
  if (/^readme\.md$/i.test(base)) {
    const re = /(?:localhost|127\.0\.0\.1)(?:\*\*)?:(\d{2,5})|\bport\s*\**\s*(\d{4,5})\b/gi;
    let m;
    while ((m = re.exec(text))) out.hints.ports.push({ port: +(m[1] || m[2]), source: file });
    return;
  }
  if (/\.postman_collection\.json$/.test(base)) return postman(text, file, out);
  if (/\.(json|ya?ml)$/.test(base) && /["']?(openapi|swagger)["']?\s*:/.test(text.slice(0, 4000))) return openapi(text, file, out);
}

function parseDoc(text, file) {
  if (/\.json$/.test(file)) return JSON.parse(text);
  if (!yaml) throw new Error('js-yaml not available');
  return yaml.load(text);
}

function springConfig(text, file, out) {
  let port = null;
  let ctx = null;
  if (/\.properties$/.test(file)) {
    const p = /^\s*server\.port\s*[=:]\s*(?:\$\{[^:}]*:)?(\d{2,5})/m.exec(text);
    const c = /^\s*server\.(?:servlet\.)?context-path\s*[=:]\s*(\S+)/m.exec(text) || /^\s*spring\.webflux\.base-path\s*[=:]\s*(\S+)/m.exec(text);
    if (p) port = +p[1];
    if (c) ctx = c[1];
  } else {
    try {
      const docs = yaml ? yaml.loadAll(text) : [];
      for (const d of docs) {
        if (!d || typeof d !== 'object' || !d.server) continue;
        const sp = d.server.port;
        if (sp && !port) port = +String(sp).replace(/^\$\{[^:}]*:(\d+)\}$/, '$1') || null;
        const c = (d.server.servlet && d.server.servlet['context-path']) || d.server['context-path'];
        if (c && !ctx) ctx = c;
      }
    } catch (e) { /* ignore */ }
  }
  out.hints.ports.push(port ? { port, source: file, spring: true } : { port: 8080, source: 'default', weak: true, spring: true });
  if (ctx) out.hints.springContextPath = ctx;
}

function launchSettings(text, file, out) {
  try {
    const j = JSON.parse(text.replace(/^﻿/, ''));
    for (const prof of Object.values(j.profiles || {})) {
      for (const url of String(prof.applicationUrl || '').split(';')) {
        const m = /^(https?):\/\/[^:/]+:(\d+)/.exec(url.trim());
        if (m) out.hints.ports.push({ port: +m[2], scheme: m[1], source: file });
      }
    }
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ OpenAPI
function openapi(text, file, out) {
  let doc;
  try { doc = parseDoc(text, file); } catch (e) { return; }
  if (!doc || typeof doc !== 'object' || !doc.paths) return;
  const lineOf = U.makeLineIndex(text);
  const isV2 = !!doc.swagger;
  let basePath = '';
  if (isV2) {
    basePath = doc.basePath || '';
    if (doc.host) out.hints.servers.push(((doc.schemes && doc.schemes[0]) || 'http') + '://' + doc.host + basePath);
  } else if (Array.isArray(doc.servers) && doc.servers[0] && doc.servers[0].url) {
    const url = String(doc.servers[0].url).replace(/\{(\w+)\}/g, (m0, v) => ((doc.servers[0].variables || {})[v] || {}).default || m0);
    out.hints.servers.push(url);
    const pm = /^(?:https?:\/\/[^/]+)?(\/.*)$/.exec(url);
    if (pm && !/^https?:/.test(url)) basePath = pm[1];
  }
  const deref = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 20) return obj;
    if (obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
      const target = obj.$ref.slice(2).split('/').reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
      return deref(target, depth + 1) || {};
    }
    return obj;
  };
  for (const [p, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = (item.parameters || []).map((x) => deref(x));
    const keyIdx = Math.max(text.indexOf('"' + p + '"'), text.indexOf("'" + p + "'"), text.indexOf('\n  ' + p + ':'), text.indexOf(p + ':'));
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[method];
      if (!op) continue;
      const params = [];
      const all = [...shared, ...(op.parameters || []).map((x) => deref(x))];
      let body = null;
      let bodyMode;
      for (const prm of all) {
        if (!prm || !prm.in) continue;
        if (prm.in === 'body') {
          body = example(deref(prm.schema), deref, 0);
          continue;
        }
        const where = prm.in === 'formData' ? (prm.type === 'file' ? 'file' : 'form') : prm.in;
        const schema = deref(prm.schema) || prm;
        params.push({ name: prm.name, in: where, type: schema.format || schema.type || 'string', required: !!prm.required || prm.in === 'path', description: prm.description, example: prm.example !== undefined ? prm.example : schema.example !== undefined ? schema.example : schema.default, enum: schema.enum });
      }
      if (op.requestBody) {
        const rb = deref(op.requestBody);
        const content = rb.content || {};
        const jsonKey = Object.keys(content).find((k) => /json/.test(k));
        if (jsonKey) {
          const c = content[jsonKey];
          body = c.example !== undefined ? c.example : c.examples ? (deref(Object.values(c.examples)[0]) || {}).value : example(deref(c.schema), deref, 0);
          bodyMode = 'json';
        } else if (content['application/x-www-form-urlencoded'] || content['multipart/form-data']) {
          const multipart = !!content['multipart/form-data'];
          const schema = deref((content['multipart/form-data'] || content['application/x-www-form-urlencoded']).schema) || {};
          const req = schema.required || [];
          for (const [name, s0] of Object.entries(schema.properties || {})) {
            const s = deref(s0) || {};
            params.push({ name, in: s.format === 'binary' ? 'file' : 'form', type: s.type || 'string', required: req.includes(name) });
          }
          bodyMode = multipart ? 'formdata' : 'urlencoded';
        } else if (Object.keys(content).length) {
          bodyMode = 'text';
          body = '';
        }
      }
      out.routes.push({
        method: method.toUpperCase(),
        path: U.joinPaths(basePath, p),
        line: keyIdx >= 0 ? lineOf(keyIdx) : 0,
        framework: isV2 ? 'Swagger 2.0' : 'OpenAPI ' + (doc.openapi || '3'),
        keys: ['file:' + file],
        params,
        bodyExample: body,
        bodyMode,
        handler: op.operationId,
        summary: op.summary || op.description,
        tags: op.tags,
        spec: true,
      });
    }
  }
}

function example(schema, deref, depth) {
  if (!schema || depth > 6) return null;
  schema = deref(schema);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => example(s, deref, depth + 1) || {}));
  if (schema.oneOf || schema.anyOf) return example((schema.oneOf || schema.anyOf)[0], deref, depth + 1);
  const type = schema.type || (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'object': {
      const o = {};
      for (const [k, v] of Object.entries(schema.properties || {})) o[k] = example(v, deref, depth + 1);
      return o;
    }
    case 'array':
      return [example(schema.items || {}, deref, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'date') return '2024-01-01';
      if (schema.format === 'uuid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      if (schema.format === 'email') return 'user@example.com';
      return 'string';
  }
}

// ------------------------------------------------------------------ Postman collections in the repo
function postman(text, file, out) {
  let col;
  try { col = JSON.parse(text); } catch (e) { return; }
  const walk = (items, folder) => {
    for (const it of items || []) {
      if (it.item) { walk(it.item, folder ? folder + '/' + it.name : it.name); continue; }
      const r = it.request;
      if (!r) continue;
      const raw = typeof r.url === 'string' ? r.url : (r.url && r.url.raw) || '';
      const p = raw.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/';
      const params = [];
      if (r.url && r.url.query) for (const q of r.url.query) params.push({ name: q.key, in: 'query', type: 'string', required: !q.disabled, example: q.value });
      for (const h of r.header || []) params.push({ name: h.key, in: 'header', type: 'string', required: !h.disabled, example: h.value });
      let body;
      if (r.body && r.body.mode === 'raw') { try { body = JSON.parse(r.body.raw); } catch (e) { body = r.body.raw; } }
      out.routes.push({ method: (r.method || 'GET').toUpperCase(), path: p, line: 0, framework: 'Postman', keys: ['file:' + file], params, bodyExample: body, handler: (folder ? folder + '/' : '') + it.name, spec: true });
    }
  };
  walk(col.item, '');
}

module.exports = { analyze };

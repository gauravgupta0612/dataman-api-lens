'use strict';
/**
 * Mock API server: serves every discovered endpoint locally so front-end / integration work can start
 * before the real backend runs.
 *
 * Response for a request, in priority order:
 *   1. a saved mock (".routinel/mocks.json", or "Save as mock" from a real response) — supports templates
 *      {{params.id}} {{query.page}} {{body.name}} {{headers.x-tenant}} {{$guid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}}
 *   2. the response example documented in OpenAPI / Swagger
 *   3. a generated response built from the endpoint's request models (POST → 201 + id, GET item / list, DELETE → 204 ...)
 * Pure Node (no VS Code dependency) so it is unit-testable.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

function compile(endpoints) {
  const routes = [];
  for (const e of endpoints) {
    const names = [];
    const src = e.path
      .replace(/\/+$/, '')
      .split('/')
      .map((seg) => {
        if (/^:\w+$/.test(seg)) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        if (/^<.*>$/.test(seg)) {
          names.push(seg.slice(1, -1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ ep: e, names, re: new RegExp('^' + (src || '') + '/?$', 'i'), score: names.length });
  }
  routes.sort((a, b) => a.score - b.score || b.ep.path.length - a.ep.path.length);
  return routes;
}

function match(routes, method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  let pathOnly = null;
  for (const r of routes) {
    const hit = r.re.exec(pathname);
    if (!hit) continue;
    const params = {};
    r.names.forEach((n, i) => {
      try { params[n] = decodeURIComponent(hit[i + 1]); } catch (e) { params[n] = hit[i + 1]; }
    });
    if (r.ep.method === m) return { ep: r.ep, params };
    if (!pathOnly) pathOnly = { ep: r.ep, params };
  }
  return pathOnly ? { ep: null, params: pathOnly.params, allowedFor: pathOnly.ep.path } : null;
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Item shape for a resource path: taken from a POST/PUT body example of the same or the collection path. */
function itemShape(ep, endpoints) {
  const coll = ep.path.replace(/\/:\w+\/?$/, '');
  const item = /\/:\w+\/?$/.test(ep.path) ? ep.path : null;
  const candidates = endpoints.filter((x) => x.body && isObj(x.body.example) && Object.keys(x.body.example).length && ['POST', 'PUT', 'PATCH'].includes(x.method) && (x.path === ep.path || x.path === coll || (item && x.path === item)));
  const pick = candidates.find((x) => x.method === 'PUT') || candidates.find((x) => x.method === 'POST') || candidates[0];
  if (pick) return JSON.parse(JSON.stringify(pick.body.example));
  const spec = endpoints.find((x) => x.method === 'GET' && (x.path === item || x.path === ep.path) && x.response && x.response.example !== undefined);
  if (spec) return Array.isArray(spec.response.example) ? spec.response.example[0] : spec.response.example;
  return null;
}

function idKey(ep) {
  const m = /\/:(\w+)\/?$/.exec(ep.path);
  return m ? m[1] : null;
}

/** Example response used by the mock server and the documentation (no request context needed). */
function exampleResponse(ep, endpoints, ctx = {}) {
  if (ep.response && (ep.response.example !== undefined || ep.response.status)) {
    return { status: ep.response.status || 200, body: ep.response.example === undefined ? null : ep.response.example, source: 'spec', contentType: ep.response.contentType };
  }
  const params = ctx.params || {};
  const reqBody = ctx.body;
  const shape = itemShape(ep, endpoints || []);
  const key = idKey(ep);
  const withId = (obj, id) => (isObj(obj) ? { id: id !== undefined ? numeric(id) : 1, ...obj } : obj);
  switch (ep.method) {
    case 'DELETE':
      return { status: 204, body: null, source: 'generated' };
    case 'POST': {
      const base = isObj(reqBody) ? reqBody : shape || (ep.body && ep.body.example !== undefined ? ep.body.example : {});
      return { status: 201, body: isObj(base) ? { id: 1, ...base, createdAt: '2024-01-01T00:00:00Z' } : base, source: 'generated' };
    }
    case 'PUT':
    case 'PATCH': {
      const base = isObj(reqBody) ? reqBody : shape || {};
      return { status: 200, body: isObj(base) ? { ...(key ? { id: numeric(params[key] || 1) } : {}), ...base, updatedAt: '2024-01-01T00:00:00Z' } : base, source: 'generated' };
    }
    default: {
      if (key) {
        const obj = shape ? withId(shape, params[key]) : { [key]: params[key] || 1, name: 'Sample ' + lastSegment(ep.path) };
        return { status: 200, body: obj, source: 'generated' };
      }
      if (shape) return { status: 200, body: [withId(shape, 1), withId(JSON.parse(JSON.stringify(shape)), 2)], source: 'generated' };
      const plural = /s$/.test(lastSegment(ep.path));
      return { status: 200, body: plural ? [{ id: 1, name: 'Sample 1' }, { id: 2, name: 'Sample 2' }] : { message: 'Mock response for ' + ep.method + ' ' + ep.path }, source: 'generated' };
    }
  }
}

function lastSegment(p) {
  const segs = p.split('/').filter((s) => s && !s.startsWith(':'));
  return segs[segs.length - 1] || 'item';
}

function numeric(v) {
  return /^\d+$/.test(String(v)) ? Number(v) : v;
}

function renderTemplate(value, ctx) {
  const lookup = (expr) => {
    const name = expr.trim();
    switch (name) {
      case '$guid':
      case '$uuid':
        return crypto.randomUUID();
      case '$timestamp':
        return String(Math.floor(Date.now() / 1000));
      case '$isoTimestamp':
        return new Date().toISOString();
      case '$randomInt':
        return String(Math.floor(Math.random() * 1000));
      default: {
        const [root, ...rest] = name.split('.');
        let cur = { params: ctx.params, query: ctx.query, body: ctx.body, headers: ctx.headers }[root];
        for (const k of rest) cur = cur === undefined || cur === null ? undefined : cur[root === 'headers' ? k.toLowerCase() : k];
        return cur === undefined ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
      }
    }
  };
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = /^\{\{\s*([^}]+)\s*\}\}$/.exec(v);
      if (whole) {
        const out = lookup(whole[1]);
        return /^-?\d+(\.\d+)?$/.test(out) && !/^0\d/.test(out) ? Number(out) : out;
      }
      return v.replace(/\{\{\s*([^}]+)\s*\}\}/g, (m, e) => lookup(e));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

class MockServer {
  /** opts: { getEndpoints(): endpoint[], getMocks(): {"GET /path": mock}, log(line), delayMs } */
  constructor(opts) {
    this.opts = opts;
    this.server = null;
    this.port = null;
    this.hits = 0;
  }

  get running() {
    return !!this.server;
  }

  start(port = 4010, host = '127.0.0.1') {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, 500, { error: String(e && e.message ? e.message : e) }, {}, 'error')));
      server.on('error', (e) => {
        this.server = null;
        reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use — change "routinel.mock.port"`) : e);
      });
      server.listen(port, host, () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  send(res, status, body, headers, source, contentType) {
    const h = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
      'Access-Control-Expose-Headers': '*',
      'X-Routinel-Mock': source || 'generated',
      ...(headers || {}),
    };
    let payload = '';
    if (body !== null && body !== undefined && status !== 204) {
      if (typeof body === 'string' && !/json/.test(contentType || '')) {
        payload = body;
        if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = contentType || 'text/plain; charset=utf-8';
      } else {
        payload = JSON.stringify(body, null, 2);
        if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json; charset=utf-8';
      }
    }
    res.writeHead(status, h);
    res.end(payload);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const started = Date.now();
    const raw = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    if (req.method === 'OPTIONS') return this.send(res, 204, null, {}, 'cors');
    let body = raw;
    if (raw && /json/.test(req.headers['content-type'] || '')) {
      try { body = JSON.parse(raw); } catch (e) { body = raw; }
    } else if (raw && /x-www-form-urlencoded/.test(req.headers['content-type'] || '')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const endpoints = this.opts.getEndpoints();
    const routes = compile(endpoints);
    const pathname = decodeURI(url.pathname);
    const found = match(routes, req.method, pathname);
    const query = Object.fromEntries(url.searchParams);
    const log = (status, source) => this.opts.log && this.opts.log(`${req.method} ${url.pathname}${url.search} → ${status} (${source}, ${Date.now() - started} ms)`);
    this.hits++;
    if (!found) {
      log(404, 'no route');
      return this.send(res, 404, { error: 'No discovered API matches ' + req.method + ' ' + pathname, hint: 'Routinel mock serves only the endpoints found in the selected source.' }, {}, 'none');
    }
    if (!found.ep) {
      log(405, 'method');
      return this.send(res, 405, { error: `Method ${req.method} is not defined for ${found.allowedFor}` }, {}, 'none');
    }
    const ep = found.ep;
    const ctx = { params: found.params, query, body, headers: req.headers };
    const mocks = (this.opts.getMocks && this.opts.getMocks()) || {};
    const saved = mocks[ep.method + ' ' + ep.path];
    const delay = saved && saved.delayMs !== undefined ? saved.delayMs : this.opts.delayMs || 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (saved) {
      let b = saved.body;
      if (typeof b === 'string' && /json/.test(saved.contentType || 'application/json')) {
        try { b = JSON.parse(b); } catch (e) { /* keep text */ }
      }
      const status = saved.status || 200;
      log(status, 'saved mock');
      return this.send(res, status, renderTemplate(b, ctx), saved.headers, 'saved', saved.contentType);
    }
    const ex = exampleResponse(ep, endpoints, ctx);
    log(ex.status, ex.source);
    return this.send(res, ex.status, req.method === 'HEAD' ? null : ex.body, {}, ex.source, ex.contentType);
  }
}

module.exports = { MockServer, exampleResponse, renderTemplate, compile, match };

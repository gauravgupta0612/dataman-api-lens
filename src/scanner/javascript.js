'use strict';
/**
 * JavaScript / TypeScript detectors:
 *  Express, Koa-router, Fastify, Hono, Elysia, Restify (obj.get('/x', handler))
 *  Express route chains (router.route('/x').get().post())
 *  Fastify route objects (fastify.route({ method, url }))
 *  NestJS controllers (@Controller + @Get/@Post ...)
 *  Next.js App Router (app/**\/route.ts) and Pages API routes (pages/api/**)
 */
const path = require('path');
const U = require('./util');

const CLIENT_OBJECTS = new Set([
  'axios', 'http', 'https', '$http', 'httpClient', 'HttpClient', 'client', 'api', 'apiClient', 'instance', 'request',
  'got', 'ky', 'superagent', 'supertest', 'agent', 'fetch', '$', 'jQuery', 'cy', 'page', 'browser', 'map', 'Map', 'cache',
  'store', 'params', 'searchParams', 'headers', 'localStorage', 'sessionStorage', 'redis', 'db', 'knex', 'Reflect',
  'formData', 'url', 'URL', 'config', 'cookies', 'res', 'response', 'this', 'mock', 'nock', 'fetchMock', 'service', '_',
]);

const ROUTE_METHODS = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', del: 'DELETE', head: 'HEAD', options: 'OPTIONS', all: 'GET' };

function analyze(text, file, out, ctx) {
  const src = U.stripComments(text, 'c');
  const lineOf = U.makeLineIndex(src);
  const imports = collectImports(src, file, ctx);
  const ownerPrefix = collectOwnerPrefixes(src);

  // ---- functions index (for handler references like userController.getUser) ----
  const fnRe = [
    /\bfunction\s+(\w+)\s*\([^)]*\)[^{]*/g,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\()?\s*(?:async\s*)?(?:function\b\s*\w*\s*)?\([^)]*\)\s*(?::\s*[^={]+)?(?:=>\s*)?/g,
    /\b(?:exports|module\.exports)\.(\w+)\s*=\s*(?:\w+\()?\s*(?:async\s*)?(?:function\b\s*\w*\s*)?\([^)]*\)\s*(?:=>\s*)?/g,
    /^[ \t]*(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?(?=\{)/gm,
  ];
  for (const re of fnRe) {
    for (const r of U.functionRanges(src, re)) {
      if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(r.name)) continue;
      if (!out.functions[r.name]) out.functions[r.name] = r.body;
    }
  }

  // ---- models: TS classes / interfaces / type literals / zod schemas ----
  collectTsModels(src, out);

  // ---- hints ----
  let m;
  const portRes = [/\.listen\(\s*(\d{2,5})\b/g, /\bPORT\b\s*(?:\|\||\?\?|=)\s*['"]?(\d{2,5})\b/g, /\bport\s*:\s*(\d{2,5})\b/g];
  for (const re of portRes) while ((m = re.exec(src))) out.hints.ports.push({ port: +m[1], source: file });
  const cst = /\b(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*['"`](\/[^'"`$]*)['"`]/g;
  while ((m = cst.exec(src))) out.hints.constants = Object.assign(out.hints.constants || {}, { [m[1]]: m[2] });
  const gp = /setGlobalPrefix\(\s*['"`]([^'"`]+)['"`]/.exec(src);
  if (gp) out.hints.nestGlobalPrefix = gp[1];

  // ---- mounts: app.use('/api', router) / app.route('/api', honoApp) / fastify.register(plugin, { prefix }) ----
  const useRe = /\.\s*(use|route|mount)\s*\(/g;
  while ((m = useRe.exec(src))) {
    const open = m.index + m[0].length - 1;
    const b = U.readBalanced(src, open);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (!args.length) continue;
    let prefix = U.firstString(args[0]);
    let prefixRef;
    if (prefix === null && args.length >= 2 && /^(?:[\w$]+\.)*[A-Z_][A-Z0-9_]*$/.test(args[0].trim())) { prefixRef = args[0].trim().split('.').pop(); prefix = ''; }
    if (prefix !== null && (prefix.includes('${') || args.length < 2)) continue;
    const from = chainOwner(src, m.index, file);
    const candidates = prefix !== null ? [args[args.length - 1]] : args.filter((x) => /^[A-Za-z_$][\w$]*$/.test(x.trim()));
    for (const c of candidates) {
      const target = mountTarget(c, imports, file, ctx);
      if (target) out.mounts.push({ target, prefix: prefix || '', prefixRef, from });
    }
  }
  const regRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*register\s*\(/g;
  while ((m = regRe.exec(src))) {
    const open = src.indexOf('(', m.index + m[1].length);
    const b = U.readBalanced(src, open);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (args.length < 2) continue;
    const prefix = U.namedArg(args[1], 'prefix');
    if (prefix === null) continue;
    const target = mountTarget(args[0], imports, file, ctx);
    if (target) out.mounts.push({ target, prefix, from: ownerKeys(file, m[1]) });
  }

  // ---- obj.get('/path', handler) ----
  const routeRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|head|options|all)\s*\(/g;
  while ((m = routeRe.exec(src))) {
    const owner = m[1];
    if (CLIENT_OBJECTS.has(owner)) continue;
    const open = m.index + m[0].length - 1;
    const b = U.readBalanced(src, open);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (args.length < 2) continue;
    let p = U.firstString(args[0]);
    let handlerArgs = args.slice(1);
    if (p !== null && !p.startsWith('/') && args.length >= 3 && U.firstString(args[1]) !== null) {
      // koa-router named route: router.get('name', '/path', handler)
      p = U.firstString(args[1]);
      handlerArgs = args.slice(2);
    }
    if (p === null || p.includes('${')) continue;
    if (!(p.startsWith('/') || p === '*' || p === '')) continue;
    if (/^https?:/.test(p)) continue;
    const handler = handlerArgs[handlerArgs.length - 1];
    if (!handler || /^\{[\s\S]*\}$/.test(handler.trim())) continue; // object as last arg => client call (axios style)
    const framework = detectFramework(src, owner);
    const r = makeRoute(ROUTE_METHODS[m[2]], joinOwner(ownerPrefix, owner, p), lineOf(m.index), framework, owner, file, handler);
    if (r.block && handlerArgs.length > 1) r.block = handlerArgs.join(',\n');
    out.routes.push(r);
  }

  // ---- router.route('/x').get(h).post(h) ----
  const chainRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"`])([^'"`$]+)\2\s*\)/g;
  while ((m = chainRe.exec(src))) {
    let i = m.index + m[0].length;
    for (;;) {
      const cm = /^\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(/.exec(src.slice(i, i + 200));
      if (!cm) break;
      const open = i + cm[0].length - 1;
      const b = U.readBalanced(src, open);
      if (!b) break;
      const args = U.splitTopLevel(b.inner);
      const r = makeRoute(ROUTE_METHODS[cm[1]], joinOwner(ownerPrefix, m[1], m[3]), lineOf(i + cm.index + cm[0].indexOf('.')), detectFramework(src, m[1]), m[1], file, args[args.length - 1]);
      if (r.block) r.block = args.join(',\n');
      out.routes.push(r);
      i = b.end + 1;
    }
  }

  // ---- fastify.route({ method: 'GET', url: '/x', handler }) ----
  const objRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*\{/g;
  while ((m = objRe.exec(src))) {
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace);
    if (!b) continue;
    const url = U.namedArg(b.inner, ['url', 'path']);
    if (url === null) continue;
    let methods = U.methodsFrom(U.namedArray(b.inner, 'method') || '');
    if (!methods.length) methods = ['GET'];
    const h = /handler\s*:\s*([\s\S]*)$/.exec(b.inner);
    for (const meth of methods) out.routes.push(makeRoute(meth, joinOwner(ownerPrefix, m[1], url), lineOf(m.index), 'Fastify', m[1], file, h ? h[1] : null));
  }

  // ---- NestJS ----
  analyzeNest(src, file, out, lineOf);

  // ---- Next.js ----
  analyzeNext(src, file, out, lineOf);
}

function makeRoute(method, p, line, framework, owner, file, handler) {
  const r = { method, path: p, line, framework, keys: ownerKeys(file, owner) };
  if (handler) {
    const h = handler.trim();
    const ref = /^(?:[\w$]+\.)*([\w$]+)$/.exec(h);
    if (ref) r.handlerRef = ref[1];
    else {
      const wrapped = /^[\w$.]+\(\s*([\w$.]+)\s*\)$/.exec(h); // asyncHandler(getUser)
      if (wrapped) r.handlerRef = wrapped[1].split('.').pop();
      else r.block = h;
    }
  }
  return r;
}

/** Who owns a (possibly chained) call: const api = Router().use(...).use(...)  /  export default Router().use(...)  /  app.use(...) */
function chainOwner(src, idx, file) {
  let ls = src.lastIndexOf('\n', idx - 1) + 1;
  // walk up continuation lines that start with '.'
  while (ls > 0 && /^\s*\./.test(src.slice(ls, idx + 1))) ls = src.lastIndexOf('\n', ls - 2) + 1;
  const head = src.slice(ls, idx);
  let m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/.exec(head);
  if (m) return ownerKeys(file, m[1]);
  if (/^\s*(?:export\s+default|module\.exports\s*=)/.test(head)) return ['file:' + file];
  m = /([A-Za-z_$][\w$]*)\s*$/.exec(head) || /^\s*([A-Za-z_$][\w$]*)\s*\./.exec(head);
  return m ? ownerKeys(file, m[1]) : ['file:' + file];
}

function ownerKeys(file, owner) {
  return ['jsvar:' + file + ':' + owner, 'file:' + file];
}

function joinOwner(ownerPrefix, owner, p) {
  return ownerPrefix[owner] ? U.joinPaths(ownerPrefix[owner], p) : p;
}

function detectFramework(src, owner) {
  if (/from\s+['"]hono['"]|require\(['"]hono['"]\)/.test(src)) return 'Hono';
  if (/from\s+['"]elysia['"]/.test(src)) return 'Elysia';
  if (/fastify/i.test(src) && /fastify|server|app/i.test(owner)) return 'Fastify';
  if (/koa-router|@koa\/router/.test(src)) return 'Koa';
  if (/restify/.test(src)) return 'Restify';
  return 'Express';
}

function collectOwnerPrefixes(src) {
  const res = {};
  let m;
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Router|KoaRouter|Elysia|Hono)\s*\(\s*\{([^}]*)\}/g;
  while ((m = re.exec(src))) {
    const p = U.namedArg(m[2], ['prefix']);
    if (p) res[m[1]] = p;
  }
  const re2 = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+Hono\s*\([^)]*\)\s*\.basePath\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = re2.exec(src))) res[m[1]] = m[2];
  const re3 = /\b(\w+)\.prefix\(\s*['"`]([^'"`]+)['"`]\s*\)/g; // koa-router router.prefix('/api')
  while ((m = re3.exec(src))) res[m[1]] = m[2];
  return res;
}

function collectImports(src, file, ctx) {
  const map = {};
  let m;
  const add = (name, source) => {
    if (!name) return;
    map[name.trim()] = source;
  };
  const re1 = /\bimport\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?(?:\*\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = re1.exec(src))) {
    add(m[1], m[4]);
    add(m[3], m[4]);
    if (m[2]) for (const part of m[2].split(',')) add(part.split(/\s+as\s+/).pop(), m[4]);
  }
  const re2 = /\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(src))) add(m[1], m[2]);
  const re3 = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re3.exec(src))) for (const part of m[1].split(',')) add(part.split(':').pop(), m[2]);
  // resolve to files
  const resolved = {};
  for (const [name, source] of Object.entries(map)) {
    if (!source.startsWith('.')) continue;
    const f = resolveModule(file, source, ctx);
    if (f) resolved[name] = f;
  }
  return resolved;
}

function resolveModule(fromFile, source, ctx) {
  const base = path.resolve(path.dirname(fromFile), source);
  const exts = ['', '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js', '/index.mjs'];
  const files = (ctx && ctx.fileSet) || new Set();
  for (const e of exts) {
    const cand = base.replace(/\.(js|mjs|cjs)$/, '') + e;
    if (files.has(cand)) return cand;
    if (files.has(base + e)) return base + e;
  }
  return null;
}

function mountTarget(arg, imports, file, ctx) {
  const a = arg.trim();
  let m = /^require\(\s*['"]([^'"]+)['"]\s*\)(?:\.\w+)*$/.exec(a);
  if (m) {
    if (!m[1].startsWith('.')) return null;
    const f = resolveModule(file, m[1], ctx);
    return f ? 'file:' + f : null;
  }
  m = /^(\w+)(?:\.(?:routes|router)\(\))?(?:\.\w+)?$/.exec(a);
  if (!m) return null;
  if (imports[m[1]]) return 'file:' + imports[m[1]];
  return 'jsvar:' + file + ':' + m[1];
}

// ------------------------------------------------------------------ NestJS
function analyzeNest(src, file, out, lineOf) {
  if (!/@Controller\s*\(/.test(src)) return;
  const controllers = [];
  let m;
  const cre = /@Controller\s*\(([^)]*)\)/g;
  while ((m = cre.exec(src))) {
    let p = U.firstString(m[1]);
    if (p === null) p = U.namedArg(m[1], 'path') || '';
    controllers.push({ idx: m.index, prefix: p });
  }
  const mre = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(([^)]*)\)/g;
  while ((m = mre.exec(src))) {
    const ctrl = controllers.filter((c) => c.idx < m.index).pop();
    if (!ctrl) continue;
    const sub = U.firstString(m[2]) || '';
    const method = m[1] === 'All' ? 'GET' : m[1].toUpperCase();
    // method signature
    const sig = findSignature(src, m.index + m[0].length);
    const params = sig ? nestParams(sig.inner) : [];
    out.routes.push({
      method,
      path: U.joinPaths(ctrl.prefix, sub),
      line: lineOf(m.index),
      framework: 'NestJS',
      prefixKind: 'nest',
      keys: ['file:' + file],
      params,
      block: sig ? src.slice(sig.end, Math.min(src.length, sig.end + 3000)) : null,
      handler: sig ? sig.name : undefined,
    });
  }
}

/** After decorators, find  name(params) {  and return the balanced param list. */
function findSignature(src, from) {
  const re = /(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\(/y;
  // skip whitespace
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  re.lastIndex = i;
  const m = re.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const b = U.readBalanced(src, open);
  if (!b) return null;
  return { name: m[1], inner: b.inner, end: b.end };
}

function nestParams(sig) {
  const res = [];
  for (const part of U.splitTopLevel(sig)) {
    const d = /@(Param|Query|Body|Headers|UploadedFile|UploadedFiles|Req|Res|Request|Response|Next|Ip|Session|HostParam)\s*\(([^)]*)\)/.exec(part);
    if (!d) continue;
    const key = U.firstString(d[2]);
    const decl = /(\w+)\s*(\?)?\s*:\s*([^=]+)(?:=.*)?$/.exec(part.replace(d[0], '').trim());
    const pname = decl ? decl[1] : null;
    const type = decl ? decl[3].trim() : 'string';
    const optional = !!(decl && decl[2]) || /=/.test(part.replace(d[0], ''));
    switch (d[1]) {
      case 'Param':
        if (key) res.push({ name: key, in: 'path', type, required: true });
        break;
      case 'Query':
        if (key) res.push({ name: key, in: 'query', type, required: !optional });
        else res.push({ name: pname, in: 'query', model: type, type });
        break;
      case 'Body':
        if (key) res.push({ name: key, in: 'body', type, required: !optional });
        else res.push({ name: pname, in: 'body', model: type, type });
        break;
      case 'Headers':
        if (key) res.push({ name: key, in: 'header', type: 'string', required: !optional });
        break;
      case 'UploadedFile':
      case 'UploadedFiles':
        res.push({ name: key || pname || 'file', in: 'file', type: 'file', required: true });
        break;
      default:
        break;
    }
  }
  return res;
}

// ------------------------------------------------------------------ Next.js
function analyzeNext(src, file, out, lineOf) {
  const norm = file.replace(/\\/g, '/');
  let m = /\/(?:src\/)?app\/(.*?)\/?route\.(?:js|ts|jsx|tsx|mjs)$/.exec(norm);
  if (m && /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(src)) {
    const segs = m[1]
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_'))
      .map(nextSeg);
    const p = U.joinPaths(...segs);
    const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    let e;
    while ((e = re.exec(src))) {
      const paren = src.indexOf('(', e.index);
      const sig = paren !== -1 ? U.readBalanced(src, paren) : null;
      const brace = sig ? src.indexOf('{', sig.end) : -1;
      const b = brace !== -1 ? U.readBalanced(src, brace) : null;
      out.routes.push({ method: e[1], path: p, line: lineOf(e.index), framework: 'Next.js', keys: ['file:' + file], block: b ? b.inner : null });
    }
    return;
  }
  m = /\/(?:src\/)?pages\/(api\/.*)\.(?:js|ts|jsx|tsx)$/.exec(norm);
  if (m && /export\s+default/.test(src)) {
    const segs = m[1].split('/').map(nextSeg);
    if (segs[segs.length - 1] === 'index') segs.pop();
    const p = U.joinPaths(...segs);
    let methods = [];
    const re = /\.method\s*===?\s*['"](\w+)['"]|case\s+['"](GET|POST|PUT|PATCH|DELETE)['"]/g;
    let e;
    while ((e = re.exec(src))) {
      const meth = (e[1] || e[2]).toUpperCase();
      if (!methods.includes(meth)) methods.push(meth);
    }
    if (!methods.length) methods = ['GET'];
    const d = /export\s+default/.exec(src);
    for (const meth of methods) out.routes.push({ method: meth, path: p, line: lineOf(d.index), framework: 'Next.js', keys: ['file:' + file], block: src });
  }
}

function nextSeg(s) {
  let m = /^\[\[?\.\.\.(\w+)\]?\]$/.exec(s);
  if (m) return ':' + m[1];
  m = /^\[(\w+)\]$/.exec(s);
  if (m) return ':' + m[1];
  return s;
}

// ------------------------------------------------------------------ models
function collectTsModels(src, out) {
  let m;
  const re = /\b(?:export\s+)?(?:abstract\s+)?(class|interface)\s+(\w+)([^{;]*)\{/g;
  while ((m = re.exec(src))) {
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace);
    if (!b) continue;
    const fields = tsFields(b.inner);
    const ext = /extends\s+([\w\s,<>]+?)(?:\s+implements|$)/.exec(m[3]);
    const bases = ext ? ext[1].split(',').map((s) => s.trim().replace(/<.*$/, '')).filter(Boolean) : [];
    if ((fields.length || bases.length) && !out.models[m[2]]) out.models[m[2]] = { lang: 'ts', fields, bases };
  }
  const tre = /\btype\s+(\w+)\s*=\s*\{/g;
  while ((m = tre.exec(src))) {
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace);
    if (!b) continue;
    const fields = tsFields(b.inner);
    if (fields.length && !out.models[m[1]]) out.models[m[1]] = { lang: 'ts', fields };
  }
  const ere = /\benum\s+(\w+)\s*\{([^}]*)\}/g;
  while ((m = ere.exec(src))) {
    const vals = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const v = /=\s*['"]([^'"]+)['"]/.exec(s);
      return v ? v[1] : s.split('=')[0].trim();
    });
    out.models[m[1]] = { lang: 'ts', fields: [], enumValues: vals };
  }
  // zod: const CreateUser = z.object({ ... })
  const zre = /\b(?:const|let|var)\s+(\w+)\s*=\s*z\s*\.\s*object\s*\(\s*\{/g;
  while ((m = zre.exec(src))) {
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace);
    if (!b) continue;
    const fields = [];
    for (const part of U.splitTopLevel(b.inner)) {
      const f = /^(\w+)\s*:\s*z\s*\.\s*(\w+)/.exec(part);
      if (!f) continue;
      const zt = { string: 'string', number: 'number', boolean: 'boolean', date: 'date', array: 'string[]', object: 'object', enum: 'string' }[f[2]] || 'string';
      fields.push({ name: f[1], type: zt, required: !/\.optional\(\)|\.nullish\(\)|\.default\(/.test(part) });
    }
    if (fields.length) out.models[m[1]] = { lang: 'ts', fields };
  }
}

function tsFields(body) {
  const fields = [];
  let decorators = '';
  for (const raw of body.split(/[\n;]/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@')) {
      decorators += line;
      // decorator + field on the same line
      const rest = line.replace(/^(@\w+(?:\([^)]*\))?\s*)+/, '');
      if (!rest) continue;
      const f = fieldFrom(rest, decorators);
      if (f) fields.push(f);
      decorators = '';
      continue;
    }
    const f = fieldFrom(line, decorators);
    decorators = '';
    if (f) fields.push(f);
  }
  return fields;
}

function fieldFrom(line, decorators) {
  if (/^(constructor|get |set |static |async |return|if\b)/.test(line)) return null;
  const f = /^(?:public\s+|private\s+|protected\s+|readonly\s+|declare\s+)*(\w+)\s*(\?)?\s*!?\s*:\s*([^=;{(]+)/.exec(line);
  if (!f) return null;
  if (/^\s*\(/.test(line.slice(f[1].length))) return null;
  return { name: f[1], type: f[3].trim().replace(/,$/, ''), required: !f[2] && !/IsOptional/.test(decorators || '') };
}

// ------------------------------------------------------------------ params
function extractParams(block, route) {
  if (!block) return [];
  const res = [];
  const add = (name, where) => {
    if (!name || /^\d/.test(name)) return;
    const inMap = { query: 'query', body: 'body', params: 'path', headers: 'header', cookies: 'cookie', param: 'path', header: 'header', json: 'body', form: 'form' };
    const w = inMap[where] || where;
    if (!res.find((p) => p.name === name && p.in === w)) res.push({ name, in: w, type: 'string', required: w === 'path' });
  };
  let m;
  const base = '(?:req|request|ctx\\.request|ctx|context|c\\.req|event)';
  const dotRe = new RegExp('\\b' + base + '\\s*\\.\\s*(query|body|params|headers|cookies)\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)(?:\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*))?', 'g');
  const JS_MEMBERS = /^(length|map|filter|forEach|toString|trim|split|includes|some|every|find|toLowerCase|toUpperCase|replace|slice|join|push|then|valueOf)$/;
  while ((m = dotRe.exec(block))) add(m[1] === 'body' && m[3] && !JS_MEMBERS.test(m[3]) ? m[2] + '.' + m[3] : m[2], m[1]);
  const brRe = new RegExp('\\b' + base + '\\s*\\.\\s*(query|body|params|headers|cookies)\\s*(?:\\?\\.)?\\[\\s*[\'"`]([^\'"`]+)[\'"`]\\s*\\]', 'g');
  while ((m = brRe.exec(block))) add(m[2], m[1]);
  const destRe = new RegExp('\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*(?::[^=]+)?=\\s*(?:await\\s+)?' + base + '\\s*\\.\\s*(query|body|params|headers)', 'g');
  while ((m = destRe.exec(block))) {
    for (const part of m[1].split(',')) {
      const name = part.split(/[:=]/)[0].replace('...', '').trim();
      if (name && !part.includes('...')) add(name, m[2]);
    }
  }
  const getRe = /\b(?:req|request|ctx)\s*\.\s*(?:get|header)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = getRe.exec(block))) add(m[1], 'header');
  // Hono: c.req.query('x'), c.req.param('id'), c.req.header('x')
  const honoRe = /\bc\.req\.(query|param|header|queries)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = honoRe.exec(block))) add(m[2], m[1] === 'queries' ? 'query' : m[1]);
  // URL search params (Next.js): searchParams.get('x')
  const spRe = /searchParams\s*\.\s*get\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = spRe.exec(block))) add(m[1], 'query');
  // body as a whole
  if (/\b(?:req|request|ctx\.request)\s*\.\s*body\b|\bc\.req\.(?:json|parseBody)\s*\(|\brequest\.json\s*\(/.test(block) && !res.some((p) => p.in === 'body')) {
    res.push({ name: '__body__', in: 'body', type: 'object', required: false, wholeBody: true });
  }
  if (/\breq\s*\.\s*files?\b|upload\.(single|array|fields)\s*\(/.test(block)) res.push({ name: 'file', in: 'file', type: 'file', required: false });
  return res;
}

module.exports = { analyze, extractParams, resolveModule };

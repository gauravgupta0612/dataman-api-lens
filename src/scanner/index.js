'use strict';
/**
 * Routinel — scanner entry point.
 *
 * Phase 1  analyzeFile(file, text)  -> per-file analysis (routes, models, functions, mounts, hints). Cacheable.
 * Phase 2  resolve(analyses)        -> fully resolved endpoints with prefixes, parameters and sample bodies.
 *
 * Pure Node: no VS Code dependency, so it can be unit-tested and reused from a CLI.
 */
const U = require('./util');
const js = require('./javascript');
const py = require('./python');
const jvm = require('./jvm');
const dotnet = require('./dotnet');
const go = require('./golang');
const php = require('./php');
const ruby = require('./ruby');
const rust = require('./rust');
const specs = require('./specs');

const LANGS = [
  { id: 'javascript', label: 'JavaScript/TypeScript', re: /\.(?:m?[jt]sx?|cjs|mts|cts)$/i, mod: js },
  { id: 'python', label: 'Python', re: /\.py$/i, mod: py },
  { id: 'jvm', label: 'Java/Kotlin', re: /\.(?:java|kt|kts)$/i, mod: jvm },
  { id: 'csharp', label: 'C#', re: /\.cs$/i, mod: dotnet },
  { id: 'go', label: 'Go', re: /\.go$/i, mod: go },
  { id: 'php', label: 'PHP', re: /\.php$/i, mod: php },
  { id: 'ruby', label: 'Ruby', re: /\.rb$/i, mod: ruby },
  { id: 'rust', label: 'Rust', re: /\.rs$/i, mod: rust },
  { id: 'spec', label: 'Spec', re: /\.(?:json|ya?ml|properties)$|(?:^|[\\/])\.env(?:\.\w+)?$|(?:^|[\\/])README\.md$/i, mod: specs },
];
const BY_ID = Object.fromEntries(LANGS.map((l) => [l.id, l]));

function languageOf(file) {
  return LANGS.find((l) => l.re.test(file)) || null;
}

/** Quick pre-filter so we never run detectors on files that cannot contain routes. */
const SIGNALS = {
  javascript: /\.(get|post|put|patch|delete|route|use|register|listen|setGlobalPrefix)\s*\(|@Controller|export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE)|export\s+default|class\s|interface\s|z\.object/,
  python: /@|path\(|url\(|add_resource|register\(|include_router|Annotated|class\s|=\s*['"]\//,
  jvm: /@|\bget\s*\(|\broute\s*\(|class\s|record\s|interface\s|const\s+val/,
  csharp: /\[|Map(Get|Post|Put|Delete|Patch)|class\s|record\s/,
  go: /HandleFunc|Handle\(|\.(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch|Any|Group|Route|Mount)\(|struct/,
  php: /Route|->(get|post|put|patch|delete)\(|class\s/,
  ruby: /\b(get|post|put|patch|delete|resources?|namespace)\b|def\s/,
  rust: /#\[|\.route\(|\.nest\(|\.service\(|struct\s/,
  spec: /./,
};

function emptyAnalysis(file, lang) {
  return { file, lang, routes: [], models: {}, functions: {}, mounts: [], hints: { ports: [], servers: [] }, pending: [], pyClasses: {} };
}

function analyzeFile(file, text, ctx = {}) {
  const lang = languageOf(file);
  const out = emptyAnalysis(file, lang ? lang.id : null);
  if (!lang || !text) return out;
  if (!SIGNALS[lang.id].test(text)) return out;
  try {
    lang.mod.analyze(text, file, out, ctx);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  for (const r of out.routes) r.lang = r.lang || lang.id;
  return out;
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function resolve(analyses, opts = {}) {
  py.expandPending(analyses);

  // ---- Java/Kotlin string constants (for @Path(Resources.X), getQueryValue(Consts.Y) ...) ----
  const consts = {};
  for (const a of analyses) for (const [k, list] of Object.entries(a.consts || {})) (consts[k] = consts[k] || []).push(...list);
  const resolveConst = (expr, ctxCls, depth = 0) => {
    if (expr === undefined || expr === null || depth > 20) return null;
    let out = '';
    for (let part of U.splitTopLevel(String(expr), '+')) {
      part = part.trim();
      while (/^\(.*\)$/.test(part)) part = part.slice(1, -1).trim();
      const lit = /^"((?:\\.|[^"\\])*)"$/.exec(part);
      if (lit) { out += lit[1]; continue; }
      if (/^-?\d+$/.test(part)) { out += part; continue; }
      const m = /^(?:([\w.]+)\.)?([A-Za-z_]\w*)$/.exec(part);
      if (!m) return null;
      const cands = consts[m[2]];
      if (!cands || !cands.length) return null;
      const owner = m[1] ? m[1].split('.').pop() : ctxCls;
      const c = (owner && cands.find((x) => x.cls === owner)) || cands[0];
      const v = resolveConst(c.expr, c.cls, depth + 1);
      if (v === null) return null;
      out += v;
    }
    return out;
  };

  // ---- Restlet router.attach("/path", XResource.class) ----
  const jvmClasses = {};
  for (const a of analyses) Object.assign(jvmClasses, a.jvmClasses || {});
  for (const a of analyses) {
    for (const p of a.pending || []) {
      if (p.kind !== 'restletAttach') continue;
      const c = jvmClasses[p.cls];
      let verbs = c ? c.methods.map((x) => x.verb) : [];
      if (!verbs.length) verbs = c && /List|Collection/i.test(c.base) ? ['GET', 'POST'] : c && /Item|BeanMap/i.test(c.base) ? ['GET', 'PUT', 'DELETE'] : ['GET'];
      for (const verb of verbs) {
        const meth = c && c.methods.find((x) => x.verb === verb);
        a.routes.push({ method: verb, path: p.item.value || '', pathParts: p.item.expr ? [p.item] : undefined, line: p.line, framework: 'Restlet', keys: p.keys, block: (c ? c.doInit : '') + (meth ? meth.block : ''), restlet: true, beanBody: meth ? meth.sigs.some((s) => /BeanMap/.test(s)) : false, handler: p.cls, lang: 'jvm' });
      }
    }
  }
  // Restlet resources that declare no verb methods: take them from their base class when it is in the workspace
  const methodsVia = (name, seen = new Set()) => {
    const c = jvmClasses[name];
    if (!c || seen.has(name)) return null;
    seen.add(name);
    if (c.methods.length) return c;
    return methodsVia(String(c.base || '').replace(/<.*$/, '').split('.').pop(), seen);
  };
  for (const a of analyses) {
    if (!a.routes.some((r) => r.inherit)) continue;
    const done = new Set();
    const next = [];
    for (const r of a.routes) {
      if (!r.inherit) { next.push(r); continue; }
      const found = methodsVia(r.inherit.base);
      if (!found) { next.push(r); continue; }
      const key = r.inherit.cls + '|' + r.path + '|' + JSON.stringify(r.pathParts || '');
      if (done.has(key)) continue;
      done.add(key);
      for (const mm of found.methods) {
        next.push({ ...r, method: mm.verb, block: r.inherit.doInit + found.doInit + mm.block, beanBody: mm.sigs.some((s) => /BeanMap/.test(s)), handler: r.inherit.cls + ' → ' + r.inherit.base + '.' + mm.verb.toLowerCase(), inherit: undefined });
      }
    }
    a.routes = next;
  }

  // resolve constant-based paths
  for (const a of analyses) {
    for (const r of a.routes) {
      if (!r.pathParts) continue;
      const pieces = r.pathParts.map((pp) => (pp.value !== undefined ? pp.value : resolveConst(pp.expr)));
      if (pieces.every((x) => x !== null)) r.path = U.joinPaths(...pieces);
      else {
        r.path = U.joinPaths(...r.pathParts.map((pp, i) => (pieces[i] !== null ? pieces[i] : '<' + pp.expr + '>')));
        r.summary = r.summary || 'Path constant could not be resolved: ' + r.pathParts.filter((pp, i) => pieces[i] === null).map((pp) => pp.expr).join(', ');
      }
      r.pathParts = undefined;
    }
  }

  // ---- global indexes ----
  const models = {};
  const functions = {};
  const mounts = [];
  const hints = { ports: [], servers: [], springContextPath: null, nestGlobalPrefix: null, constants: {} };
  const resolveConstRef = (e) => resolveConst(e);
  for (const a of analyses) {
    for (const [k, v] of Object.entries(a.models || {})) if (!models[k] || (models[k].fields.length === 0 && v.fields.length)) models[k] = v;
    functions[a.lang] = functions[a.lang] || {};
    for (const [k, v] of Object.entries(a.functions || {})) if (!functions[a.lang][k]) functions[a.lang][k] = v;
    mounts.push(...(a.mounts || []));
    if (a.hints) {
      hints.ports.push(...(a.hints.ports || []));
      hints.servers.push(...(a.hints.servers || []));
      if (a.hints.springContextPath) hints.springContextPath = a.hints.springContextPath;
      if (a.hints.nestGlobalPrefix) hints.nestGlobalPrefix = a.hints.nestGlobalPrefix;
      Object.assign(hints.constants, a.hints.constants || {});
    }
  }
  // flatten model inheritance (class ItemCreate(ItemBase), class B extends A, ...)
  const flatten = (name, seen = new Set()) => {
    const mdl = models[name];
    if (!mdl || seen.has(name)) return [];
    seen.add(name);
    const inherited = [];
    for (const b of mdl.bases || []) for (const f of flatten(b, seen)) if (!inherited.find((x) => x.name === f.name)) inherited.push(f);
    return [...inherited.filter((f) => !mdl.fields.find((x) => x.name === f.name)), ...mdl.fields];
  };
  for (const k of Object.keys(models)) if (models[k].bases && models[k].bases.length) models[k] = { ...models[k], fields: flatten(k) };
  const mountIndex = {};
  for (const m of mounts) (mountIndex[m.target] = mountIndex[m.target] || []).push(m);
  const prefixFor = (keys, seen = new Set()) => {
    for (const k of keys || []) {
      if (seen.has(k)) continue;
      const list = mountIndex[k];
      if (!list || !list.length) continue;
      const m = list[0];
      const next = new Set(seen);
      next.add(k);
      return U.joinPaths(prefixFor(m.from, next), m.prefixRef && hints.constants[m.prefixRef] ? hints.constants[m.prefixRef] : m.prefix);
    }
    return '';
  };

  const endpoints = [];
  for (const a of analyses) {
    for (const r of a.routes) {
      try {
        endpoints.push(buildEndpoint(a, r, { models, functions, prefixFor, hints, resolveConst: resolveConstRef }));
      } catch (e) {
        // never let one odd route break the whole scan
      }
    }
  }
  const unique = mergeSpecs(U.uniqBy(endpoints, (e) => e.method + ' ' + e.path + ' ' + e.file + ':' + e.line));
  const seenIds = new Set();
  for (const e of unique) {
    while (seenIds.has(e.id)) e.id += 'x';
    seenIds.add(e.id);
  }
  unique.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
  return { endpoints: unique, hints: summarizeHints(hints, opts), models };
}

function lookupBlock(r, functions) {
  if (r.block) return r.block;
  if (!r.handlerRef) return null;
  const fns = functions[r.lang] || {};
  let ref = r.handlerRef;
  if (ref.includes('#')) ref = ref.split('/').pop(); // rails  api/v1/users#create
  return fns[ref] || fns[ref.split('@').pop()] || null;
}

function buildEndpoint(a, r, g) {
  r.lang = r.lang || a.lang;
  const lang = BY_ID[a.lang];
  let prefix = g.prefixFor(r.keys);
  if (r.prefixKind === 'spring' && g.hints.springContextPath) prefix = U.joinPaths(g.hints.springContextPath, prefix);
  if (r.prefixKind === 'nest' && g.hints.nestGlobalPrefix) prefix = U.joinPaths(g.hints.nestGlobalPrefix, prefix);
  const path = U.normalizePath(U.joinPaths(prefix, r.path) + (String(r.path).endsWith('/') && r.path.length > 1 ? '/' : ''));
  const pathNames = U.pathParamsOf(path);

  // ---- params ----
  let params = [...(r.params || [])];
  const block = lookupBlock(r, g.functions);
  if (lang && lang.mod.extractParams && (block || r.signature !== undefined || r.restlet)) {
    for (const p of lang.mod.extractParams(block, r, g) || []) {
      if (!params.find((x) => x.name === p.name && x.in === p.in)) params.push(p);
    }
  }
  if (r.serializer && ['POST', 'PUT', 'PATCH'].includes(r.method) && !params.some((p) => p.in === 'body')) params.push({ name: 'body', in: 'body', model: r.serializer, type: r.serializer });

  // promote / demote path params
  params = params.map((p) => (p.maybePath && pathNames.includes(p.name) ? { ...p, in: 'path', required: true, maybePath: undefined } : p));
  params = params.filter((p) => p.in !== 'path' || pathNames.includes(p.name));
  // when a query param duplicates a path param (e.g. unannotated FastAPI arg), keep the path one
  params = params.filter((p) => !(p.in === 'query' && pathNames.includes(p.name) && !p.model));
  for (const n of pathNames) {
    if (!params.find((p) => p.in === 'path' && p.name === n)) params.push({ name: n, in: 'path', type: 'string', required: true });
  }

  // expand models used for query / form parameters
  const expanded = [];
  for (const p of params) {
    if (p.model && (p.in === 'query' || p.in === 'form')) {
      const model = g.models[modelName(p.model)];
      if (model && model.fields.length) {
        for (const f of model.fields) if (!pathNames.includes(f.name)) expanded.push({ name: f.name, in: p.in, type: f.type, required: !!f.required });
      }
      continue;
    }
    expanded.push(p);
  }
  params = expanded;

  // ---- body ----
  const allowsBody = U.BODY_METHODS.has(r.method);
  const bodyParams = params.filter((p) => p.in === 'body');
  let example = r.bodyExample;
  if (example === undefined && allowsBody && bodyParams.length) {
    const modelParams = bodyParams.filter((p) => p.model);
    const fields = bodyParams.filter((p) => !p.model && !p.wholeBody);
    if (modelParams.length === 1 && !fields.length && !modelParams[0].embed) example = U.sampleFor(modelParams[0].model, g.models, a.lang);
    else if (modelParams.length || fields.length) {
      example = {};
      for (const p of modelParams) example[p.name] = U.sampleFor(p.model, g.models, a.lang);
      for (const p of fields) setPath(example, p.name, U.sampleFor(p.type, g.models, a.lang, 1));
    } else example = {};
  }
  const formish = params.filter((p) => p.in === 'form' || p.in === 'file');
  let mode = r.bodyMode;
  if (!mode) {
    if (!allowsBody && !formish.length) mode = 'none';
    else if (params.some((p) => p.in === 'file')) mode = 'formdata';
    else if (formish.length && example === undefined) mode = 'urlencoded';
    else if (example !== undefined && example !== null) mode = typeof example === 'string' ? 'text' : 'json';
    else mode = 'none';
  }
  const cleanParams = params
    .filter((p) => p.in !== 'body')
    .map((p) => ({ name: p.name, in: p.in, type: cleanType(p.type), required: !!p.required, description: p.description, example: p.example, enum: p.enum }));

  const rel = r.file || a.file;
  return {
    id: hash(r.method + ' ' + path + ' ' + rel),
    method: r.method,
    path,
    file: a.file,
    line: r.line || 0,
    language: lang ? lang.label : 'Unknown',
    framework: r.framework || (lang ? lang.label : ''),
    handler: r.handler || r.handlerRef,
    summary: r.summary,
    tags: r.tags,
    fromSpec: !!r.spec,
    params: U.uniqBy(cleanParams, (p) => p.in + ':' + p.name),
    body: { mode, example: mode === 'json' || mode === 'text' ? example : undefined },
    response: r.response,
  };
}

function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!(last in o) || typeof o[last] !== 'object') o[last] = value;
}

/** When the same METHOD + path is found both in code and in an OpenAPI/Swagger file, keep the code endpoint and enrich it with the spec. */
function mergeSpecs(list) {
  const shape = (p) => p.toLowerCase().replace(/:\w+/g, ':').replace(/\/+$/, '') || '/';
  const code = new Map();
  for (const e of list) if (!e.fromSpec) {
    const k = e.method + ' ' + shape(e.path);
    if (!code.has(k)) code.set(k, e);
  }
  const out = [];
  for (const e of list) {
    if (!e.fromSpec || e.framework === 'Postman') { out.push(e); continue; }
    const c = code.get(e.method + ' ' + shape(e.path));
    if (!c) { out.push(e); continue; }
    for (const sp of e.params) {
      const ex = c.params.find((x) => x.in === sp.in && x.name.toLowerCase() === sp.name.toLowerCase());
      if (ex) {
        ex.description = ex.description || sp.description;
        ex.example = ex.example !== undefined ? ex.example : sp.example;
        ex.enum = ex.enum || sp.enum;
        if (sp.type && (!ex.type || ex.type === 'string')) ex.type = sp.type;
        ex.required = ex.required || sp.required;
      } else if (sp.in !== 'path') c.params.push({ ...sp });
    }
    const emptyBody = !c.body || c.body.mode === 'none' || c.body.example === undefined || (c.body.example && typeof c.body.example === 'object' && !Object.keys(c.body.example).length);
    if (emptyBody && e.body && e.body.mode !== 'none') c.body = e.body;
    c.summary = c.summary && !/could not be resolved/.test(c.summary) ? c.summary : e.summary || c.summary;
    c.tags = c.tags || e.tags;
    c.response = c.response || e.response;
    c.documentedIn = e.file;
  }
  return out;
}

function modelName(t) {
  return U.coreType(t).replace(/^.*[.:]/, '').replace(/<.*$/, '').replace(/\[\]$/, '');
}

function cleanType(t) {
  if (!t) return 'string';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function summarizeHints(h, opts) {
  const counts = new Map();
  for (const p of h.ports) {
    const key = (p.scheme || 'http') + '://localhost:' + p.port;
    const w = (p.weak ? 1 : 10) + (counts.get(key) || 0);
    counts.set(key, w);
  }
  const baseUrls = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
  for (const s of h.servers) if (/^https?:\/\//.test(s) && !baseUrls.includes(s.replace(/\/$/, ''))) baseUrls.push(s.replace(/\/$/, ''));
  if (!baseUrls.length) baseUrls.push(opts.defaultBaseUrl || 'http://localhost:3000');
  return { baseUrls, springContextPath: h.springContextPath, nestGlobalPrefix: h.nestGlobalPrefix };
}

/** Convenience for tests / CLI: analyze a list of {file, text} and resolve. */
function scan(files, opts = {}) {
  const fileSet = new Set(files.map((f) => f.file));
  const analyses = files.map((f) => analyzeFile(f.file, f.text, { fileSet }));
  return resolve(analyses, opts);
}

module.exports = { analyzeFile, resolve, scan, languageOf, LANGS };

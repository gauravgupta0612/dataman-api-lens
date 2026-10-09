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
  { id: 'spec', label: 'Spec', re: /\.(?:json|ya?ml|properties)$|(?:^|[\\/])\.env(?:\.\w+)?$/i, mod: specs },
];
const BY_ID = Object.fromEntries(LANGS.map((l) => [l.id, l]));

function languageOf(file) {
  return LANGS.find((l) => l.re.test(file)) || null;
}

/** Quick pre-filter so we never run detectors on files that cannot contain routes. */
const SIGNALS = {
  javascript: /\.(get|post|put|patch|delete|route|use|register|listen|setGlobalPrefix)\s*\(|@Controller|export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE)|export\s+default|class\s|interface\s|z\.object/,
  python: /@|path\(|url\(|add_resource|register\(|include_router|Annotated|class\s|=\s*['"]\//,
  jvm: /@|\bget\s*\(|\broute\s*\(|class\s|record\s/,
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

  // ---- global indexes ----
  const models = {};
  const functions = {};
  const mounts = [];
  const hints = { ports: [], servers: [], springContextPath: null, nestGlobalPrefix: null, constants: {} };
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
        endpoints.push(buildEndpoint(a, r, { models, functions, prefixFor, hints }));
      } catch (e) {
        // never let one odd route break the whole scan
      }
    }
  }
  const unique = U.uniqBy(endpoints, (e) => e.method + ' ' + e.path + ' ' + e.file + ':' + e.line);
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
  if (lang && lang.mod.extractParams && (block || r.signature !== undefined)) {
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

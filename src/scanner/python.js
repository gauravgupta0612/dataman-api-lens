'use strict';
/**
 * Python detectors: FastAPI, Flask (+ Blueprints, flask-restx, Flask-RESTful), Quart, Sanic, Litestar,
 * Django (urls.py, class-based views) and Django REST Framework (routers / ViewSets / @action).
 */
const U = require('./util');

function modName(file) {
  const segs = file.replace(/\\/g, '/').replace(/\.py$/, '').split('/');
  if (segs[segs.length - 1] === '__init__') segs.pop();
  return segs;
}

function modKeys(file) {
  const segs = modName(file);
  const keys = [];
  for (let n = 1; n <= Math.min(4, segs.length); n++) keys.push('mod:' + segs.slice(-n).join('.'));
  return keys;
}

function lastMod(file) {
  const segs = modName(file);
  return segs[segs.length - 1];
}

function indentOf(src, idx) {
  const ls = src.lastIndexOf('\n', idx - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(ls));
  return m[0].replace(/\t/g, '    ').length;
}

/** Body of an indented block that starts on the line after `from` (python def/class). */
function pyBlock(src, headerIdx, bodyStart) {
  const indent = indentOf(src, headerIdx);
  let i = src.indexOf('\n', bodyStart);
  if (i === -1) return src.slice(bodyStart);
  // single-line body: def f(): return x
  const sameLine = src.slice(bodyStart, i).replace(/^\s*:/, '').trim();
  let end = i;
  const lines = src.slice(i + 1).split('\n');
  let pos = i + 1;
  for (const line of lines) {
    if (line.trim() !== '') {
      const ind = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
      if (ind <= indent) break;
    }
    pos += line.length + 1;
    end = pos;
  }
  return (sameLine ? sameLine + '\n' : '') + src.slice(i + 1, end);
}

function analyze(text, file, out) {
  const src = U.stripComments(text, 'hash');
  const lineOf = U.makeLineIndex(src);
  const mod = lastMod(file);
  const isFastApi = /\bfastapi\b/.test(src);
  const isLitestar = /\blitestar\b/.test(src);
  const fw = isFastApi ? 'FastAPI' : /\bsanic\b/.test(src) ? 'Sanic' : /\bquart\b/.test(src) ? 'Quart' : /\bflask_restx\b|\bflask_restplus\b/.test(src) ? 'Flask-RESTX' : /\bflask\b/.test(src) ? 'Flask' : /\bdjango\b|\brest_framework\b/.test(src) ? 'Django' : isLitestar ? 'Litestar' : 'Python';
  let m;

  // ---- imports (alias -> module/name) ----
  const aliases = {};
  const fre = /^\s*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm;
  while ((m = fre.exec(src))) {
    const modParts = m[1].split('.').filter(Boolean);
    const fromMod = modParts[modParts.length - 1] || '';
    for (const part of m[2].replace(/[()]/g, '').split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (!orig) continue;
      aliases[(alias || orig).trim()] = { module: fromMod, name: orig.trim() };
    }
  }

  // ---- owner prefixes: bp = Blueprint('x', __name__, url_prefix='/x'); router = APIRouter(prefix='/x') ----
  const ownerPrefix = {};
  const ore = /^\s*(\w+)\s*(?::\s*\w+\s*)?=\s*(?:[\w.]+\.)?(Blueprint|APIRouter|Namespace|Router|SimpleRouter|DefaultRouter)\s*\(/gm;
  while ((m = ore.exec(src))) {
    const b = U.readBalanced(src, src.indexOf('(', m.index + m[0].length - 1));
    if (!b) continue;
    let p = U.namedArg(b.inner, ['url_prefix', 'prefix', 'path']);
    if (p === null && m[2] === 'Namespace') {
      const strs = U.splitTopLevel(b.inner).map(U.firstString);
      p = '/' + (strs[0] || '');
    }
    if (p) ownerPrefix[m[1]] = p;
  }

  // ---- mounts ----
  const mre = /\b(\w+)\s*\.\s*(register_blueprint|include_router|add_namespace|mount|blueprint)\s*\(/g;
  while ((m = mre.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (!args.length) continue;
    let prefix = U.namedArg(b.inner, ['url_prefix', 'prefix', 'path']);
    const prefixRef = prefix === null ? (/(?:url_prefix|prefix)\s*=\s*(?:[\w.]+\.)?([A-Z_][A-Z0-9_]*)\b/.exec(b.inner) || [])[1] : undefined;
    if (prefix === null && m[2] === 'mount') prefix = U.firstString(args[0]);
    const targetExpr = m[2] === 'mount' ? (args[1] || '') : args[0];
    const target = pyTarget(targetExpr.trim(), aliases, mod);
    if (target) out.mounts.push({ target, prefix: prefix || '', prefixRef, from: ['pyvar:' + mod + ':' + m[1]] });
  }

  // ---- decorator routes ----
  const dre = /^([ \t]*)@(\w+)\s*\.\s*(route|get|post|put|patch|delete|head|options|api_route|websocket)\s*\(/gm;
  while ((m = dre.exec(src))) {
    if (m[3] === 'websocket') continue;
    const open = m.index + m[0].length - 1;
    const b = U.readBalanced(src, open);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    let p = args.length ? U.firstString(args[0]) : null;
    if (p === null) p = U.namedArg(b.inner, ['path', 'rule', 'uri']);
    if (p === null) p = '';
    let methods;
    if (m[3] === 'route' || m[3] === 'api_route') {
      methods = U.methodsFrom(U.namedArray(b.inner, 'methods') || '');
      if (!methods.length) methods = ['GET'];
    } else methods = [m[3].toUpperCase()];
    const owner = m[2];
    const fullPath = ownerPrefix[owner] ? U.joinPaths(ownerPrefix[owner], p) : p;
    const after = findDefOrClass(src, b.end + 1);
    const keys = ['pyvar:' + mod + ':' + owner];
    const framework = m[3] === 'route' && fw === 'FastAPI' ? 'FastAPI' : fw;
    if (after && after.kind === 'class') {
      // flask-restx / flask MethodView style: methods inside class
      for (const meth of classMethods(after.body)) {
        out.routes.push({ method: meth.method, path: fullPath, line: lineOf(m.index), framework, keys, block: meth.block, signature: meth.sig, handler: after.name + '.' + meth.name, lang: 'python' });
      }
      continue;
    }
    for (const meth of methods) {
      out.routes.push({
        method: meth,
        path: fullPath,
        line: lineOf(m.index),
        framework,
        keys,
        block: after ? after.body : null,
        signature: after ? after.sig : null,
        handler: after ? after.name : undefined,
        fastapi: isFastApi,
      });
    }
  }

  // ---- litestar bare decorators: @get("/x") ----
  if (isLitestar) {
    const lre = /^[ \t]*@(get|post|put|patch|delete)\s*\(/gm;
    while ((m = lre.exec(src))) {
      const b = U.readBalanced(src, m.index + m[0].length - 1);
      if (!b) continue;
      const p = U.firstString(b.inner) || U.namedArg(b.inner, 'path') || '/';
      const after = findDefOrClass(src, b.end + 1);
      out.routes.push({ method: m[1].toUpperCase(), path: p, line: lineOf(m.index), framework: 'Litestar', keys: ['file:' + file], block: after && after.body, signature: after && after.sig, fastapi: true });
    }
  }

  // ---- Flask-RESTful: api.add_resource(UserResource, '/users/<int:id>') ----
  const are = /\b(\w+)\s*\.\s*add_resource\s*\(/g;
  while ((m = are.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    const cls = (args[0] || '').trim();
    for (const a of args.slice(1)) {
      const p = U.firstString(a);
      if (p !== null && !/=/.test(a.split(/['"]/)[0])) out.pending.push({ kind: 'cbv', cls, path: p, line: lineOf(m.index), framework: 'Flask-RESTful', keys: ['file:' + file] });
    }
  }

  // ---- Django urls ----
  if (/\b(re_)?path\s*\(|\burl\s*\(/.test(src) && /urlpatterns/.test(src)) {
    const ure = /\b(re_path|path|url)\s*\(/g;
    while ((m = ure.exec(src))) {
      const b = U.readBalanced(src, m.index + m[0].length - 1);
      if (!b) continue;
      const args = U.splitTopLevel(b.inner);
      if (args.length < 2) continue;
      let p = U.firstString(args[0]);
      if (p === null) continue;
      if (m[1] !== 'path') p = p.replace(/^\^/, '').replace(/\$$/, '');
      const view = args[1].trim();
      const inc = /^include\s*\(\s*(?:\(\s*)?(?:['"]([\w.]+)['"]|([\w.]+))/.exec(view);
      if (inc) {
        const target = inc[1] ? 'mod:' + inc[1] : /\.urls$/.test(inc[2]) ? 'pyrouter:' + mod + ':' + inc[2].replace(/\.urls$/, '') : 'mod:' + inc[2];
        out.mounts.push({ target, prefix: p, from: modKeys(file) });
        continue;
      }
      const cbv = /^([\w.]+)\.as_view\s*\(/.exec(view);
      if (cbv) {
        out.pending.push({ kind: 'cbv', cls: cbv[1].split('.').pop(), path: p, line: lineOf(m.index), framework: 'Django', keys: modKeys(file) });
        continue;
      }
      const ref = /^([\w.]+)$/.exec(view);
      out.routes.push({ method: 'GET', path: p, line: lineOf(m.index), framework: 'Django', keys: modKeys(file), handlerRef: ref ? ref[1].split('.').pop() : undefined, djangoAny: true });
    }
  }

  // ---- DRF routers: router.register(r'users', UserViewSet) ----
  const rre = /\b(\w+)\s*\.\s*register\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/g;
  while ((m = rre.exec(src))) {
    out.pending.push({ kind: 'viewset', cls: m[3].split('.').pop(), path: m[2], line: lineOf(m.index), framework: 'Django REST', keys: ['pyrouter:' + mod + ':' + m[1]] });
  }

  // ---- classes: models, enums, CBVs ----
  const cre = /^([ \t]*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm;
  while ((m = cre.exec(src))) {
    const body = pyBlock(src, m.index, m.index + m[0].length);
    const bases = (m[3] || '').split(',').map((s) => s.trim());
    const methods = classMethods(body);
    out.pyClasses[m[2]] = { bases, methods, actions: drfActions(body), body };
    if (bases.some((b) => /Enum$/.test(b))) {
      const vals = [];
      const vre = /^\s*\w+\s*=\s*['"]?([^'"\n]+)['"]?/gm;
      let v;
      while ((v = vre.exec(body))) vals.push(v[1].trim());
      out.models[m[2]] = { lang: 'python', fields: [], enumValues: vals };
      continue;
    }
    const fields = pyFields(body);
    const modelBases = bases.filter((b) => /^[A-Z]/.test(b) && !/^(BaseModel|SQLModel|Schema|TypedDict|object|Generic|Protocol|Exception|APIView|View|ViewSet)/.test(b));
    if ((fields.length || modelBases.length) && !out.models[m[2]]) out.models[m[2]] = { lang: 'python', fields, bases: modelBases.map((b) => b.split('.').pop().replace(/\[.*$/, '')) };
  }

  // ---- Annotated[..., Depends()] aliases (FastAPI dependency types) ----
  const dep = /^(\w+)\s*=\s*Annotated\[[^\n]*\b(?:Depends|Security)\s*\(/gm;
  while ((m = dep.exec(src))) out.models[m[1]] = { lang: 'python', fields: [], dependsAlias: true };

  // ---- functions ----
  const fnre = /^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((m = fnre.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1);
    if (!b) continue;
    if (!out.functions[m[1]]) out.functions[m[1]] = '(' + b.inner + ')\n' + pyBlock(src, m.index, b.end + 1);
  }

  // ---- string constants (API_V1_STR = "/api/v1") used as prefixes ----
  const cst = /^\s*([A-Z_][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*['"](\/[^'"]*)['"]/gm;
  while ((m = cst.exec(src))) out.hints.constants = Object.assign(out.hints.constants || {}, { [m[1]]: m[2] });

  // ---- hints ----
  const pre = /\bport\s*=\s*(\d{2,5})\b|--port[ =](\d{2,5})|runserver\s+(?:[\d.]+:)?(\d{2,5})/g;
  while ((m = pre.exec(src))) out.hints.ports.push({ port: +(m[1] || m[2] || m[3]), source: file });
  if (fw === 'Flask' && /app\.run\(/.test(src)) out.hints.ports.push({ port: 5000, source: 'default', weak: true });
  if (fw === 'FastAPI' || fw === 'Django') out.hints.ports.push({ port: 8000, source: 'default', weak: true });
}

function pyTarget(expr, aliases, mod) {
  const dotted = /^(\w+)\.(\w+)$/.exec(expr);
  if (dotted) {
    const a = aliases[dotted[1]];
    const module = a ? (a.name || a.module) : dotted[1];
    return 'pyvar:' + module + ':' + dotted[2];
  }
  const plain = /^(\w+)$/.exec(expr);
  if (!plain) return null;
  const a = aliases[plain[1]];
  if (a) return 'pyvar:' + a.module + ':' + a.name;
  return 'pyvar:' + mod + ':' + plain[1];
}

function findDefOrClass(src, from) {
  const re = /\s*(?:@[^\n]*\n\s*)*(async\s+def|def|class)\s+(\w+)\s*(\()?/y;
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  if (m[1] === 'class') {
    const colon = src.indexOf(':', m.index + m[0].length);
    return { kind: 'class', name: m[2], body: pyBlock(src, m.index + m[0].indexOf('class'), colon) };
  }
  const open = m.index + m[0].length - 1;
  const b = U.readBalanced(src, open);
  if (!b) return null;
  return { kind: 'def', name: m[2], sig: b.inner, body: pyBlock(src, m.index + m[0].search(/(async\s+)?def/), b.end + 1) };
}

function classMethods(body) {
  const res = [];
  const re = /^([ \t]*)(?:async\s+)?def\s+(get|post|put|patch|delete|head|options|list|create|retrieve|update|partial_update|destroy)\s*\(/gm;
  let m;
  while ((m = re.exec(body))) {
    const b = U.readBalanced(body, m.index + m[0].length - 1);
    if (!b) continue;
    const verbs = { list: 'GET', retrieve: 'GET', create: 'POST', update: 'PUT', partial_update: 'PATCH', destroy: 'DELETE' };
    res.push({ name: m[2], method: verbs[m[2]] || m[2].toUpperCase(), sig: b.inner, block: pyBlock(body, m.index, b.end + 1) });
  }
  return res;
}

function drfActions(body) {
  const res = [];
  const re = /@action\s*\(([^)]*)\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
  let m;
  while ((m = re.exec(body))) {
    const methods = U.methodsFrom(U.namedArray(m[1], 'methods') || '') ;
    res.push({ name: m[2], detail: /detail\s*=\s*True/.test(m[1]), methods: methods.length ? methods : ['GET'], urlPath: U.namedArg(m[1], 'url_path') || m[2] });
  }
  return res;
}

const MARSH_TYPES = {
  Str: 'str', String: 'str', CharField: 'str', TextField: 'str', SlugField: 'str', URLField: 'str', UUIDField: 'uuid', UUID: 'uuid',
  Email: 'email', EmailField: 'email', Int: 'int', Integer: 'int', IntegerField: 'int', Float: 'float', FloatField: 'float',
  Decimal: 'float', DecimalField: 'float', Bool: 'bool', Boolean: 'bool', BooleanField: 'bool', Date: 'date', DateField: 'date',
  DateTime: 'datetime', DateTimeField: 'datetime', List: 'list[str]', ListField: 'list[str]', Dict: 'dict', DictField: 'dict',
  JSONField: 'dict', Nested: 'object', PrimaryKeyRelatedField: 'int', ChoiceField: 'str',
};

function pyFields(body) {
  const fields = [];
  const lines = body.split('\n');
  const baseIndent = (lines.find((l) => l.trim()) || '').search(/\S/);
  for (const line of lines) {
    if (!line.trim() || line.search(/\S/) !== baseIndent) continue;
    const t = line.trim();
    if (/^(def|async|class|@|return|pass|"""|''')/.test(t)) continue;
    let m = /^(\w+)\s*:\s*([^=]+?)\s*(?:=\s*(.+))?$/.exec(t);
    if (m && m[1] !== 'model' && m[1] !== 'Meta' && !/^(ClassVar|Final)/.test(m[2])) {
      const optional = /Optional\[|\|\s*None|None\s*\|/.test(m[2]) || (m[3] !== undefined && !/Field\(\s*(\.\.\.|default\s*=\s*\.\.\.)/.test(m[3]));
      fields.push({ name: m[1], type: m[2].replace(/Optional\[(.*)\]/, '$1').replace(/\s*\|\s*None/, ''), required: !optional });
      continue;
    }
    m = /^(\w+)\s*=\s*(?:fields|serializers|models|ma\.fields)\.(\w+)\s*\((.*)\)?/.exec(t);
    if (m) {
      if (/read_only\s*=\s*True/.test(m[3] || '')) continue;
      const required = /required\s*=\s*True/.test(m[3] || '') || (/serializers/.test(t) && !/required\s*=\s*False|default\s*=|allow_null\s*=\s*True/.test(m[3] || ''));
      fields.push({ name: m[1], type: MARSH_TYPES[m[2]] || 'str', required });
    }
  }
  return fields;
}

// --------------------------------------------------------------- params
const SKIP_NAMES = new Set(['self', 'cls', 'request', 'req', 'response', 'res', 'db', 'session', 'background_tasks', 'args', 'kwargs']);
const SKIP_TYPES = /^(Request|Response|Session|AsyncSession|BackgroundTasks|WebSocket|HTTPConnection|SecurityScopes|Depends)\b/;

function fastapiParams(sig, route, models) {
  const res = [];
  const pathNames = U.pathParamsOf(U.normalizePath(route.path));
  for (const raw of U.splitTopLevel(sig || '')) {
    if (raw.startsWith('*')) continue;
    const m = /^(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(raw.trim());
    if (!m) continue;
    const [, name, typeRaw = '', def = ''] = m;
    let type = typeRaw.trim();
    // Annotated[int, Query(...)]
    let marker = def;
    const ann = /^Annotated\[\s*([^,]+),\s*([\s\S]+)\]$/.exec(type);
    if (ann) { type = ann[1].trim(); marker = ann[2] + ' ' + def; }
    if (SKIP_NAMES.has(name) && !pathNames.includes(name)) { if (!/Query|Body|Header|Path/.test(marker)) continue; }
    if (/Depends\s*\(|Security\s*\(/.test(marker) || SKIP_TYPES.test(type)) continue;
    if (models && models[U.coreType(type)] && models[U.coreType(type)].dependsAlias) continue;
    const hasDefault = def.trim() !== '' && !/^\w+\(\s*(\.\.\.)?\s*[,)]/.test(def.trim()) && !/\(\s*\.\.\./.test(def);
    const optional = hasDefault || /Optional\[|\|\s*None/.test(type);
    const alias = /alias\s*=\s*['"]([^'"]+)['"]/.exec(marker);
    if (pathNames.includes(name) || /\bPath\s*\(/.test(marker)) res.push({ name, in: 'path', type, required: true });
    else if (/\bHeader\s*\(/.test(marker)) res.push({ name: alias ? alias[1] : name.replace(/_/g, '-'), in: 'header', type, required: !optional });
    else if (/\bCookie\s*\(/.test(marker)) res.push({ name, in: 'cookie', type, required: !optional });
    else if (/\bFile\s*\(|UploadFile/.test(marker + type)) res.push({ name, in: 'file', type: 'file', required: !optional });
    else if (/\bForm\s*\(/.test(marker)) res.push({ name, in: 'form', type, required: !optional });
    else if (/\bBody\s*\(/.test(marker)) res.push({ name, in: 'body', type, model: U.isSimpleType(type) ? undefined : type, required: !optional, embed: /embed\s*=\s*True/.test(marker) });
    else if (/\bQuery\s*\(/.test(marker) || U.isSimpleType(type) || !type) res.push({ name: alias ? alias[1] : name, in: 'query', type: type || 'str', required: !optional });
    else res.push({ name, in: 'body', model: type, type, required: !optional });
  }
  return res;
}

function extractParams(block, route, g) {
  const res = [];
  if (route && (route.fastapi || route.framework === 'FastAPI' || route.framework === 'Litestar') && route.signature !== undefined) {
    res.push(...fastapiParams(route.signature, route, g && g.models));
  }
  if (!block) return res;
  const add = (name, where) => {
    if (!res.find((p) => p.name === name && p.in === where)) res.push({ name, in: where, type: 'str', required: false });
  };
  const rules = [
    [/\brequest\.args\.(?:get|getlist)\(\s*['"]([^'"]+)['"]|\brequest\.args\[\s*['"]([^'"]+)['"]\s*\]/g, 'query'],
    [/\brequest\.(?:GET|query_params)\.(?:get|getlist)\(\s*['"]([^'"]+)['"]|\brequest\.(?:GET|query_params)\[\s*['"]([^'"]+)['"]\s*\]/g, 'query'],
    [/\brequest\.form\.(?:get|getlist)\(\s*['"]([^'"]+)['"]|\brequest\.form\[\s*['"]([^'"]+)['"]\s*\]/g, 'form'],
    [/\brequest\.POST\.(?:get|getlist)\(\s*['"]([^'"]+)['"]|\brequest\.POST\[\s*['"]([^'"]+)['"]\s*\]/g, 'form'],
    [/\brequest\.(?:json|data|get_json\(\))\.get\(\s*['"]([^'"]+)['"]|\brequest\.(?:json|data|get_json\(\))\[\s*['"]([^'"]+)['"]\s*\]/g, 'body'],
    [/\brequest\.headers\.get\(\s*['"]([^'"]+)['"]|\brequest\.headers\[\s*['"]([^'"]+)['"]\s*\]|\brequest\.META\.get\(\s*['"]HTTP_([^'"]+)['"]/g, 'header'],
    [/\brequest\.files\.get\(\s*['"]([^'"]+)['"]|\brequest\.(?:files|FILES)\[\s*['"]([^'"]+)['"]\s*\]/g, 'file'],
  ];
  for (const [re, where] of rules) {
    let m;
    while ((m = re.exec(block))) add(where === 'header' && m[3] ? m[3].replace(/_/g, '-') : m[1] || m[2] || m[3], where);
  }
  // data = request.get_json()  ->  data['x'] / data.get('x')
  const jv = /\b(\w+)\s*=\s*(?:await\s+)?request\.(?:get_json\(\)|json(?:\(\))?|data)(?![\w.(])/.exec(block);
  if (jv) {
    const re = new RegExp('\\b' + jv[1] + '(?:\\.get\\(\\s*[\'"]([^\'"]+)[\'"]|\\[\\s*[\'"]([^\'"]+)[\'"]\\s*\\])', 'g');
    let m;
    while ((m = re.exec(block))) add(m[1] || m[2], 'body');
    if (!res.some((p) => p.in === 'body')) res.push({ name: '__body__', in: 'body', type: 'object', wholeBody: true });
  }
  // serializer = UserSerializer(data=request.data)
  const ser = /\b(\w+Serializer|\w+Schema)\s*\(\s*data\s*=\s*request\.(?:data|json)/.exec(block) || /\b(\w+Schema)\s*\(\s*\)\s*\.load\(\s*request\.(?:json|get_json)/.exec(block);
  if (ser) res.push({ name: 'body', in: 'body', model: ser[1], type: ser[1] });
  return res;
}

/** Expand class-based views / ViewSets / Flask-RESTful resources once every file has been analyzed. */
function expandPending(analyses) {
  const classes = {};
  for (const a of analyses) if (a.pyClasses) Object.assign(classes, a.pyClasses);
  const methodsOf = (name, seen = new Set()) => {
    const c = classes[name];
    if (!c || seen.has(name)) return { methods: [], actions: [], bases: [] };
    seen.add(name);
    const res = { methods: [...c.methods], actions: [...c.actions], bases: c.bases };
    for (const b of c.bases) {
      const inh = methodsOf(b.split('.').pop(), seen);
      for (const mm of inh.methods) if (!res.methods.find((x) => x.name === mm.name)) res.methods.push(mm);
      res.actions.push(...inh.actions);
      res.bases = res.bases.concat(inh.bases);
    }
    return res;
  };
  for (const a of analyses) {
    for (const p of a.pending || []) {
      const info = methodsOf(p.cls);
      const base = (info.bases || []).join(' ');
      if (p.kind === 'cbv') {
        let methods = info.methods.filter((x) => ['get', 'post', 'put', 'patch', 'delete'].includes(x.name));
        if (!methods.length) {
          // generic views
          const gen = [];
          if (/ListCreate|ListAPIView|ListView/.test(base)) gen.push('GET');
          if (/ListCreate|CreateAPIView|CreateView/.test(base)) gen.push('POST');
          if (/Retrieve|DetailView/.test(base)) gen.push('GET');
          if (/Update/.test(base)) gen.push('PUT', 'PATCH');
          if (/Destroy|DeleteView/.test(base)) gen.push('DELETE');
          methods = [...new Set(gen.length ? gen : ['GET'])].map((v) => ({ method: v }));
        }
        for (const mm of methods) {
          a.routes.push({ method: mm.method, path: p.path, line: p.line, framework: p.framework, keys: p.keys, block: mm.block, signature: mm.sig, handler: p.cls + (mm.name ? '.' + mm.name : ''), serializerOf: p.cls });
        }
      } else if (p.kind === 'viewset') {
        const own = info.methods.map((x) => x.name);
        const all = /ModelViewSet/.test(base) && !/ReadOnly/.test(base);
        const ro = /ReadOnlyModelViewSet/.test(base);
        const has = (n, mixin) => own.includes(n) || all || (ro && (n === 'list' || n === 'retrieve')) || new RegExp(mixin).test(base);
        const list = U.joinPaths(p.path) + '/';
        const detail = U.joinPaths(p.path, ':pk') + '/';
        const push = (method, path, handler) => a.routes.push({ method, path, line: p.line, framework: p.framework, keys: p.keys, handler: p.cls + '.' + handler, serializerOf: p.cls, block: (info.methods.find((x) => x.name === handler) || {}).block });
        if (has('list', 'ListModelMixin')) push('GET', list, 'list');
        if (has('create', 'CreateModelMixin')) push('POST', list, 'create');
        if (has('retrieve', 'RetrieveModelMixin')) push('GET', detail, 'retrieve');
        if (has('update', 'UpdateModelMixin')) { push('PUT', detail, 'update'); push('PATCH', detail, 'partial_update'); }
        if (has('destroy', 'DestroyModelMixin')) push('DELETE', detail, 'destroy');
        for (const act of info.actions) for (const meth of act.methods) push(meth, U.joinPaths(act.detail ? detail : list, act.urlPath) + '/', act.name);
      }
    }
  }
  // serializer_class = UserSerializer  -> body model for write methods
  for (const a of analyses) {
    for (const r of a.routes) {
      if (!r.serializerOf) continue;
      const c = classes[r.serializerOf];
      const s = c && /serializer_class\s*=\s*(\w+)/.exec(c.body);
      if (s) r.serializer = s[1];
    }
  }
}

module.exports = { analyze, extractParams, expandPending, modKeys };

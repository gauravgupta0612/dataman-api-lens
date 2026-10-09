'use strict';
/**
 * C# detectors: ASP.NET Core MVC / Web API controllers (attribute routing, [controller]/[action] tokens),
 * Minimal APIs (app.MapGet, MapGroup) and models (classes, records, enums).
 */
const U = require('./util');

const SKIP_TYPES = /^(CancellationToken|HttpContext|HttpRequest|HttpResponse|ClaimsPrincipal|ILogger|IServiceProvider|IConfiguration|IMediator|ISender|IMapper|LinkGenerator|IFormCollection)\b|(Service|Repository|Context|Db|DbContext|Handler|Manager|Provider|Factory|Client|Options)(<.*>)?$/;

function analyze(text, file, out) {
  const src = U.stripComments(text, 'c', true);
  const lineOf = U.makeLineIndex(src);
  collectModels(src, out);
  if (/\[(Http(Get|Post|Put|Delete|Patch|Head|Options)|Route|ApiController)/.test(src)) controllers(src, file, out, lineOf);
  if (/\.Map(Get|Post|Put|Delete|Patch|Methods)\s*\(/.test(src)) minimal(src, file, out, lineOf);
  // launchSettings-like hints inside code
  let m;
  const pr = /(?:UseUrls|Urls\.Add|applicationUrl)\s*\(?\s*"?(https?):\/\/[^:"]+:(\d{2,5})/g;
  while ((m = pr.exec(src))) out.hints.ports.push({ port: +m[2], scheme: m[1], source: file });
}

/** Read consecutive [Attr(...)] blocks before a declaration. */
function attributesBefore(src, idx) {
  // walk back over attribute blocks and whitespace
  let i = idx;
  const attrs = [];
  for (;;) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] !== ']') break;
    // find matching '['
    let depth = 0;
    let k = j;
    for (; k >= 0; k--) {
      if (src[k] === ']') depth++;
      else if (src[k] === '[') { depth--; if (depth === 0) break; }
    }
    if (k < 0) break;
    attrs.unshift(...parseAttrList(src.slice(k + 1, j)));
    i = k;
  }
  return attrs;
}

function parseAttrList(inner) {
  return U.splitTopLevel(inner).map((a) => {
    const m = /^(?:\w+\s*:\s*)?([\w.]+)\s*(?:\(([\s\S]*)\))?$/.exec(a.trim());
    return m ? { name: m[1].split('.').pop().replace(/Attribute$/, ''), args: m[2] || '' } : null;
  }).filter(Boolean);
}

function controllers(src, file, out, lineOf) {
  const classes = [];
  let m;
  const cre = /\b(?:public\s+|internal\s+)?(?:sealed\s+|abstract\s+|partial\s+|static\s+)*class\s+(\w+)(?:\s*\([^)]*\))?(?:\s*:\s*([^{]+))?\{/g;
  while ((m = cre.exec(src))) {
    // walk back from "public class" to attributes
    const attrs = attributesBefore(src, m.index);
    const route = attrs.filter((a) => a.name === 'Route').map((a) => U.firstString(a.args) || '');
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace, true);
    classes.push({ name: m[1], start: m.index, end: b ? b.end : src.length, routes: route.length ? route : [''], isController: /Controller/.test(m[1]) || /Controller/.test(m[2] || '') || attrs.some((a) => a.name === 'ApiController') });
  }
  const re = /\[\s*(?:[^\]]*?,\s*)?Http(Get|Post|Put|Delete|Patch|Head|Options)\b/g;
  while ((m = re.exec(src))) {
    // find the end of the attribute run and the method signature
    let i = m.index;
    let k = i;
    for (;;) {
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] !== '[') break;
      const b = U.readBalanced(src, k, true);
      if (!b) break;
      k = b.end + 1;
    }
    const sig = /\s*(?:(?:public|private|protected|internal|static|virtual|override|async|new)\s+)*([\w<>[\],.?\s]+?)\s+(\w+)\s*(?:<[^>]*>)?\s*\(/y;
    sig.lastIndex = k;
    const sm = sig.exec(src);
    if (!sm) continue;
    const open = sm.index + sm[0].length - 1;
    const pb = U.readBalanced(src, open, true);
    const attrs = attributesBefore(src, k);
    const verbs = attrs.filter((a) => /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/.test(a.name));
    const cls = classes.filter((c) => c.start < m.index && m.index < c.end).pop();
    const methodRoutes = attrs.filter((a) => a.name === 'Route').map((a) => U.firstString(a.args) || '');
    const action = sm[2].replace(/Async$/, '');
    const ctrlName = cls ? cls.name.replace(/Controller$/, '') : '';
    const verbAttr = verbs.find((v) => v.name === 'Http' + m[1]);
    const templates = [];
    const vt = verbAttr ? U.firstString(verbAttr.args) : null;
    if (vt !== null && vt !== undefined) templates.push(vt);
    templates.push(...methodRoutes);
    if (!templates.length) templates.push('');
    const params = pb ? csParams(pb.inner, m[1].toUpperCase()) : [];
    const consumesForm = params.some((p) => p.in === 'form' || p.in === 'file');
    for (const prefix of cls ? cls.routes : ['']) {
      for (const t of templates) {
        let full = t.startsWith('~/') || t.startsWith('/') ? t.replace(/^~/, '') : U.joinPaths(prefix, t);
        full = full.replace(/\[controller\]/gi, ctrlName).replace(/\[action\]/gi, action).replace(/\[area\]/gi, '');
        out.routes.push({ method: m[1].toUpperCase(), path: full, line: lineOf(m.index), framework: 'ASP.NET Core', keys: ['file:' + file], params, handler: (cls ? cls.name + '.' : '') + sm[2], bodyMode: consumesForm ? 'formdata' : undefined });
      }
    }
  }
}

function csParams(sig, method) {
  const res = [];
  for (const raw of U.splitTopLevel(sig)) {
    let rest = raw;
    const attrs = [];
    let am;
    while ((am = /^\s*\[([^\]]*)\]/.exec(rest))) {
      attrs.push(...parseAttrList(am[1]));
      rest = rest.slice(am[0].length);
    }
    rest = rest.trim().replace(/^(this|ref|out|in|params)\s+/, '');
    const pm = /^(.+?)\s+(\w+)\s*(=\s*.+)?$/.exec(rest);
    if (!pm) continue;
    const type = pm[1].trim();
    const name = pm[2];
    const optional = /\?$/.test(type) || !!pm[3];
    const find = (n) => attrs.find((a) => a.name === n);
    const nameArg = (a) => U.namedArg(a.args, 'Name') || name;
    let a;
    if ((a = find('FromRoute'))) res.push({ name: nameArg(a), in: 'path', type, required: true });
    else if ((a = find('FromQuery'))) res.push(U.isSimpleType(type) ? { name: nameArg(a), in: 'query', type, required: !!find('BindRequired') || !!find('Required') } : { name, in: 'query', type, model: type });
    else if ((a = find('FromHeader'))) res.push({ name: nameArg(a), in: 'header', type, required: !optional });
    else if ((a = find('FromBody'))) res.push({ name, in: 'body', type, model: type, required: true });
    else if ((a = find('FromForm'))) res.push(/IFormFile/.test(type) ? { name: nameArg(a), in: 'file', type: 'file', required: !optional } : U.isSimpleType(type) ? { name: nameArg(a), in: 'form', type, required: !optional } : { name, in: 'form', type, model: type });
    else if (find('FromServices') || find('FromKeyedServices') || find('AsParameters')) continue;
    else if (SKIP_TYPES.test(type)) continue;
    else if (/IFormFile/.test(type)) res.push({ name, in: 'file', type: 'file', required: !optional });
    else if (U.isSimpleType(type)) res.push({ name, in: 'query', type, required: !!find('BindRequired') || !!find('Required'), maybePath: true });
    else if (['GET', 'DELETE', 'HEAD'].includes(method)) res.push({ name, in: 'query', type, model: type });
    else res.push({ name, in: 'body', type, model: type, required: true });
  }
  return res;
}

function minimal(src, file, out, lineOf) {
  let m;
  // groups: var todos = app.MapGroup("/todos");  var api = app.MapGroup("api").MapGroup("v1")
  const groups = {};
  const gre = /\b(?:var|RouteGroupBuilder)\s+(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*"([^"]*)"\s*\)/g;
  while ((m = gre.exec(src))) groups[m[1]] = { parent: m[2], prefix: m[3] };
  const prefixOf = (v, seen = new Set()) => {
    if (!groups[v] || seen.has(v)) return '';
    seen.add(v);
    return U.joinPaths(prefixOf(groups[v].parent, seen), groups[v].prefix);
  };
  const re = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(/g;
  while ((m = re.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    const p = U.firstString(args[0] || '');
    if (p === null) continue;
    const handler = (args[1] || '').trim();
    const lam = /^(?:async\s+)?(?:static\s+)?(?:\[[^\]]*\]\s*)?\(([\s\S]*?)\)\s*=>/.exec(handler);
    const params = lam ? csParams(lam[1], m[2].toUpperCase()) : [];
    const route = { method: m[2].toUpperCase(), path: U.joinPaths(prefixOf(m[1]), p), line: lineOf(m.index), framework: 'ASP.NET Minimal API', keys: ['file:' + file], params };
    if (!lam && /^[\w.]+$/.test(handler)) route.handlerRef = handler.split('.').pop();
    out.routes.push(route);
  }
  // method groups referenced by name: static IResult GetTodo(int id, TodoDb db)
  const fre = /\b(?:static\s+)?(?:async\s+)?(?:[\w<>?,\s]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:=>|\{)/g;
  while ((m = fre.exec(src))) if (!out.functions[m[1]]) out.functions[m[1]] = 'CSPARAMS(' + m[2] + ')';
}

function collectModels(src, out) {
  let m;
  const rec = /\brecord\s+(?:class\s+|struct\s+)?(\w+)\s*\(/g;
  while ((m = rec.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const fields = [];
    for (const part of U.splitTopLevel(b.inner)) {
      const f = /^(?:\[[^\]]*\]\s*)*(.+?)\s+(\w+)\s*(=.*)?$/.exec(part.trim());
      if (f) fields.push({ name: camel(f[2]), type: f[1], required: !/\?$/.test(f[1]) && !f[3] });
    }
    out.models[m[1]] = { lang: 'cs', fields };
  }
  const cls = /\b(?:class|record|struct)\s+(\w+)[^{;(]*\{/g;
  while ((m = cls.exec(src))) {
    if (out.models[m[1]]) continue;
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace, true);
    if (!b) continue;
    const fields = [];
    const pre = /((?:\[[^\]]*\]\s*)*)public\s+(?:required\s+|virtual\s+|override\s+)*([\w<>[\],.?]+(?:\s*<[^>]*>)?)\s+(\w+)\s*\{\s*get;/g;
    let f;
    while ((f = pre.exec(b.inner))) {
      const jn = /JsonPropertyName\(\s*"([^"]+)"/.exec(f[1]);
      fields.push({ name: jn ? jn[1] : camel(f[3]), type: f[2], required: /\[Required\]|required\s/.test(f[0]) });
    }
    if (fields.length) out.models[m[1]] = { lang: 'cs', fields };
  }
  const en = /\benum\s+(\w+)\s*(?::\s*\w+\s*)?\{([^}]*)\}/g;
  while ((m = en.exec(src))) out.models[m[1]] = { lang: 'cs', fields: [], enumValues: m[2].split(',').map((s) => s.trim().split(/[\s=]/)[0]).filter(Boolean) };
}

function camel(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function extractParams(block, route) {
  if (!block) return [];
  const m = /^CSPARAMS\(([\s\S]*)\)$/.exec(block);
  return m ? csParams(m[1], route.method) : [];
}

module.exports = { analyze, extractParams, csParams };

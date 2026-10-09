'use strict';
/**
 * PHP detectors: Laravel (Route::get, resource/apiResource, prefix groups, routes/api.php),
 * Symfony (#[Route] attributes and @Route annotations), Slim / Lumen ($app->get('/x', ...)).
 */
const U = require('./util');

function analyze(text, file, out) {
  const src = U.stripComments(text, 'php');
  const lineOf = U.makeLineIndex(src);
  const norm = file.replace(/\\/g, '/');
  const filePrefix = /\/routes\/api\.php$/.test(norm) ? '/api' : '';
  let m;

  // prefix groups (brace scopes)
  const scopes = [];
  const gre = /Route::(?:prefix\(\s*['"]([^'"]+)['"]\s*\)[^;{]*?->group\s*\(|group\s*\(\s*\[([^\]]*)\]\s*,)\s*(?:static\s+)?function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{/g;
  while ((m = gre.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace);
    const prefix = m[1] || U.namedArg(m[2] || '', ['prefix', "'prefix'", '"prefix"']) || (/['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/.exec(m[2] || '') || [])[1] || '';
    if (b) scopes.push({ start: brace, end: b.end, prefix });
  }
  // Slim groups: $app->group('/api', function ($group) { ... })
  const sg = /\$\w+->group\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{/g;
  while ((m = sg.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace);
    if (b) scopes.push({ start: brace, end: b.end, prefix: m[1] });
  }

  // Laravel: Route::get('/x', ...)
  const re = /Route::(get|post|put|patch|delete|options|any|match)\s*\(/g;
  while ((m = re.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    let methods;
    let pathArg;
    let handler;
    if (m[1] === 'match') {
      methods = U.methodsFrom(args[0] || '');
      pathArg = args[1];
      handler = args[2];
    } else {
      methods = [m[1] === 'any' ? 'GET' : m[1].toUpperCase()];
      pathArg = args[0];
      handler = args[1];
    }
    const p = U.firstString(pathArg || '');
    if (p === null) continue;
    const full = U.joinPaths(filePrefix, U.scopePrefix(scopes, m.index), p);
    for (const meth of methods) out.routes.push(withHandler({ method: meth, path: full, line: lineOf(m.index), framework: 'Laravel', keys: ['file:' + file] }, handler));
  }
  // resources
  const rre = /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\w\\]+)(?:::class)?/g;
  while ((m = rre.exec(src))) {
    const base = U.joinPaths(filePrefix, U.scopePrefix(scopes, m.index), m[2].replace(/\./g, '/'));
    const param = ':' + singular(m[2].split(/[./]/).pop());
    const ctrl = m[3].split('\\').pop();
    const items = [['GET', base, 'index'], ['POST', base, 'store'], ['GET', base + '/' + param, 'show'], ['PUT', base + '/' + param, 'update'], ['PATCH', base + '/' + param, 'update'], ['DELETE', base + '/' + param, 'destroy']];
    if (m[1] === 'resource') items.splice(1, 0, ['GET', base + '/create', 'create']), items.splice(4, 0, ['GET', base + '/' + param + '/edit', 'edit']);
    for (const [meth, p, action] of items) out.routes.push({ method: meth, path: p, line: lineOf(m.index), framework: 'Laravel', keys: ['file:' + file], handlerRef: ctrl + '@' + action });
  }

  // Slim / Lumen: $app->get('/x', ...) / $router->post(...)
  const sre = /\$(\w+)\s*->\s*(get|post|put|patch|delete|options|any)\s*\(\s*['"](\/[^'"]*)['"]/g;
  while ((m = sre.exec(src))) {
    if (/^(request|this|client|http|response)$/.test(m[1])) continue;
    out.routes.push({ method: m[2] === 'any' ? 'GET' : m[2].toUpperCase(), path: U.joinPaths(U.scopePrefix(scopes, m.index), m[3]), line: lineOf(m.index), framework: /Slim/.test(src) ? 'Slim' : 'Lumen', keys: ['file:' + file] });
  }

  // Symfony attributes / annotations
  const symfony = [];
  const are = /#\[\s*Route\s*\(|@Route\s*\(/g;
  while ((m = are.exec(src))) {
    const open = src.indexOf('(', m.index);
    const b = U.readBalanced(src, open);
    if (!b) continue;
    const after = src.slice(b.end + 1, b.end + 400);
    const isClass = /^[\s\])*/]*(?:(?:#\[[^\]]*\]|\*[^\n]*|\/\*\*?|\*\/)\s*)*(?:final\s+|abstract\s+)*class\s+/.test(after);
    const p = U.firstString(b.inner) || U.namedArg(b.inner, 'path') || '';
    let methods = U.methodsFrom(U.namedArray(b.inner, 'methods') || '');
    symfony.push({ idx: m.index, isClass, path: p, methods, after });
  }
  for (const s of symfony) {
    if (s.isClass) continue;
    const cls = symfony.filter((c) => c.isClass && c.idx < s.idx).pop();
    const fn = /function\s+(\w+)\s*\(([^)]*)\)/.exec(s.after);
    for (const meth of s.methods.length ? s.methods : ['GET']) {
      out.routes.push({ method: meth, path: U.joinPaths(cls ? cls.path : '', s.path), line: lineOf(s.idx), framework: 'Symfony', keys: ['file:' + file], handler: fn ? fn[1] : undefined, block: fn ? src.slice(src.indexOf(fn[0], s.idx), src.indexOf(fn[0], s.idx) + 3000) : null });
    }
  }

  // controller methods index  "Class@method" -> body
  const cre = /\bclass\s+(\w+)[^{]*\{/g;
  while ((m = cre.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace);
    if (!b) continue;
    const fre = /function\s+(\w+)\s*\(/g;
    let f;
    while ((f = fre.exec(b.inner))) {
      const sig = U.readBalanced(b.inner, f.index + f[0].length - 1);
      if (!sig) continue;
      const body = b.inner.indexOf('{', sig.end);
      const bb = body !== -1 ? U.readBalanced(b.inner, body) : null;
      out.functions[m[1] + '@' + f[1]] = '(' + sig.inner + ')' + (bb ? bb.inner : '');
    }
    // FormRequest rules(): return ['name' => 'required|string', ...]
    if (/FormRequest/.test(m[0])) {
      const rules = /function\s+rules\s*\([^)]*\)[^{]*\{[\s\S]*?return\s*\[([\s\S]*?)\];/.exec(b.inner);
      if (rules) out.models[m[1]] = { lang: 'php', fields: laravelRules(rules[1]) };
    }
  }
  if (/artisan|Laravel/.test(src) || filePrefix) out.hints.ports.push({ port: 8000, source: 'default', weak: true });
}

function withHandler(route, handler) {
  if (!handler) return route;
  let m = /\[\s*([\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]/.exec(handler);
  if (m) { route.handlerRef = m[1].split('\\').pop() + '@' + m[2]; return route; }
  m = /^['"]([\w\\]+)@(\w+)['"]$/.exec(handler.trim());
  if (m) { route.handlerRef = m[1].split('\\').pop() + '@' + m[2]; return route; }
  m = /^([\w\\]+)::class$/.exec(handler.trim());
  if (m) { route.handlerRef = m[1].split('\\').pop() + '@__invoke'; return route; }
  route.block = handler;
  return route;
}

function singular(s) {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/ses$/.test(s)) return s.replace(/es$/, '');
  return s.replace(/s$/, '');
}

function laravelRules(body) {
  const fields = [];
  const re = /['"]([\w.*]+)['"]\s*=>\s*(?:['"]([^'"]*)['"]|\[([^\]]*)\])/g;
  let m;
  while ((m = re.exec(body))) {
    const rule = m[2] || m[3] || '';
    if (m[1].includes('.')) continue;
    const type = /integer|numeric/.test(rule) ? 'int' : /boolean/.test(rule) ? 'bool' : /email/.test(rule) ? 'email' : /array/.test(rule) ? 'list<string>' : /date/.test(rule) ? 'date' : 'string';
    fields.push({ name: m[1], type, required: /required/.test(rule) && !/sometimes|nullable/.test(rule) });
  }
  return fields;
}

function extractParams(block) {
  const res = [];
  if (!block) return res;
  const add = (name, where, type, required) => { if (!res.find((p) => p.name === name && p.in === where)) res.push({ name, in: where, type: type || 'string', required: !!required }); };
  let m;
  const q = /\$request->(?:query|get)\(\s*['"]([^'"]+)['"]|\$_GET\[\s*['"]([^'"]+)['"]\s*\]|\$request->query->get\(\s*['"]([^'"]+)['"]/g;
  while ((m = q.exec(block))) add(m[1] || m[2] || m[3], 'query');
  const b = /\$request->(?:input|post|json)\(\s*['"]([^'"]+)['"]|\$_POST\[\s*['"]([^'"]+)['"]\s*\]|\$request->request->get\(\s*['"]([^'"]+)['"]/g;
  while ((m = b.exec(block))) add(m[1] || m[2] || m[3], 'body');
  const h = /\$request->(?:header|headers->get)\(\s*['"]([^'"]+)['"]/g;
  while ((m = h.exec(block))) add(m[1], 'header');
  const f = /\$request->file\(\s*['"]([^'"]+)['"]/g;
  while ((m = f.exec(block))) add(m[1], 'file', 'file');
  const v = /->validate\(\s*\[([\s\S]*?)\]\s*\)/.exec(block);
  if (v) for (const fld of laravelRules(v[1])) add(fld.name, 'body', fld.type, fld.required);
  const fr = /^\(\s*(\w+Request)\s+\$\w+/.exec(block);
  if (fr && fr[1] !== 'Request') res.push({ name: 'body', in: 'body', model: fr[1], type: fr[1] });
  return res;
}

module.exports = { analyze, extractParams };

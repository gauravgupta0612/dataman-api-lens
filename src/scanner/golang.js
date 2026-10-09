'use strict';
/**
 * Go detectors: net/http (incl. Go 1.22 "GET /x/{id}" patterns), gorilla/mux, gin, echo, fiber, chi.
 */
const U = require('./util');

const VERBS = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS', Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Head: 'HEAD', Options: 'OPTIONS', Any: 'GET', All: 'GET' };

function analyze(text, file, out) {
  const src = U.stripComments(text, 'c', true);
  const lineOf = U.makeLineIndex(src);
  const fw = /gin-gonic\/gin/.test(src) ? 'Gin' : /labstack\/echo/.test(src) ? 'Echo' : /gofiber\/fiber/.test(src) ? 'Fiber' : /go-chi\/chi/.test(src) ? 'Chi' : /gorilla\/mux/.test(src) ? 'Gorilla Mux' : 'net/http';
  let m;

  // function ranges (for chi Mount(fn()) and handler lookup)
  const fnRanges = U.functionRanges(src, /\bfunc\s+(?:\([^)]*\)\s*)?(\w+)\s*\([^)]*\)[^{\n]*/g, true);
  for (const r of fnRanges) if (!out.functions[r.name]) out.functions[r.name] = r.body;

  // groups: v1 := r.Group("/v1") ; api := app.Group("/api") ; s := r.PathPrefix("/api").Subrouter()
  const groups = {};
  const gre = /\b(\w+)\s*:?=\s*(\w+)\s*\.\s*(?:Group|PathPrefix)\s*\(\s*"([^"]*)"/g;
  while ((m = gre.exec(src))) groups[m[1]] = { parent: m[2], prefix: m[3] };
  const prefixOf = (v, seen = new Set()) => {
    if (!groups[v] || seen.has(v)) return '';
    seen.add(v);
    return U.joinPaths(prefixOf(groups[v].parent, seen), groups[v].prefix);
  };
  // chi r.Route("/x", func(r chi.Router) { ... })  and gin/echo/fiber group blocks with closures
  const scopes = [];
  const sre = /\b\w+\s*\.\s*Route\s*\(\s*"([^"]*)"\s*,\s*func\s*\([^)]*\)\s*\{/g;
  while ((m = sre.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace, true);
    if (b) scopes.push({ start: brace, end: b.end, prefix: m[1] });
  }
  // chi Mount: r.Mount("/admin", adminRouter())
  const mre = /\b(\w+)\s*\.\s*Mount\s*\(\s*"([^"]*)"\s*,\s*(\w+)\s*\(/g;
  while ((m = mre.exec(src))) {
    const enc = U.enclosingName(fnRanges, m.index);
    out.mounts.push({ target: 'gofn:' + m[3], prefix: U.joinPaths(U.scopePrefix(scopes, m.index), prefixOf(m[1]), m[2]), from: enc ? ['gofn:' + enc] : [] });
  }

  const emit = (method, p, idx, handler, framework) => {
    const enc = U.enclosingName(fnRanges, idx);
    const r = { method, path: p, line: lineOf(idx), framework, keys: enc ? ['gofn:' + enc] : ['file:' + file] };
    const h = (handler || '').trim();
    if (/^func\s*\(/.test(h)) {
      const brace = h.indexOf('{');
      r.block = brace !== -1 ? h.slice(brace) : h;
    } else {
      const ref = /(?:^|\.)(\w+)(?:\(\))?$/.exec(h.replace(/^http\.HandlerFunc\(|\)$/g, ''));
      if (ref) r.handlerRef = ref[1];
    }
    out.routes.push(r);
  };

  // r.GET("/x", h) / e.POST / app.Get / r.Get (chi) / r.Any
  const re = /\b(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(/g;
  while ((m = re.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (args.length < 2) continue;
    const p = U.firstString(args[0]);
    if (p === null || !(p.startsWith('/') || p === '')) continue;
    if (/^(http|os|c|ctx|req|r\.Header|w\.Header|resp)$/.test(m[1]) && fw !== 'Chi') continue;
    const full = U.joinPaths(U.scopePrefix(scopes, m.index), prefixOf(m[1]), p);
    emit(VERBS[m[2]], full, m.index, args[args.length - 1], fw);
  }

  // HandleFunc / Handle  (net/http, gorilla) + .Methods("GET", "POST")
  const hre = /\b(\w+)\s*\.\s*(HandleFunc|Handle)\s*\(/g;
  while ((m = hre.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const args = U.splitTopLevel(b.inner);
    if (args.length < 2) continue;
    let p = U.firstString(args[0]);
    if (p === null) continue;
    let methods = [];
    const go122 = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)$/.exec(p);
    if (go122) { methods = [go122[1]]; p = go122[2]; }
    const after = src.slice(b.end + 1, b.end + 200);
    const mm = /^\s*\.\s*Methods\s*\(([^)]*)\)/.exec(after);
    if (mm) methods = U.methodsFrom(mm[1]);
    if (!methods.length) methods = ['GET'];
    p = p.replace(/^[\w.-]+(?=\/)/, ''); // host patterns  example.com/path
    const full = U.joinPaths(U.scopePrefix(scopes, m.index), prefixOf(m[1]), p) + (p.endsWith('/') && p.length > 1 ? '/' : '');
    for (const meth of methods) emit(meth, full.replace(/\{\$\}$/, ''), m.index, args[args.length - 1], mm || go122 ? (fw === 'net/http' ? 'net/http' : fw) : fw);
  }

  // structs
  const sre2 = /\btype\s+(\w+)\s+struct\s*\{/g;
  while ((m = sre2.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const fields = [];
    for (const line of b.inner.split('\n')) {
      const f = /^\s*(\w+)\s+([\w.*[\]{}]+)\s*(`[^`]*`)?/.exec(line);
      if (!f || !/^[A-Z]/.test(f[1])) continue;
      const tag = f[3] || '';
      const json = /json:"([^",]*)(,[^"]*)?"/.exec(tag) || /form:"([^",]*)/.exec(tag);
      if (json && json[1] === '-') continue;
      fields.push({ name: json && json[1] ? json[1] : f[1], type: f[2], required: /binding:"[^"]*required|validate:"[^"]*required/.test(tag) });
    }
    if (fields.length) out.models[m[1]] = { lang: 'go', fields };
  }

  // ports
  const pr = /(?:\.Run|ListenAndServe(?:TLS)?|\.Listen|\.Start)\s*\(\s*"[^":]*:(\d{2,5})"|Addr\s*:\s*"[^":]*:(\d{2,5})"/g;
  while ((m = pr.exec(src))) out.hints.ports.push({ port: +(m[1] || m[2]), source: file });
  if (fw === 'Gin' && /\.Run\(\s*\)/.test(src)) out.hints.ports.push({ port: 8080, source: 'default', weak: true });
}

function extractParams(block) {
  const res = [];
  if (!block) return res;
  const add = (name, where, type) => { if (name && !res.find((p) => p.name === name && p.in === where)) res.push({ name, in: where, type: type || 'string', required: where === 'path' }); };
  let m;
  const rules = [
    [/\b\w+\.(?:Query|DefaultQuery|GetQuery|QueryArray|QueryParam|QueryParams\(\)\.Get)\(\s*"([^"]+)"/g, 'query'],
    [/\bURL\.Query\(\)\.Get\(\s*"([^"]+)"|\bquery\.Get\(\s*"([^"]+)"/g, 'query'],
    [/\b\w+\.(?:Param|Params|PathValue)\(\s*"([^"]+)"|chi\.URLParam\(\s*\w+\s*,\s*"([^"]+)"|mux\.Vars\(\s*\w+\s*\)\[\s*"([^"]+)"\s*\]|vars\[\s*"([^"]+)"\s*\]/g, 'path'],
    [/\b\w+\.(?:PostForm|DefaultPostForm|FormValue|PostFormValue)\(\s*"([^"]+)"/g, 'form'],
    [/\b\w+\.FormFile\(\s*"([^"]+)"/g, 'file'],
    [/\b\w+\.(?:GetHeader|Header\.Get)\(\s*"([^"]+)"|\bHeader\(\)\.Get\(\s*"([^"]+)"|\bc\.Get\(\s*"([^"]+)"/g, 'header'],
  ];
  for (const [re, where] of rules) while ((m = re.exec(block))) add(m[1] || m[2] || m[3] || m[4], where);
  // body binding: c.ShouldBindJSON(&req) / json.NewDecoder(r.Body).Decode(&req) / c.Bind(&req) / c.BodyParser(&req)
  const bind = /(?:ShouldBind(?:JSON|With)?|BindJSON|Bind|BodyParser|Decode|Unmarshal)\(\s*(?:[^,()]*,\s*)?&(\w+)/.exec(block);
  if (bind) {
    const v = bind[1];
    const decl = new RegExp('\\bvar\\s+' + v + '\\s+\\*?([\\w.]+)|\\b' + v + '\\s*:=\\s*&?([\\w.]+)\\s*\\{|\\b' + v + '\\s*:=\\s*new\\(([\\w.]+)\\)').exec(block);
    const t = decl ? (decl[1] || decl[2] || decl[3]).split('.').pop() : null;
    const isQuery = /ShouldBindQuery|BindQuery/.test(block);
    res.push(t ? { name: v, in: isQuery ? 'query' : 'body', type: t, model: t } : { name: '__body__', in: 'body', type: 'object', wholeBody: true });
  }
  return res;
}

module.exports = { analyze, extractParams };

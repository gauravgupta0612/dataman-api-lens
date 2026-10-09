'use strict';
/**
 * Rust detectors: Actix-web (#[get] attributes, web::scope, .route), Rocket (#[get("/x?<q>")]),
 * Axum (.route("/x", get(h).post(h2)), .nest("/api", fn())) and Warp-free serde models.
 */
const U = require('./util');

function analyze(text, file, out) {
  const src = U.stripComments(text, 'c', true);
  const lineOf = U.makeLineIndex(src);
  const fw = /\baxum\b/.test(src) ? 'Axum' : /\brocket\b/.test(src) ? 'Rocket' : /actix_web/.test(src) ? 'Actix' : 'Rust';
  let m;
  const fnRanges = U.functionRanges(src, /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^{]*?\)[^{;]*/g, true);
  for (const r of fnRanges) if (!out.functions[r.name]) out.functions[r.name] = r.body;

  // attribute routes (actix, rocket)
  const are = /#\[\s*(get|post|put|delete|patch|head|options|route)\s*\(\s*"([^"]*)"([^\]]*)\]/g;
  while ((m = are.exec(src))) {
    let methods = m[1] === 'route' ? U.methodsFrom((m[3].match(/method\s*=\s*"(\w+)"/g) || []).join(' ')) : [m[1].toUpperCase()];
    if (!methods.length) methods = ['GET'];
    const fn = /\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/y;
    fn.lastIndex = m.index + m[0].length;
    const f = fn.exec(src);
    let sig = '';
    if (f) {
      const b = U.readBalanced(src, f.index + f[0].length - 1, true);
      if (b) sig = b.inner;
    }
    let p = m[2];
    const query = [];
    const qm = /\?(.*)$/.exec(p);
    if (qm) {
      p = p.slice(0, qm.index);
      for (const q of qm[1].split('&')) { const n = /<(\w+)(?:\.\.)?>/.exec(q); if (n) query.push(n[1]); }
    }
    const dataArg = (/data\s*=\s*"<(\w+)>"/.exec(m[3]) || [])[1];
    for (const meth of methods) {
      out.routes.push({ method: meth, path: p, line: lineOf(m.index), framework: fw === 'Rust' ? (/rocket/.test(src) ? 'Rocket' : 'Actix') : fw, keys: f ? ['rsfn:' + f[1], 'file:' + file] : ['file:' + file], signature: sig, rocketQuery: query, rocketData: dataArg, handler: f ? f[1] : undefined });
    }
  }

  // actix: web::scope("/api").service(handler).route("/x", web::get().to(h))
  const sre = /web::scope\(\s*"([^"]*)"\s*\)/g;
  while ((m = sre.exec(src))) {
    // read the chained calls following the scope
    let i = m.index + m[0].length;
    for (;;) {
      const cm = /^\s*\.\s*(\w+)\s*\(/.exec(src.slice(i, i + 300));
      if (!cm) break;
      const open = i + cm[0].length - 1;
      const b = U.readBalanced(src, open, true);
      if (!b) break;
      if (cm[1] === 'service') {
        const name = /^\s*(\w+)\s*$/.exec(b.inner);
        if (name) out.mounts.push({ target: 'rsfn:' + name[1], prefix: m[1], from: [] });
      } else if (cm[1] === 'route') {
        const rm = /^\s*"([^"]*)"\s*,\s*web::(get|post|put|delete|patch)\(\)\s*\.to\(\s*([\w:]+)\s*\)/.exec(b.inner);
        if (rm) out.routes.push({ method: rm[2].toUpperCase(), path: U.joinPaths(m[1], rm[1]), line: lineOf(open), framework: 'Actix', keys: ['file:' + file], handlerRef: rm[3].split('::').pop() });
      }
      i = b.end + 1;
    }
  }

  // .route("/x", web::get().to(h))  (actix, outside scopes)  and axum .route("/x", get(h).post(h2))
  const rre = /\.\s*route\s*\(\s*"([^"]*)"\s*,/g;
  while ((m = rre.exec(src))) {
    const open = src.indexOf('(', m.index);
    const b = U.readBalanced(src, open, true);
    if (!b) continue;
    const handlerExpr = b.inner.slice(b.inner.indexOf(',') + 1);
    const inScope = /web::scope\(\s*"[^"]*"\s*\)[^;]*$/.test(src.slice(Math.max(0, m.index - 400), m.index)) && !/;/.test(src.slice(src.lastIndexOf('web::scope', m.index), m.index));
    if (inScope) continue;
    const enc = U.enclosingName(fnRanges, m.index);
    const keys = enc ? ['rsfn:' + enc] : ['file:' + file];
    const ax = /\b(?:routing::)?(get|post|put|delete|patch|head|options)\s*\(\s*([\w:]+)/g;
    let h;
    let found = false;
    while ((h = ax.exec(handlerExpr))) {
      found = true;
      out.routes.push({ method: h[1].toUpperCase(), path: m[1], line: lineOf(m.index), framework: /web::/.test(handlerExpr) ? 'Actix' : 'Axum', keys, handlerRef: h[2].split('::').pop() });
    }
    const ac = /web::(get|post|put|delete|patch)\(\)\s*\.to\(\s*([\w:]+)/.exec(handlerExpr);
    if (!found && ac) out.routes.push({ method: ac[1].toUpperCase(), path: m[1], line: lineOf(m.index), framework: 'Actix', keys, handlerRef: ac[2].split('::').pop() });
  }
  // axum nest: .nest("/api", api_routes())
  const nre = /\.\s*nest\s*\(\s*"([^"]*)"\s*,\s*([\w:]+)\s*\(/g;
  while ((m = nre.exec(src))) {
    const enc = U.enclosingName(fnRanges, m.index);
    out.mounts.push({ target: 'rsfn:' + m[2].split('::').pop(), prefix: m[1], from: enc ? ['rsfn:' + enc] : [] });
  }
  // rocket mount: .mount("/api", routes![a, b])
  const mre = /\.\s*mount\s*\(\s*"([^"]*)"\s*,\s*routes!\s*\[([^\]]*)\]/g;
  while ((m = mre.exec(src))) for (const n of m[2].split(',').map((s) => s.trim().split('::').pop()).filter(Boolean)) out.mounts.push({ target: 'rsfn:' + n, prefix: m[1], from: [] });

  // serde structs
  const st = /\bstruct\s+(\w+)\s*(?:<[^>]*>)?\s*\{/g;
  while ((m = st.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const camel = /rename_all\s*=\s*"camelCase"/.test(before);
    const fields = [];
    const fre = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([^,\n]+)/g;
    let f;
    while ((f = fre.exec(b.inner))) {
      const ren = /rename\s*=\s*"([^"]+)"/.exec(f[1]);
      const name = ren ? ren[1] : camel ? f[2].replace(/_(\w)/g, (_, c) => c.toUpperCase()) : f[2];
      fields.push({ name, type: f[3].trim().replace(/,$/, ''), required: !/^Option</.test(f[3].trim()) });
    }
    if (fields.length) out.models[m[1]] = { lang: 'rust', fields };
  }
  const pr = /(?:bind|TcpListener::bind)\s*\(\s*(?:\(\s*"[^"]*"\s*,\s*(\d{2,5})|"[^":]*:(\d{2,5})")/g;
  while ((m = pr.exec(src))) out.hints.ports.push({ port: +(m[1] || m[2]), source: file });
  if (fw === 'Rocket') out.hints.ports.push({ port: 8000, source: 'default', weak: true });
}

function extractParams(block, route) {
  const res = [];
  const sig = route && route.signature !== undefined ? route.signature : sigOf(block);
  for (const raw of U.splitTopLevel(sig || '')) {
    const m = /^(?:mut\s+)?([\w(), ]+?)\s*:\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const type = m[2].trim();
    let w;
    if ((w = /^(?:web::|axum::extract::)?Json\s*<\s*(.+)\s*>$/.exec(type))) res.push({ name: 'body', in: 'body', model: w[1], type: w[1] });
    else if ((w = /^(?:web::|axum::extract::)?Query\s*<\s*(.+)\s*>$/.exec(type))) res.push({ name: 'query', in: 'query', model: w[1], type: w[1] });
    else if ((w = /^(?:web::|axum::extract::)?Form\s*<\s*(.+)\s*>$/.exec(type))) res.push({ name: 'form', in: 'form', model: w[1], type: w[1] });
    else if (/^(?:web::|axum::extract::)?Path\s*</.test(type)) continue; // covered by path template
    else if (/^TypedHeader\s*<\s*(?:headers::)?(\w+)/.test(type)) res.push({ name: /^TypedHeader\s*<\s*(?:headers::)?(\w+)/.exec(type)[1].replace(/([a-z])([A-Z])/g, '$1-$2'), in: 'header', type: 'string', required: true });
  }
  if (route && route.rocketQuery) for (const q of route.rocketQuery) res.push({ name: q, in: 'query', type: 'string', required: false });
  if (route && route.rocketData) {
    const m = new RegExp('\\b' + route.rocketData + '\\s*:\\s*(?:Json|Form)\\s*<\\s*([\\w:]+)').exec(sig || '');
    if (m) res.push({ name: 'body', in: 'body', model: m[1], type: m[1] });
  }
  return res;
}

function sigOf(block) {
  if (!block) return '';
  const m = /fn\s+\w+\s*(?:<[^>]*>)?\s*\(/.exec(block);
  if (!m) return '';
  const b = U.readBalanced(block, m.index + m[0].length - 1, true);
  return b ? b.inner : '';
}

module.exports = { analyze, extractParams };

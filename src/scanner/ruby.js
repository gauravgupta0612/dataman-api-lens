'use strict';
/**
 * Ruby detectors: Rails config/routes.rb (resources, resource, namespace, scope, member/collection, nested)
 * and Sinatra / Roda-style `get '/x' do` blocks.
 */
const U = require('./util');

function analyze(text, file, out) {
  const src = U.stripComments(text, 'hash');
  const lineOf = U.makeLineIndex(src);
  if (/config[\\/]routes\.rb$/.test(file) || /Rails\.application\.routes\.draw/.test(src)) rails(src, file, out);
  else sinatra(src, file, out, lineOf);
  // models: ActiveRecord / Struct-ish attributes are not reliable — collect strong params instead
  let m;
  const sp = /def\s+(\w+)_params[\s\S]*?\.permit\(([^)]*)\)/g;
  while ((m = sp.exec(src))) {
    const fields = (m[2].match(/:(\w+)/g) || []).map((s) => ({ name: s.slice(1), type: 'string', required: false }));
    const req = new RegExp('params\\.require\\(:' + '(\\w+)' + '\\)').exec(m[0]);
    const model = { lang: 'ruby', fields };
    out.models[cap(m[1]) + 'Params'] = req ? { lang: 'ruby', fields: [{ name: req[1], type: cap(m[1]) + 'Inner', required: true }] } : model;
    if (req) out.models[cap(m[1]) + 'Inner'] = model;
  }
  const ctrl = /(\w+)_controller\.rb$/.exec(file);
  const fre = /^\s*def\s+(\w+)/gm;
  while ((m = fre.exec(src))) {
    const end = src.indexOf('\n  def ', m.index + 1);
    const body = src.slice(m.index, end === -1 ? undefined : end);
    if (ctrl) out.functions[ctrl[1] + '#' + m[1]] = body;
    else if (!out.functions[m[1]]) out.functions[m[1]] = body;
  }
  if (/Rails|ActionController/.test(src)) out.hints.ports.push({ port: 3000, source: 'default', weak: true });
  if (/sinatra/i.test(src)) out.hints.ports.push({ port: 4567, source: 'default', weak: true });
}

function cap(s) {
  return s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

function singular(s) {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/sses$/.test(s)) return s.replace(/es$/, '');
  return s.replace(/s$/, '');
}

function rails(src, file, out) {
  const lines = src.split('\n');
  const stack = []; // frames: { prefix, kind: 'ns'|'resources'|'resource'|'member'|'collection'|'other', name }
  const currentPrefix = () => {
    let p = '';
    for (const f of stack) p = U.joinPaths(p, f.prefix || '');
    return p;
  };
  const push = (method, p, line, handler) => out.routes.push({ method, path: p, line, framework: 'Rails', keys: ['file:' + file], handlerRef: handler });
  const actionsFor = (args, all) => {
    const only = /only:\s*(?:\[([^\]]*)\]|:(\w+))/.exec(args);
    const except = /except:\s*(?:\[([^\]]*)\]|:(\w+))/.exec(args);
    let acts = all;
    if (only) acts = (only[1] || ':' + only[2]).match(/\w+/g) || [];
    if (except) { const ex = (except[1] || ':' + except[2]).match(/\w+/g) || []; acts = acts.filter((a) => !ex.includes(a)); }
    return acts;
  };
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const opensBlock = /\bdo(\s*\|[^|]*\|)?\s*$/.test(line);
    let m;
    if (line === 'end') { stack.pop(); return; }
    if ((m = /^namespace\s+:(\w+)/.exec(line))) { if (opensBlock) stack.push({ prefix: m[1], kind: 'ns' }); return; }
    if ((m = /^scope\s+(?:path:\s*)?['"]([^'"]*)['"]|^scope\s+(?:module:|path:)?\s*:?(\w+)?/.exec(line))) {
      const p = m[1] || (/path:\s*['"]([^'"]+)['"]/.exec(line) || [])[1] || '';
      if (opensBlock) stack.push({ prefix: p, kind: 'ns' });
      return;
    }
    if ((m = /^(resources|resource)\s+:(\w+)(.*)$/.exec(line))) {
      const plural = m[1] === 'resources';
      const name = m[2];
      const args = m[3] || '';
      const pathOpt = (/path:\s*['"]([^'"]+)['"]/.exec(args) || [])[1];
      // nested under a resources frame -> /parents/:parent_id/
      const parent = [...stack].reverse().find((f) => f.kind === 'resources' || f.kind === 'resource' || f.kind === 'member' || f.kind === 'collection');
      let base = currentPrefix();
      if (parent && parent.kind === 'resources') base = U.joinPaths(parent.collPath, ':' + singular(parent.name) + '_id');
      else if (parent && parent.kind === 'resource') base = parent.collPath;
      const coll = U.joinPaths(base, pathOpt || name);
      const id = U.joinPaths(coll, ':id');
      const ctrl = name;
      if (plural) {
        const acts = actionsFor(args, ['index', 'create', 'new', 'show', 'edit', 'update', 'destroy']);
        if (acts.includes('index')) push('GET', coll, idx, ctrl + '#index');
        if (acts.includes('create')) push('POST', coll, idx, ctrl + '#create');
        if (acts.includes('new')) push('GET', U.joinPaths(coll, 'new'), idx, ctrl + '#new');
        if (acts.includes('show')) push('GET', id, idx, ctrl + '#show');
        if (acts.includes('edit')) push('GET', U.joinPaths(id, 'edit'), idx, ctrl + '#edit');
        if (acts.includes('update')) { push('PATCH', id, idx, ctrl + '#update'); push('PUT', id, idx, ctrl + '#update'); }
        if (acts.includes('destroy')) push('DELETE', id, idx, ctrl + '#destroy');
      } else {
        const acts = actionsFor(args, ['create', 'new', 'show', 'edit', 'update', 'destroy']);
        if (acts.includes('show')) push('GET', coll, idx, ctrl + '#show');
        if (acts.includes('create')) push('POST', coll, idx, ctrl + '#create');
        if (acts.includes('new')) push('GET', U.joinPaths(coll, 'new'), idx, ctrl + '#new');
        if (acts.includes('edit')) push('GET', U.joinPaths(coll, 'edit'), idx, ctrl + '#edit');
        if (acts.includes('update')) { push('PATCH', coll, idx, ctrl + '#update'); push('PUT', coll, idx, ctrl + '#update'); }
        if (acts.includes('destroy')) push('DELETE', coll, idx, ctrl + '#destroy');
      }
      if (opensBlock) stack.push({ prefix: '', kind: plural ? 'resources' : 'resource', name, collPath: coll, idPath: plural ? id : coll });
      return;
    }
    if (/^member\s+do/.test(line)) { stack.push({ prefix: '', kind: 'member' }); return; }
    if (/^collection\s+do/.test(line)) { stack.push({ prefix: '', kind: 'collection' }); return; }
    if ((m = /^(get|post|put|patch|delete|match)\s+(?:['"]([^'"]+)['"]|:(\w+))(.*)$/.exec(line))) {
      const top = stack[stack.length - 1];
      const res = [...stack].reverse().find((f) => f.kind === 'resources' || f.kind === 'resource');
      let p;
      const seg = m[2] || m[3];
      if (top && top.kind === 'member' && res) p = U.joinPaths(res.idPath, seg);
      else if (top && top.kind === 'collection' && res) p = U.joinPaths(res.collPath, seg);
      else if (top && (top.kind === 'resources') && res) p = U.joinPaths(m[3] ? res.idPath : res.collPath, seg);
      else p = U.joinPaths(currentPrefix(), seg);
      let methods = m[1] === 'match' ? U.methodsFrom((/via:\s*(\[[^\]]*\]|:\w+)/.exec(m[4]) || [])[1] || '') : [m[1].toUpperCase()];
      if (!methods.length) methods = ['GET'];
      const to = /to:\s*['"]([\w/]+#\w+)['"]|=>\s*['"]([\w/]+#\w+)['"]/.exec(m[4]);
      for (const meth of methods) push(meth, p, idx, to ? (to[1] || to[2]) : undefined);
      if (opensBlock) stack.push({ prefix: '', kind: 'other' });
      return;
    }
    if ((m = /^root\s+(?:to:\s*)?['"]([^'"]+)['"]/.exec(line))) { push('GET', currentPrefix() || '/', idx, m[1]); return; }
    if (opensBlock) stack.push({ prefix: '', kind: 'other' });
  });
}

function sinatra(src, file, out, lineOf) {
  const re = /^[ \t]*(get|post|put|patch|delete|options)\s*\(?\s*['"](\/[^'"]*)['"]\s*\)?\s*(?:do|\{)/gm;
  let m;
  while ((m = re.exec(src))) {
    const end = src.indexOf('\nend', m.index);
    out.routes.push({ method: m[1].toUpperCase(), path: m[2], line: lineOf(m.index), framework: /Grape/.test(src) ? 'Grape' : 'Sinatra', keys: ['file:' + file], block: src.slice(m.index, end === -1 ? m.index + 1500 : end) });
  }
}

function extractParams(block, route) {
  const res = [];
  if (!block) return res;
  let m;
  const re = /\bparams\[\s*(?::(\w+)|['"]([^'"]+)['"])\s*\]|params\.(?:fetch|require)\(\s*:(\w+)/g;
  const where = route && ['POST', 'PUT', 'PATCH'].includes(route.method) ? 'body' : 'query';
  const pathNames = U.pathParamsOf(U.normalizePath(route ? route.path : ''));
  while ((m = re.exec(block))) {
    const name = m[1] || m[2] || m[3];
    if (pathNames.includes(name)) continue;
    if (!res.find((p) => p.name === name)) res.push({ name, in: where, type: 'string', required: false });
  }
  const sp = /\b(\w+)_params\b/.exec(block);
  if (sp && where === 'body') res.push({ name: 'body', in: 'body', model: cap(sp[1]) + 'Params', type: cap(sp[1]) + 'Params' });
  const hd = /request\.headers\[\s*['"]([^'"]+)['"]\s*\]/g;
  while ((m = hd.exec(block))) res.push({ name: m[1], in: 'header', type: 'string', required: false });
  return res;
}

module.exports = { analyze, extractParams };

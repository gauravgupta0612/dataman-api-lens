'use strict';
/**
 * API documentation generator: one self-contained HTML page (or Markdown file) for the discovered APIs —
 * grouped by project and resource, with parameters, request body, example response, cURL and source location.
 * Pure Node so it can be reused / tested; the HTML works both inside a VS Code webview and as a standalone file.
 */
const path = require('path');
const { exampleResponse } = require('./mock');

const IN_LABEL = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie', form: 'Form field', file: 'File' };

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resourceOf(p) {
  const segs = p.split('/').filter((s) => s && !s.startsWith(':') && !/^(api|v\d+(\.\d+)?|rest|public|internal)$/i.test(s));
  return segs[0] ? '/' + segs[0] : '/';
}

function slug(e) {
  return (e.method + '-' + e.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + e.id;
}

function curlFor(e, baseUrl, mockSample) {
  const url = (baseUrl || '{{baseUrl}}').replace(/\/$/, '') + e.path.replace(/:(\w+)/g, '{$1}');
  const q = e.params.filter((p) => p.in === 'query' && p.required).map((p) => `${p.name}={${p.name}}`);
  const lines = [`curl -X ${e.method} '${url}${q.length ? '?' + q.join('&') : ''}'`];
  for (const h of e.params.filter((p) => p.in === 'header')) lines.push(`  -H '${h.name}: {${h.name}}'`);
  if (e.body && e.body.mode === 'json') {
    lines.push("  -H 'Content-Type: application/json'");
    lines.push(`  -d '${JSON.stringify(e.body.example === undefined ? {} : e.body.example).replace(/'/g, "'\\''")}'`);
  } else if (e.body && (e.body.mode === 'urlencoded' || e.body.mode === 'formdata')) {
    for (const f of e.params.filter((p) => p.in === 'form' || p.in === 'file')) lines.push(`  -F '${f.name}=${f.in === 'file' ? '@file' : '{' + f.name + '}'}'`);
  }
  void mockSample;
  return lines.join(' \\\n');
}

function relFile(file, roots) {
  for (const r of roots || []) {
    if (r && file.toLowerCase().startsWith(r.toLowerCase())) return path.relative(r, file).replace(/\\/g, '/');
  }
  return path.basename(file);
}

/** Collect a normalized model shared by the HTML and Markdown renderers. */
function model(sources, opts = {}) {
  const all = sources.flatMap((s) => s.endpoints);
  const mocks = opts.mocks || {};
  return sources
    .filter((s) => s.endpoints.length)
    .map((s) => {
      const groups = new Map();
      for (const e of s.endpoints) {
        const g = e.tags && e.tags.length ? e.tags[0] : resourceOf(e.path);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
      return {
        name: s.name,
        root: s.root,
        groups: [...groups.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, eps]) => ({
            name,
            endpoints: eps
              .slice()
              .sort((a, b) => a.path.localeCompare(b.path) || order(a.method) - order(b.method))
              .map((e) => {
                const saved = mocks[e.method + ' ' + e.path];
                let response;
                if (saved) {
                  let b = saved.body;
                  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (err) { /* text */ } }
                  response = { status: saved.status || 200, body: b, source: 'saved mock' };
                } else {
                  const ex = exampleResponse(e, all);
                  response = { status: ex.status, body: ex.body, source: ex.source === 'spec' ? 'documented' : 'generated' };
                }
                return { e, response, file: relFile(e.file, [s.root, ...(opts.roots || [])]) };
              }),
          })),
      };
    });
}

function order(m) {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].indexOf(m);
}

function pretty(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

// ------------------------------------------------------------------ HTML
function renderHtml(sources, opts = {}) {
  const data = model(sources, opts);
  const total = data.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.endpoints.length, 0), 0);
  const counts = {};
  for (const s of data) for (const g of s.groups) for (const x of g.endpoints) counts[x.e.method] = (counts[x.e.method] || 0) + 1;
  const title = opts.title || 'API Documentation';
  const nonce = opts.nonce;
  const csp = opts.cspSource !== undefined ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">` : '';
  const nav = data
    .map((s) => `<div class="nav-src">${data.length > 1 ? `<div class="nav-title">${esc(s.name)}</div>` : ''}${s.groups
      .map((g) => `<div class="nav-group"><div class="nav-gname">${esc(g.name)}</div>${g.endpoints
        .map((x) => `<a class="nav-ep" href="#${slug(x.e)}" data-search="${esc((x.e.method + ' ' + x.e.path + ' ' + (x.e.summary || '') + ' ' + (x.e.handler || '')).toLowerCase())}"><span class="m m-${x.e.method}">${x.e.method}</span><span class="p">${esc(x.e.path)}</span></a>`)
        .join('')}</div>`)
      .join('')}</div>`)
    .join('');
  const sections = data
    .map((s) => `${data.length > 1 ? `<h2 class="src-title">${esc(s.name)}</h2>` : ''}${s.groups
      .map((g) => `<h3 class="group-title">${esc(g.name)}</h3>${g.endpoints.map((x) => endpointHtml(x, opts)).join('')}`)
      .join('')}`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${csp}<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body${opts.vscode ? ' class="in-vscode"' : ''}>
<header class="top">
  <div class="brand"><b>${esc(title)}</b><span class="sub">${total} endpoint${total === 1 ? '' : 's'} · generated ${esc(opts.generatedAt || new Date().toISOString().slice(0, 16).replace('T', ' '))}${opts.baseUrl ? ' · base URL <code>' + esc(opts.baseUrl) + '</code>' : ''}</span></div>
  <div class="counts">${Object.entries(counts).sort((a, b) => order(a[0]) - order(b[0])).map(([m, n]) => `<span class="m m-${m}">${m} ${n}</span>`).join('')}</div>
  <div class="tools">${opts.vscode ? '<button data-act="exportHtml">Save HTML</button><button data-act="exportMd">Save Markdown</button><button data-act="refresh">Refresh</button>' : ''}</div>
</header>
<div class="layout">
  <nav class="side"><input id="q" type="search" placeholder="Search endpoints…" autocomplete="off">${nav}</nav>
  <main id="main">${sections || '<p class="empty">No APIs discovered.</p>'}</main>
</div>
<script${nonce ? ` nonce="${nonce}"` : ''}>${SCRIPT}</script>
</body></html>`;
}

function endpointHtml(x, opts) {
  const e = x.e;
  const groups = ['path', 'query', 'header', 'cookie', 'form', 'file']
    .map((k) => [k, e.params.filter((p) => p.in === k)])
    .filter(([, list]) => list.length);
  const paramsHtml = groups.length
    ? `<table class="params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${groups
        .flatMap(([k, list]) => list.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${IN_LABEL[k]}</td><td><code>${esc(p.type || 'string')}</code></td><td>${p.required ? '<span class="req">required</span>' : 'optional'}</td><td>${esc(p.description || '')}${p.enum ? ' <span class="muted">one of: ' + esc(p.enum.join(', ')) + '</span>' : ''}${p.example !== undefined && p.example !== null && p.example !== '' ? ' <span class="muted">e.g. ' + esc(p.example) + '</span>' : ''}</td></tr>`))
        .join('')}</tbody></table>`
    : '<p class="muted">No parameters.</p>';
  const body = e.body && e.body.mode !== 'none'
    ? `<h4>Request body <span class="pill">${esc(e.body.mode === 'json' ? 'application/json' : e.body.mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : e.body.mode === 'formdata' ? 'multipart/form-data' : e.body.mode)}</span></h4>${e.body.example !== undefined ? codeBlock(pretty(e.body.example), 'json') : '<p class="muted">See form fields above.</p>'}`
    : '';
  const r = x.response;
  const resp = `<h4>Response <span class="status s${String(r.status)[0]}">${r.status}</span> <span class="pill" title="${r.source === 'generated' ? 'Generated from the request models — save a real response as a mock to make it exact' : ''}">${esc(r.source)}</span></h4>${r.body === null || r.body === undefined || r.body === '' ? '<p class="muted">No content.</p>' : codeBlock(pretty(r.body), 'json')}`;
  const src = e.fromSpec ? `Documented in <code>${esc(x.file)}</code>` : `<code>${esc(x.file)}:${e.line + 1}</code>`;
  return `<section class="ep" id="${slug(e)}" data-search="${esc((e.method + ' ' + e.path + ' ' + (e.summary || '') + ' ' + (e.handler || '')).toLowerCase())}">
  <div class="ep-head"><span class="m m-${e.method}">${e.method}</span><span class="path">${esc(e.path).replace(/:(\w+)/g, '<em>:$1</em>')}</span>
  ${opts.vscode ? `<span class="acts"><button data-act="open" data-id="${esc(e.id)}">Try it</button>${e.file ? `<button data-act="source" data-id="${esc(e.id)}">Source</button>` : ''}</span>` : ''}</div>
  ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ''}
  <p class="meta">${esc(e.framework)}${e.handler ? ' · <code>' + esc(e.handler) + '</code>' : ''} · ${src}${e.documentedIn ? ' · also in <code>' + esc(path.basename(e.documentedIn)) + '</code>' : ''}</p>
  <h4>Parameters</h4>${paramsHtml}
  ${body}
  ${resp}
  <details><summary>cURL</summary>${codeBlock(curlFor(e, opts.baseUrl), 'bash')}</details>
</section>`;
}

function codeBlock(text, lang) {
  return `<div class="code"><button class="copy" title="Copy">Copy</button><pre class="lang-${lang}">${lang === 'json' ? highlight(text) : esc(text)}</pre></div>`;
}

function highlight(text) {
  return esc(text).replace(/(&quot;(?:\\.|(?!&quot;).)*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, kw, num) => {
    if (str) return `<span class="${colon ? 'jk' : 'js'}">${str}</span>${colon || ''}`;
    if (kw) return `<span class="jb">${kw}</span>`;
    return `<span class="jn">${num}</span>`;
  });
}

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--panel:#f6f8fa;--link:#0969da;--code:#f6f8fa;
--get:#1a7f37;--post:#9a6700;--put:#0969da;--patch:#8250df;--delete:#cf222e;--head:#1b7c83;--options:#6e7781}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--panel:#161b22;--link:#4493f8;--code:#161b22;
--get:#3fb950;--post:#d29922;--put:#4493f8;--patch:#a371f7;--delete:#f85149;--head:#39c5cf;--options:#8d96a0}}
body.in-vscode{--bg:var(--vscode-editor-background);--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--line:var(--vscode-panel-border,#8884);--panel:var(--vscode-sideBar-background,#8881);--link:var(--vscode-textLink-foreground);--code:var(--vscode-textCodeBlock-background,#8882)}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12.5px}
.top{position:sticky;top:0;z-index:2;display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--bg)}
.brand{display:flex;flex-direction:column}.brand b{font-size:17px}.sub{color:var(--muted);font-size:12px}
.counts{display:flex;gap:6px;flex-wrap:wrap}.tools{margin-left:auto;display:flex;gap:6px}
button{font:inherit;font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer}button:hover{border-color:var(--link)}
.layout{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 60px)}
.side{border-right:1px solid var(--line);padding:12px;position:sticky;top:60px;height:calc(100vh - 60px);overflow:auto;background:var(--panel)}
#q{width:100%;padding:6px 8px;margin-bottom:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.nav-title{font-weight:700;margin:10px 0 4px}.nav-gname{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:10px 0 2px}
.nav-ep{display:flex;gap:6px;align-items:baseline;padding:2px 4px;border-radius:4px;color:var(--fg);text-decoration:none;font-size:12.5px}.nav-ep:hover{background:var(--bg)}
.nav-ep .p{font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{display:inline-block;min-width:54px;text-align:center;font-weight:700;font-size:11px;padding:1px 5px;border-radius:4px;color:#fff}
.m-GET{background:var(--get)}.m-POST{background:var(--post)}.m-PUT{background:var(--put)}.m-PATCH{background:var(--patch)}.m-DELETE{background:var(--delete)}.m-HEAD{background:var(--head)}.m-OPTIONS{background:var(--options)}
main{padding:8px 28px 60px;max-width:1100px}.src-title{margin:26px 0 0;padding-bottom:6px;border-bottom:2px solid var(--line)}.group-title{margin:26px 0 6px;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.ep{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0;background:var(--bg)}
.ep-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.path{font-family:ui-monospace,Consolas,monospace;font-size:15px;font-weight:600;word-break:break-all}.path em{color:var(--link);font-style:normal}
.acts{margin-left:auto;display:flex;gap:6px}.summary{margin:6px 0 0}.meta{color:var(--muted);font-size:12px;margin:4px 0 8px}
h4{margin:14px 0 6px;font-size:13px;display:flex;gap:8px;align-items:center}
.params{border-collapse:collapse;width:100%;font-size:13px}.params th,.params td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}.params th{color:var(--muted);font-weight:600;font-size:12px}
.req{color:var(--delete);font-weight:600;font-size:12px}.muted{color:var(--muted)}.empty{color:var(--muted)}
.pill{font-size:11px;font-weight:500;border:1px solid var(--line);border-radius:10px;padding:0 7px;color:var(--muted)}
.status{font-size:11px;font-weight:700;color:#fff;border-radius:10px;padding:0 8px}.s2{background:var(--get)}.s3{background:var(--put)}.s4{background:var(--post)}.s5{background:var(--delete)}
.code{position:relative}.code pre{margin:0;padding:10px 12px;background:var(--code);border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:360px}
.copy{position:absolute;top:6px;right:6px;opacity:.75}.copy:hover{opacity:1}
details{margin-top:10px}summary{cursor:pointer;color:var(--muted);font-size:12.5px}
.jk{color:var(--put)}.js{color:var(--post)}.jn{color:var(--get)}.jb{color:var(--patch)}
.hidden{display:none!important}
@media (max-width:820px){.layout{grid-template-columns:1fr}.side{position:static;height:auto;max-height:40vh}main{padding:8px 14px}}
@media print{.side,.tools,.acts,.copy,#q{display:none}.layout{display:block}.ep{break-inside:avoid}}`;

const SCRIPT = `(function(){
var api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
var q=document.getElementById('q');
q&&q.addEventListener('input',function(){var t=q.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);
document.querySelectorAll('[data-search]').forEach(function(el){var s=el.getAttribute('data-search');el.classList.toggle('hidden',!t.every(function(w){return s.indexOf(w)>=0}))});
document.querySelectorAll('.nav-group,.group-title').forEach(function(g){if(g.classList.contains('nav-group')){g.classList.toggle('hidden',!g.querySelector('.nav-ep:not(.hidden)'))}});});
document.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;
if(b.classList.contains('copy')){var txt=b.parentNode.querySelector('pre').textContent;if(api)api.postMessage({type:'copy',text:txt});else if(navigator.clipboard)navigator.clipboard.writeText(txt);b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200);return;}
var act=b.getAttribute('data-act');if(act&&api)api.postMessage({type:act,id:b.getAttribute('data-id')});});
})();`;

// ------------------------------------------------------------------ Markdown
function renderMarkdown(sources, opts = {}) {
  const data = model(sources, opts);
  const out = [`# ${opts.title || 'API Documentation'}`, '', `_Generated ${opts.generatedAt || new Date().toISOString().slice(0, 10)}${opts.baseUrl ? ` · base URL \`${opts.baseUrl}\`` : ''}_`, ''];
  out.push('## Contents', '');
  for (const s of data) {
    if (data.length > 1) out.push(`- **${s.name}**`);
    for (const g of s.groups) for (const x of g.endpoints) out.push(`${data.length > 1 ? '  ' : ''}- [\`${x.e.method} ${x.e.path}\`](#${slug(x.e)})`);
  }
  out.push('');
  for (const s of data) {
    if (data.length > 1) out.push(`## ${s.name}`, '');
    for (const g of s.groups) {
      out.push(`### ${g.name}`, '');
      for (const x of g.endpoints) {
        const e = x.e;
        out.push(`<a id="${slug(e)}"></a>`, `#### \`${e.method}\` \`${e.path}\``, '');
        if (e.summary) out.push(e.summary, '');
        out.push(`${e.framework}${e.handler ? ` · \`${e.handler}\`` : ''} · \`${x.file}${e.fromSpec ? '' : ':' + (e.line + 1)}\``, '');
        if (e.params.length) {
          out.push('| Name | In | Type | Required | Description |', '|---|---|---|---|---|');
          for (const p of e.params) out.push(`| \`${p.name}\` | ${IN_LABEL[p.in] || p.in} | \`${String(p.type || 'string').replace(/\|/g, '\\|')}\` | ${p.required ? 'yes' : 'no'} | ${String(p.description || '').replace(/\|/g, '\\|')} |`);
          out.push('');
        }
        if (e.body && e.body.mode !== 'none' && e.body.example !== undefined) out.push('**Request body**', '', '```json', pretty(e.body.example), '```', '');
        out.push(`**Response ${x.response.status}** (${x.response.source})`, '');
        if (x.response.body !== null && x.response.body !== undefined && x.response.body !== '') out.push('```json', pretty(x.response.body), '```', '');
        out.push('```bash', curlFor(e, opts.baseUrl), '```', '');
      }
    }
  }
  return out.join('\n');
}

module.exports = { renderHtml, renderMarkdown };

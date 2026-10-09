'use strict';
/**
 * Java / Kotlin detectors: Spring MVC / WebFlux, JAX-RS (Jakarta, Quarkus, RESTEasy, Jersey), Micronaut and Ktor.
 * Also collects POJO / record / Kotlin data-class models and Spring Boot hints (server.port, context-path).
 */
const U = require('./util');

const SPRING_VERB = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const SKIP_PARAM_TYPES = /^(HttpServletRequest|HttpServletResponse|ServletRequest|ServletResponse|HttpSession|Principal|Authentication|Model|ModelMap|BindingResult|Errors|Locale|ServerWebExchange|ServerHttpRequest|ServerHttpResponse|WebRequest|NativeWebRequest|UriComponentsBuilder|UriInfo|HttpHeaders|SecurityContext|Request|Response|AsyncResponse|RedirectAttributes|SessionStatus|ApplicationCall|Continuation|CoroutineContext|Jwt|OAuth2User)\b/;

function analyze(text, file, out) {
  const isKotlin = /\.kts?$/.test(file);
  const src = U.stripComments(text, 'c', true);
  const lineOf = U.makeLineIndex(src);
  collectModels(src, out, isKotlin);
  if (/@(RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/.test(src)) spring(src, file, out, lineOf);
  if (/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.test(src) && /@Path\b/.test(src)) jaxrs(src, file, out, lineOf);
  if (/io\.micronaut/.test(src)) micronaut(src, file, out, lineOf);
  if (/io\.ktor/.test(src)) ktor(src, file, out, lineOf);
  // functions (for handler lookup)
  const fre = isKotlin ? /\bfun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\(/g : /\b(?:public|private|protected|static|\s)[\w<>[\],\s?]*\s(\w+)\s*\([^;{]*\)\s*(?:throws[^{]+)?(?=\{)/g;
  for (const r of U.functionRanges(src, fre, true)) if (!out.functions[r.name]) out.functions[r.name] = r.body;
}

// ------------------------------------------------------------------ annotations helpers
/** Parse a run of annotations that starts at idx.  Returns [{name, args, start, end}] and the index after them. */
function readAnnotations(src, idx) {
  const list = [];
  let i = idx;
  const re = /\s*@([\w.]+)\s*/y;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) break;
    let end = m.index + m[0].length;
    let args = '';
    if (src[end] === '(') {
      const b = U.readBalanced(src, end, true);
      if (!b) break;
      args = b.inner;
      end = b.end + 1;
    }
    list.push({ name: m[1].split('.').pop(), args, start: m.index, end });
    i = end;
  }
  return { list, end: i };
}

/** Find the start of the annotation cluster that contains idx (walk back over annotations). */
function clusterAround(src, idx) {
  // walk back to the previous ; { } that is not inside an annotation argument (good enough heuristic)
  // (Kotlin has no ';' after imports, so we also stop at a previous line that is not part of an annotation)
  let i = idx - 1;
  let depth = 0;
  while (i > 0) {
    const ch = src[i];
    if (ch === ')') depth++;
    else if (ch === '(') depth--;
    else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) break;
    else if (depth === 0 && ch === '\n') {
      const ls = src.lastIndexOf('\n', i - 1) + 1;
      const line = src.slice(ls, i).trim();
      const opens = (line.match(/\(/g) || []).length;
      const closes = (line.match(/\)/g) || []).length;
      if (line && !line.startsWith('@') && closes <= opens && !/^(public|private|protected|internal|open|abstract|final|data|static|suspend|override)\b/.test(line)) break;
    }
    i--;
  }
  const start = i + 1;
  const ann = readAnnotations(src, start);
  // skip modifiers to the declaration
  const rest = src.slice(ann.end, ann.end + 600);
  return { start, annotations: ann.list, declStart: ann.end, rest };
}

function annPaths(args) {
  if (!args || !args.trim()) return [''];
  const named = /(?:^|[\s,(])(?:value|path|uri|uris)\s*=\s*/.exec(args);
  let target = args;
  if (named) target = args.slice(named.index + named[0].length);
  else if (/^\s*\w+\s*=/.test(args)) return ['']; // only other named attributes
  target = target.trim();
  if (target.startsWith('{') || target.startsWith('[')) {
    const b = U.readBalanced(target, 0);
    const strs = U.allStrings(b ? b.inner : target);
    return strs.length ? strs : [''];
  }
  const s = U.firstString(target);
  return [s === null ? '' : s];
}

function isClassDecl(rest) {
  return /^\s*(?:(?:public|private|protected|abstract|final|open|internal|data|sealed|static)\s+)*(?:class|interface|object)\s+(\w+)/.exec(rest);
}

// ------------------------------------------------------------------ Spring
function spring(src, file, out, lineOf) {
  // class-level prefixes
  const classes = [];
  const clsRe = /\b(?:class|interface|object)\s+(\w+)/g;
  let m;
  while ((m = clsRe.exec(src))) {
    const c = clusterAround(src, m.index);
    const rm = c.annotations.find((a) => a.name === 'RequestMapping');
    const brace = src.indexOf('{', m.index);
    const b = brace !== -1 ? U.readBalanced(src, brace, true) : null;
    classes.push({ name: m[1], start: m.index, end: b ? b.end : src.length, prefixes: rm ? annPaths(rm.args) : [''], isController: c.annotations.some((a) => /Controller$/.test(a.name)) });
  }
  const re = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/g;
  while ((m = re.exec(src))) {
    const c = clusterAround(src, m.index);
    if (isClassDecl(c.rest)) continue; // class-level mapping
    const ann = c.annotations.find((a) => a.start <= m.index + 1 && a.end > m.index) || c.annotations.find((a) => a.name === m[1]);
    if (!ann) continue;
    let methods;
    if (ann.name === 'RequestMapping') {
      methods = U.methodsFrom(U.namedArray(ann.args, 'method') || '');
      if (!methods.length) methods = ['GET'];
    } else methods = [SPRING_VERB[ann.name]];
    const sig = methodSignature(src, c.declStart);
    const cls = classes.filter((k) => k.start < m.index && m.index < k.end).pop();
    const params = sig ? jvmParams(sig.inner, 'spring') : [];
    const consumes = U.namedArray(ann.args, 'consumes') || '';
    for (const prefix of cls ? cls.prefixes : ['']) {
      for (const sub of annPaths(ann.args)) {
        for (const meth of methods) {
          out.routes.push({
            method: meth,
            path: U.joinPaths(prefix, sub),
            line: lineOf(m.index),
            framework: /reactor|webflux/i.test(src) ? 'Spring WebFlux' : 'Spring',
            prefixKind: 'spring',
            keys: ['file:' + file],
            params,
            handler: sig ? (cls ? cls.name + '.' : '') + sig.name : undefined,
            bodyMode: /MULTIPART|multipart/.test(consumes) ? 'formdata' : /FORM_URLENCODED|x-www-form-urlencoded/.test(consumes) ? 'urlencoded' : undefined,
          });
        }
      }
    }
  }
  // Spring functional routes: route().GET("/x", handler)  /  RouterFunctions.route(GET("/x"), ...)
  const fr = /\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]*)"/g;
  while ((m = fr.exec(src))) {
    if (!/RouterFunction|coRouter|router\s*\{/.test(src)) break;
    out.routes.push({ method: m[1], path: m[2], line: lineOf(m.index), framework: 'Spring Functional', prefixKind: 'spring', keys: ['file:' + file], params: [] });
  }
}

/** From the declaration start (after annotations), find the method's parameter list. */
function methodSignature(src, from) {
  const re = /\s*(?:(?:public|private|protected|static|final|synchronized|abstract|default|open|override|suspend|internal|operator|inline)\s+)*(?:fun\s+(?:<[^>]*>\s*)?)?(?:<[^>]*>\s*)?(?:[\w.$]+(?:\s*<[^;{]*?>)?(?:\[\])*\s+)?(\w+)\s*\(/y;
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const b = U.readBalanced(src, open, true);
  if (!b) return null;
  return { name: m[1], inner: b.inner, end: b.end };
}

function jvmParams(sig, flavor) {
  const res = [];
  for (const raw of U.splitTopLevel(sig)) {
    const ann = readAnnotations(raw, 0);
    let rest = raw.slice(ann.end).trim().replace(/^(final|val|var)\s+/, '');
    let name;
    let type;
    const kt = /^(\w+)\s*:\s*(.+?)(?:\s*=\s*.+)?$/.exec(rest);
    if (kt) { name = kt[1]; type = kt[2].trim(); }
    else {
      const jm = /^(.+?)\s+(\w+)$/.exec(rest);
      if (!jm) continue;
      type = jm[1].trim();
      name = jm[2];
    }
    const optional = /^Optional</.test(type) || /\?$/.test(type);
    const names = ann.list.map((a) => a.name);
    const keyOf = (a) => U.namedArg(a.args, ['value', 'name']) || U.firstString(a.args) || name;
    const requiredOf = (a) => !optional && !/required\s*=\s*false/.test(a.args) && !/defaultValue\s*=/.test(a.args);
    const find = (...n) => ann.list.find((a) => n.includes(a.name));
    let a;
    if ((a = find('PathVariable', 'PathParam', 'RestPath'))) res.push({ name: keyOf(a), in: 'path', type, required: true });
    else if ((a = find('RequestParam', 'QueryParam', 'QueryValue', 'RestQuery'))) {
      if (/MultipartFile|FilePart|FileUpload|CompletedFileUpload/.test(type)) res.push({ name: keyOf(a), in: 'file', type: 'file', required: requiredOf(a) });
      else if (/^Map\b|MultiValueMap/.test(type)) continue;
      else res.push({ name: keyOf(a), in: 'query', type, required: requiredOf(a) });
    } else if ((a = find('RequestHeader', 'HeaderParam', 'Header', 'RestHeader'))) res.push({ name: keyOf(a), in: 'header', type, required: requiredOf(a) });
    else if ((a = find('CookieValue', 'CookieParam', 'CookieValue'))) res.push({ name: keyOf(a), in: 'cookie', type, required: requiredOf(a) });
    else if ((a = find('RequestPart', 'FormParam', 'RestForm', 'Part'))) res.push({ name: keyOf(a), in: /MultipartFile|FilePart|FileUpload|InputStream|File\b/.test(type) ? 'file' : 'form', type, required: requiredOf(a) });
    else if ((a = find('RequestBody', 'Body'))) res.push({ name, in: 'body', type, model: type, required: !/required\s*=\s*false/.test(a.args) });
    else if ((a = find('ModelAttribute', 'BeanParam', 'ParameterObject', 'RequestBean'))) res.push({ name, in: 'query', type, model: type });
    else if (names.some((n) => /^(AuthenticationPrincipal|Context|Suspended|Valid|Validated|NotNull|CurrentUser|Inject)$/.test(n)) && !names.some((n) => /Valid|Validated|NotNull/.test(n))) continue;
    else if (SKIP_PARAM_TYPES.test(type.replace(/^[\w.]+\./, ''))) continue;
    else if (/^Pageable\b/.test(type)) {
      res.push({ name: 'page', in: 'query', type: 'int', required: false }, { name: 'size', in: 'query', type: 'int', required: false }, { name: 'sort', in: 'query', type: 'string', required: false });
    } else if (/^Sort\b/.test(type)) res.push({ name: 'sort', in: 'query', type: 'string', required: false });
    else if (U.isSimpleType(type)) res.push({ name, in: flavor === 'jaxrs' ? 'body' : 'query', type, required: !optional && flavor !== 'jaxrs' });
    else if (flavor === 'jaxrs' || flavor === 'micronaut') res.push({ name, in: 'body', type, model: type });
    else res.push({ name, in: 'query', type, model: type }); // spring: unannotated complex type = @ModelAttribute
  }
  return res;
}

// ------------------------------------------------------------------ JAX-RS
function jaxrs(src, file, out, lineOf) {
  const classes = [];
  const clsRe = /\b(?:class|interface)\s+(\w+)/g;
  let m;
  while ((m = clsRe.exec(src))) {
    const c = clusterAround(src, m.index);
    const p = c.annotations.find((a) => a.name === 'Path');
    const brace = src.indexOf('{', m.index);
    const b = brace !== -1 ? U.readBalanced(src, brace, true) : null;
    classes.push({ name: m[1], start: m.index, end: b ? b.end : src.length, prefix: p ? annPaths(p.args)[0] : '' });
  }
  const re = /@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b(?!\s*\()/g;
  while ((m = re.exec(src))) {
    const c = clusterAround(src, m.index);
    if (isClassDecl(c.rest)) continue;
    const p = c.annotations.find((a) => a.name === 'Path');
    const consumes = c.annotations.find((a) => a.name === 'Consumes');
    const sig = methodSignature(src, c.declStart);
    const cls = classes.filter((k) => k.start < m.index && m.index < k.end).pop();
    out.routes.push({
      method: m[1],
      path: U.joinPaths(cls ? cls.prefix : '', p ? annPaths(p.args)[0] : ''),
      line: lineOf(m.index),
      framework: /quarkus/.test(src) ? 'Quarkus' : 'JAX-RS',
      prefixKind: 'jaxrs',
      keys: ['file:' + file],
      params: sig ? jvmParams(sig.inner, 'jaxrs') : [],
      handler: sig ? sig.name : undefined,
      bodyMode: consumes && /MULTIPART|multipart/.test(consumes.args) ? 'formdata' : consumes && /FORM_URLENCODED|urlencoded/.test(consumes.args) ? 'urlencoded' : undefined,
    });
  }
}

// ------------------------------------------------------------------ Micronaut
function micronaut(src, file, out, lineOf) {
  const ctrl = /@Controller\s*\(\s*"([^"]*)"/.exec(src);
  const prefix = ctrl ? ctrl[1] : '';
  const re = /@(Get|Post|Put|Delete|Patch)\b/g;
  let m;
  while ((m = re.exec(src))) {
    const c = clusterAround(src, m.index);
    const ann = c.annotations.find((a) => a.name === m[1]);
    const sig = methodSignature(src, c.declStart);
    out.routes.push({ method: m[1].toUpperCase(), path: U.joinPaths(prefix, ann ? annPaths(ann.args)[0] : ''), line: lineOf(m.index), framework: 'Micronaut', keys: ['file:' + file], params: sig ? jvmParams(sig.inner, 'micronaut') : [] });
  }
}

// ------------------------------------------------------------------ Ktor
function ktor(src, file, out, lineOf) {
  const scopes = [];
  let m;
  const rre = /\broute\s*\(\s*"([^"]*)"\s*\)\s*\{/g;
  while ((m = rre.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace, true);
    if (b) scopes.push({ start: brace, end: b.end, prefix: m[1] });
  }
  const re = /\b(get|post|put|delete|patch|head|options)\s*(?:<[^>]*>)?\s*\(\s*"([^"]*)"\s*\)\s*\{/g;
  while ((m = re.exec(src))) {
    const brace = m.index + m[0].length - 1;
    const b = U.readBalanced(src, brace, true);
    out.routes.push({ method: m[1].toUpperCase(), path: U.joinPaths(U.scopePrefix(scopes, m.index), m[2]), line: lineOf(m.index), framework: 'Ktor', keys: ['file:' + file], block: b ? b.inner : '' });
  }
}

// ------------------------------------------------------------------ models
function collectModels(src, out, isKotlin) {
  let m;
  // Java records: record UserDto(String name, int age) {}
  const rec = /\brecord\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = rec.exec(src))) {
    const b = U.readBalanced(src, m.index + m[0].length - 1, true);
    if (!b) continue;
    out.models[m[1]] = { lang: 'java', fields: U.splitTopLevel(b.inner).map(javaField).filter(Boolean) };
  }
  // Kotlin data classes: data class UserDto(val name: String, val age: Int? = null)
  const dc = /\b(?:data\s+)?class\s+(\w+)\s*(?:<[^>]*>)?\s*(?:@\w+\s*)*(?:constructor\s*)?\(/g;
  if (isKotlin) {
    while ((m = dc.exec(src))) {
      const b = U.readBalanced(src, m.index + m[0].length - 1, true);
      if (!b) continue;
      const fields = [];
      for (const part of U.splitTopLevel(b.inner)) {
        const f = /(?:val|var)\s+(\w+)\s*:\s*([^=]+?)(\s*=.*)?$/.exec(part.replace(/@[\w.:]+(\([^)]*\))?\s*/g, ''));
        if (f) fields.push({ name: f[1], type: f[2].trim(), required: !/\?$/.test(f[2].trim()) && !f[3] });
      }
      if (fields.length) out.models[m[1]] = { lang: 'kotlin', fields };
    }
  }
  // Java classes with fields
  const cls = /\bclass\s+(\w+)([^{;]*)\{/g;
  while ((m = cls.exec(src))) {
    if (out.models[m[1]]) continue;
    const ext = /extends\s+([\w.]+)/.exec(m[2]);
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const b = U.readBalanced(src, brace, true);
    if (!b) continue;
    // only top-level statements of the class body
    const body = topLevel(b.inner);
    const fields = [];
    const fre = /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:(?:private|protected|public)\s+)?(?:final\s+)?((?:[\w.]+)(?:\s*<[^;=]*?>)?(?:\[\])?)\s+(\w+)\s*(?:=[^;]*)?;/g;
    let f;
    while ((f = fre.exec(body))) {
      if (/\bstatic\b/.test(body.slice(Math.max(0, f.index - 20), f.index + f[0].length)) || /^(return|throw|new|import|package)$/.test(f[2])) continue;
      fields.push({ name: (/@JsonProperty\(\s*"([^"]+)"/.exec(f[1]) || [])[1] || f[3], type: f[2], required: /@(NotNull|NotBlank|NotEmpty)\b/.test(f[1]) });
    }
    if (fields.length || ext) out.models[m[1]] = { lang: 'java', fields, bases: ext ? [ext[1].split('.').pop()] : [] };
  }
  const en = /\benum\s+(?:class\s+)?(\w+)\s*(?:\([^)]*\))?\s*(?::[^{]+)?\{([^};]*)/g;
  while ((m = en.exec(src))) {
    const vals = m[2].split(',').map((s) => s.trim().split(/[\s(]/)[0]).filter((s) => /^\w+$/.test(s));
    if (vals.length) out.models[m[1]] = { lang: 'java', fields: [], enumValues: vals };
  }
}

function topLevel(body) {
  let depth = 0;
  let res = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (depth === 0) res += ch;
    else res += ch === '\n' ? '\n' : ' ';
    if (ch === '}') { depth--; if (depth === 0) res += ';'; }
  }
  return res;
}

function javaField(part) {
  const clean = part.replace(/@[\w.]+(\([^)]*\))?\s*/g, '').trim();
  const m = /^(.+?)\s+(\w+)$/.exec(clean);
  return m ? { name: m[2], type: m[1].trim(), required: /@(NotNull|NotBlank|NotEmpty)/.test(part) } : null;
}

// ------------------------------------------------------------------ params from blocks (Ktor)
function extractParams(block) {
  const res = [];
  if (!block) return res;
  const add = (name, where, type) => { if (!res.find((p) => p.name === name && p.in === where)) res.push({ name, in: where, type: type || 'string', required: where === 'path' }); };
  let m;
  const rules = [
    [/call\.parameters\[\s*"([^"]+)"\s*\]|call\.parameters\.get(?:OrFail)?\(\s*"([^"]+)"/g, 'path'],
    [/call\.(?:request\.)?queryParameters\[\s*"([^"]+)"\s*\]|queryParameters\.get\(\s*"([^"]+)"/g, 'query'],
    [/call\.request\.headers\[\s*"([^"]+)"\s*\]|call\.request\.header\(\s*"([^"]+)"/g, 'header'],
  ];
  for (const [re, where] of rules) while ((m = re.exec(block))) add(m[1] || m[2], where);
  const rc = /call\.receive(?:OrNull|Nullable)?\s*<\s*([\w.]+)\s*>/.exec(block) || /:\s*([\w.]+)\s*=\s*call\.receive\(/.exec(block);
  if (rc) res.push({ name: 'body', in: 'body', model: rc[1], type: rc[1] });
  else if (/call\.receiveParameters\(/.test(block)) res.push({ name: '__body__', in: 'form', type: 'object', wholeBody: true });
  return res;
}

module.exports = { analyze, extractParams };

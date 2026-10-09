'use strict';
/**
 * Shared, language-agnostic helpers used by every detector.
 * Everything here is pure (no VS Code dependency) so it can be unit tested with plain Node.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Build a fast index -> 0-based line lookup for a text. */
function makeLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return function lineOf(idx) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/**
 * Replace comments with spaces (newlines kept) so offsets/lines stay identical
 * but commented-out routes are never detected.
 * style: 'c'    -> // and /* *\/   (js, ts, java, kotlin, c#, go, rust)
 *        'hash' -> #                (python, ruby, yaml)
 *        'php'  -> //, /* *\/ and # (but not #[ attributes)
 * strictChar: treat ' as a quote only for short char literals ('a', '\n') — for languages with lifetimes/chars.
 */
function stripComments(text, style, strictChar) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const cStyle = style === 'c' || style === 'php';
  const hashStyle = style === 'hash' || style === 'php';
  while (i < n) {
    const ch = text[i];
    const nx = text[i + 1];
    // strings
    if (ch === '"' || ch === '`' || (ch === "'" && (!strictChar || isShortCharLiteral(text, i)))) {
      // python / generic triple quotes
      if ((ch === '"' || ch === "'") && text[i + 1] === ch && text[i + 2] === ch) {
        const end = text.indexOf(ch + ch + ch, i + 3);
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const c = text[j];
        if (c === '\\') { j += 2; continue; }
        if (c === ch) break;
        if (c === '\n' && ch !== '`') break; // unterminated single-line string: bail out
        j++;
      }
      i = j + 1;
      continue;
    }
    if (cStyle && ch === '/' && nx === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (cStyle && ch === '/' && nx === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (hashStyle && ch === '#' && !(style === 'php' && nx === '[')) {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    i++;
  }
  return out.join('');
}

function isShortCharLiteral(text, i) {
  // 'a'  or '\n' or '\u{1F600}' (rust)
  if (text[i + 2] === "'") return true;
  if (text[i + 1] === '\\') {
    const close = text.indexOf("'", i + 2);
    return close !== -1 && close - i <= 12 && text.slice(i, close).indexOf('\n') === -1;
  }
  return false;
}

/**
 * Starting at an opening bracket, return the inner text and the index of the matching close.
 * Strings are skipped. Returns null when unbalanced.
 */
function readBalanced(text, openIdx, strictChar) {
  const open = text[openIdx];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  if (!pairs[open]) return null;
  const stack = [pairs[open]];
  let i = openIdx + 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === '`' || (ch === "'" && (!strictChar || isShortCharLiteral(text, i)))) {
      let j = i + 1;
      while (j < n && text[j] !== ch) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n' && ch !== '`') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack[stack.length - 1] === ch) stack.pop();
      if (stack.length === 0) return { inner: text.slice(openIdx + 1, i), end: i };
    }
    i++;
  }
  return null;
}

/** Split by a separator at the top level (ignores separators inside brackets, generics and strings). */
function splitTopLevel(str, sep = ',') {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += str[++i] || ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '>' && str[i - 1] !== '=' && str[i - 1] !== '-') depth--;
    if (ch === sep && depth <= 0) { parts.push(cur); cur = ''; depth = 0; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Read the first string literal in a snippet, e.g.  ("/users", ...)  ->  /users */
function firstString(s) {
  const m = /^\s*[rfbuRFBU@$]{0,2}(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(s);
  return m ? m[2] : null;
}

/** All string literals of a snippet. */
function allStrings(s) {
  const res = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(s))) res.push(m[2]);
  return res;
}

/** Read a named argument such as  prefix="/api"  /  url_prefix='/x'  /  path: '/x'  /  value = "/x" */
function namedArg(s, names) {
  for (const name of [].concat(names)) {
    const re = new RegExp('(?:^|[\\s,({])' + name + '\\s*(?:=|:|=>)\\s*[rfbu]?(["\'`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1');
    const m = re.exec(s);
    if (m) return m[2];
  }
  return null;
}

/** Read a named array argument such as methods=['GET','POST'] / methods: ["GET"] / method = {RequestMethod.GET} */
function namedArray(s, names) {
  for (const name of [].concat(names)) {
    const re = new RegExp('(?:^|[\\s,({])' + name + '\\s*(?:=|:|=>)\\s*');
    const m = re.exec(s);
    if (!m) continue;
    const start = m.index + m[0].length;
    const ch = s[start];
    if (ch === '[' || ch === '{' || ch === '(') {
      const b = readBalanced(s, start);
      if (b) return b.inner;
    }
    // single value
    const single = /^[^,)\]}]+/.exec(s.slice(start));
    return single ? single[0] : null;
  }
  return null;
}

function methodsFrom(snippet) {
  if (!snippet) return [];
  const found = [];
  const re = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi;
  let m;
  while ((m = re.exec(snippet))) {
    const up = m[1].toUpperCase();
    if (!found.includes(up)) found.push(up);
  }
  return found;
}

/** Join route segments: joinPaths('/api/', 'users', ':id') -> /api/users/:id  (keeps a trailing slash of the last part). */
function joinPaths(...parts) {
  const clean = parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').map(String);
  if (!clean.length) return '/';
  const last = clean[clean.length - 1];
  let joined = clean.join('/').replace(/\/{2,}/g, '/');
  if (!joined.startsWith('/')) joined = '/' + joined;
  if (joined.length > 1 && joined.endsWith('/') && !(last.endsWith('/') && last.length > 1)) joined = joined.slice(0, -1);
  return joined;
}

/** Normalise framework-specific path templates to the Postman style  /users/:id */
function normalizePath(p) {
  if (p === null || p === undefined) return '/';
  let s = String(p).trim();
  s = s.replace(/^\^/, '').replace(/\$$/, ''); // django re_path anchors
  s = s.replace(/\(\?P<(\w+)>[^)]*\)/g, ':$1'); // django regex groups
  s = s.replace(/\{\*{0,2}(\w+)(?::(?:[^{}]|\{[^}]*\})*)?\??\}/g, ':$1'); // {id} {id:int} {*slug} {id?} {id:[0-9]{3}}
  s = s.replace(/<(?:\w+:)?(\w+)(?:\.\.)?>/g, ':$1'); // <int:id> <name> <path..>
  s = s.replace(/(:\w+)\}+/g, '$1'); // tolerate typos like {name}}
  s = s.replace(/\(\.:format\)/g, '');
  s = s.replace(/:(\w+)\?/g, ':$1');
  s = s.replace(/\/\*(\w+)/g, '/:$1'); // gin  /*filepath
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/{2,}/g, '/');
}

function pathParamsOf(p) {
  const res = [];
  const re = /:(\w+)/g;
  let m;
  while ((m = re.exec(p))) if (!res.includes(m[1])) res.push(m[1]);
  return res;
}

/** Given a list of {start,end,prefix} scopes, return the combined prefix for an index. */
function scopePrefix(scopes, idx) {
  return scopes
    .filter((s) => s.start < idx && idx < s.end)
    .sort((a, b) => a.start - b.start)
    .map((s) => s.prefix)
    .reduce((acc, p) => joinPaths(acc, p), '');
}

/** Find the function (by name) whose body encloses an index. */
function enclosingName(ranges, idx) {
  let best = null;
  for (const r of ranges) if (r.start < idx && idx < r.end && (!best || r.start > best.start)) best = r;
  return best ? best.name : null;
}

/** Build ranges of named functions: regex must have the name in group 1; the body is the next {...} */
function functionRanges(text, re, strictChar) {
  const ranges = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const brace = text.indexOf('{', m.index + m[0].length - 1);
    if (brace === -1) continue;
    // make sure we do not jump over a ';' (declaration without body)
    const semi = text.indexOf(';', m.index + m[0].length);
    if (semi !== -1 && semi < brace) continue;
    const b = readBalanced(text, brace, strictChar);
    if (!b) continue;
    ranges.push({ name: m[1], start: brace, end: b.end, body: text.slice(m.index, b.end + 1) });
  }
  return ranges;
}

const SIMPLE_TYPES = /^(string|str|char|int|integer|long|short|byte|float|double|decimal|number|bool|boolean|uuid|guid|date|datetime|localdate|localdatetime|instant|offsetdatetime|bigdecimal|biginteger|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|i8|i16|i32|i64|u8|u16|u32|u64|usize|isize|f32|f64|float32|float64|any|object|time\.time|timespan|dateonly|timeonly|sbyte|ushort|ulong|character|emailstr|httpurl|anyurl|secretstr|path|decimal128)$/i;

/** Remove wrappers like Optional<>, Nullable, ?, Option<> and return the core type name. */
function coreType(t) {
  if (!t) return '';
  let s = String(t).trim().replace(/^final\s+/, '').replace(/\s+/g, ' ');
  s = s.replace(/^(?:Optional|Option|Nullable|Mono|Flux|Promise|Task|ResponseEntity|web::Json|web::Query|web::Path|web::Form|Json|Query|Path|Form|Annotated|Body|Valid)\s*[<[](.*)[>\]]$/, '$1');
  s = s.replace(/^['"]|['"]$/g, '');
  s = s.replace(/\?$/, '').replace(/^\*/, '').replace(/^&/, '').replace(/\s*\|\s*(None|null|undefined)$/i, '');
  return s.trim();
}

function isSimpleType(t) {
  const c = coreType(t).replace(/^(java\.lang\.|System\.)/, '');
  if (!c) return true;
  if (/^(List|Set|Array|Collection|Iterable|IEnumerable|IList|ICollection|list|set|Vec|tuple|Tuple|Sequence)\s*[<[]/.test(c) || /\[\]$/.test(c) || /^\[\]/.test(c)) {
    const inner = c.replace(/^[\w.]+\s*[<[]/, '').replace(/[>\]]$/, '').replace(/\[\]$/, '').replace(/^\[\]/, '');
    return isSimpleType(inner);
  }
  if (/^(Literal|Enum)/.test(c)) return true;
  return SIMPLE_TYPES.test(c.toLowerCase());
}

/** A sample JSON value for a declared type, resolving known models recursively. */
function sampleFor(type, models, lang, depth = 0, seen = new Set()) {
  let t = coreType(type || '');
  if (!t) return 'string';
  // arrays
  let arr = /^(?:List|Set|Array|Collection|Iterable|IEnumerable|IList|ICollection|IReadOnlyList|list|set|Vec|Sequence|HashSet|ArrayList|MutableList)\s*[<[](.*)[>\]]$/.exec(t);
  if (arr) return [sampleFor(arr[1], models, lang, depth + 1, seen)];
  arr = /^(.*)\[\]$/.exec(t) || /^\[\](.*)$/.exec(t);
  if (arr) return [sampleFor(arr[1], models, lang, depth + 1, seen)];
  if (/^(Map|Dictionary|IDictionary|dict|Dict|HashMap|Record|map\[)/.test(t)) return {};
  const lower = t.toLowerCase().replace(/^(java\.lang\.|system\.)/, '');
  if (/^(uuid|guid)$/.test(lower)) return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  if (/^(string|str|char|character|text)$/.test(lower)) return 'string';
  if (/email/.test(lower)) return 'user@example.com';
  if (/^(int|integer|long|short|byte|sbyte|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|ushort|ulong|i8|i16|i32|i64|u8|u16|u32|u64|usize|isize|biginteger|positiveint|conint)$/.test(lower)) return 0;
  if (/^(float|double|decimal|number|f32|f64|float32|float64|bigdecimal|confloat)$/.test(lower)) return 0.0;
  if (/^(bool|boolean)$/.test(lower)) return false;
  if (/^(date|localdate|dateonly)$/.test(lower)) return '2024-01-01';
  if (/(datetime|instant|timestamp|time\.time|offsetdatetime|zoneddatetime)$/.test(lower)) return '2024-01-01T00:00:00Z';
  if (/^(any|object|json|jsonnode|jsonobject|dynamic|interface\{\})$/.test(lower)) return {};
  const name = t.replace(/^.*[.:]/, '').replace(/<.*$/, '');
  const model = models && models[name];
  if (model && depth < 4 && !seen.has(name)) {
    if (model.enumValues && model.enumValues.length) return model.enumValues[0];
    const next = new Set(seen);
    next.add(name);
    const obj = {};
    for (const f of model.fields) obj[f.name] = sampleFor(f.type, models, lang, depth + 1, next);
    return obj;
  }
  if (model && model.enumValues && model.enumValues.length) return model.enumValues[0];
  return depth === 0 ? {} : 'string';
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = {
  HTTP_METHODS,
  BODY_METHODS,
  makeLineIndex,
  stripComments,
  readBalanced,
  splitTopLevel,
  firstString,
  allStrings,
  namedArg,
  namedArray,
  methodsFrom,
  joinPaths,
  normalizePath,
  pathParamsOf,
  scopePrefix,
  enclosingName,
  functionRanges,
  coreType,
  isSimpleType,
  sampleFor,
  uniqBy,
};

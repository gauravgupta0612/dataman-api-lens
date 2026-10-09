'use strict';
/**
 * HTTP client used by the request panels (runs in the extension host, so there are no CORS limits).
 * Supports variables, path variables, query params, auth helpers, JSON/text/XML/urlencoded/multipart bodies,
 * redirects, gzip/deflate/brotli, a tiny per-host cookie jar, timeouts and cancellation.
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const MAX_BODY = 25 * 1024 * 1024;
const cookieJar = new Map(); // host -> Map(name -> value)

// ------------------------------------------------------------------ variables
function dynamicVar(name) {
  switch (name) {
    case '$guid':
    case '$uuid':
    case '$randomUUID':
      return crypto.randomUUID();
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(Math.random() * 1000));
    case '$randomEmail':
      return 'user' + Math.floor(Math.random() * 100000) + '@example.com';
    default:
      return undefined;
  }
}

function resolveVars(input, vars) {
  if (input === undefined || input === null) return '';
  let s = String(input);
  for (let pass = 0; pass < 5 && /\{\{\s*[$\w.-]+\s*\}\}/.test(s); pass++) {
    s = s.replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (m, name) => {
      if (Object.prototype.hasOwnProperty.call(vars || {}, name)) return String(vars[name]);
      const d = dynamicVar(name);
      return d === undefined ? m : d;
    });
  }
  return s;
}

function unresolvedVars(input, vars) {
  const res = [];
  const s = String(input || '');
  const re = /\{\{\s*([$\w.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(s))) if (!(m[1] in (vars || {})) && dynamicVar(m[1]) === undefined && !res.includes(m[1])) res.push(m[1]);
  return res;
}

// ------------------------------------------------------------------ request building
function enabledRows(rows) {
  return (rows || []).filter((r) => r && r.enabled !== false && String(r.key || '').trim() !== '');
}

/** Replace "inherit" auth with the environment's default authentication. */
function effectiveRequest(req, envAuth) {
  if (!req || !req.auth || req.auth.type === 'inherit' || !req.auth.type) {
    return { ...req, auth: envAuth && envAuth.type && envAuth.type !== 'inherit' ? envAuth : { type: 'none' } };
  }
  return req;
}

function buildUrl(req0, vars, envAuth) {
  const req = effectiveRequest(req0, envAuth);
  let url = resolveVars(req.url, vars).trim();
  for (const pv of req.pathVars || []) {
    if (!pv.key) continue;
    const val = resolveVars(pv.value, vars);
    if (val === '') continue;
    const esc = pv.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    url = url.replace(new RegExp('(/):' + esc + '(?=$|[/?#.;])', 'g'), '$1' + encodeURIComponent(val));
  }
  const query = enabledRows(req.params).map((p) => [resolveVars(p.key, vars), resolveVars(p.value, vars)]);
  const auth = req.auth || {};
  if (auth.type === 'apikey' && auth.addTo === 'query' && auth.key) query.push([resolveVars(auth.key, vars), resolveVars(auth.value, vars)]);
  if (query.length) {
    const qs = query.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    url += (url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?') + qs;
  }
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

function buildHeaders(req, vars) {
  const headers = [];
  for (const h of enabledRows(req.headers)) headers.push([resolveVars(h.key, vars), resolveVars(h.value, vars)]);
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  const auth = req.auth || {};
  if (auth.type === 'bearer' && auth.token && !has('authorization')) headers.push(['Authorization', (auth.prefix || 'Bearer') + ' ' + resolveVars(auth.token, vars)]);
  if (auth.type === 'basic' && !has('authorization')) headers.push(['Authorization', 'Basic ' + Buffer.from(resolveVars(auth.username, vars) + ':' + resolveVars(auth.password, vars)).toString('base64')]);
  if (auth.type === 'apikey' && auth.addTo !== 'query' && auth.key) headers.push([resolveVars(auth.key, vars), resolveVars(auth.value, vars)]);
  return headers;
}

/** Returns { buffer, contentType } for the body, or null. */
function buildBody(req, vars) {
  const body = req.body || { mode: 'none' };
  switch (body.mode) {
    case 'json':
      return { buffer: Buffer.from(resolveVars(body.raw, vars), 'utf8'), contentType: 'application/json' };
    case 'xml':
      return { buffer: Buffer.from(resolveVars(body.raw, vars), 'utf8'), contentType: 'application/xml' };
    case 'text':
      return { buffer: Buffer.from(resolveVars(body.raw, vars), 'utf8'), contentType: 'text/plain' };
    case 'urlencoded': {
      const qs = enabledRows(body.urlencoded).map((r) => encodeURIComponent(resolveVars(r.key, vars)) + '=' + encodeURIComponent(resolveVars(r.value, vars))).join('&');
      return { buffer: Buffer.from(qs, 'utf8'), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'formdata': {
      const boundary = '----RoutinelBoundary' + crypto.randomBytes(12).toString('hex');
      const parts = [];
      for (const r of enabledRows(body.formdata)) {
        const key = resolveVars(r.key, vars).replace(/"/g, '%22');
        if (r.type === 'file') {
          const fp = resolveVars(r.value, vars);
          if (!fp) continue;
          const data = fs.readFileSync(fp);
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${path.basename(fp).replace(/"/g, '%22')}"\r\nContent-Type: ${guessMime(fp)}\r\n\r\n`));
          parts.push(data);
          parts.push(Buffer.from('\r\n'));
        } else {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${resolveVars(r.value, vars)}\r\n`));
        }
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      return { buffer: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
    }
    default:
      return null;
  }
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.zip': 'application/zip', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}

/** Fully resolved request (used by the executor, code generators and history). */
function prepare(req0, vars, envAuth) {
  const req = effectiveRequest(req0, envAuth);
  const url = buildUrl(req, vars);
  const headers = buildHeaders(req, vars);
  const body = ['GET', 'HEAD'].includes(String(req.method).toUpperCase()) && (!req.body || req.body.mode === 'none') ? null : buildBody(req, vars);
  if (body && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', body.contentType]);
  return { method: String(req.method || 'GET').toUpperCase(), url, headers, body };
}

// ------------------------------------------------------------------ execution
function isTextual(contentType, buf) {
  if (!contentType) {
    const sample = buf.subarray(0, 512);
    return !sample.includes(0);
  }
  return /json|text|xml|html|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|svg/i.test(contentType);
}

function decompress(buf, encoding) {
  try {
    switch ((encoding || '').toLowerCase().trim()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(buf);
      case 'deflate':
        try { return zlib.inflateSync(buf); } catch (e) { return zlib.inflateRawSync(buf); }
      case 'br':
        return zlib.brotliDecompressSync(buf);
      default:
        return buf;
    }
  } catch (e) {
    return buf;
  }
}

/**
 * Execute a prepared request.
 * options: { timeoutMs, rejectUnauthorized, followRedirects, maxRedirects, useCookieJar, signal }
 */
function execute(prepared, options = {}) {
  const started = Date.now();
  const { timeoutMs = 30000, rejectUnauthorized = true, followRedirects = true, maxRedirects = 10, useCookieJar = true, signal } = options;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const doRequest = (method, urlStr, headers, body) => {
      let url;
      try {
        url = new URL(urlStr);
      } catch (e) {
        reject(new Error('Invalid URL: ' + urlStr));
        return;
      }
      const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
      if (!lib) {
        reject(new Error('Unsupported protocol ' + url.protocol));
        return;
      }
      const hdrs = {};
      for (const [k, v] of headers) {
        if (hdrs[k] !== undefined) hdrs[k] = [].concat(hdrs[k], v);
        else hdrs[k] = v;
      }
      const lower = Object.keys(hdrs).map((k) => k.toLowerCase());
      if (!lower.includes('user-agent')) hdrs['User-Agent'] = 'Routinel/1.0';
      if (!lower.includes('accept')) hdrs.Accept = '*/*';
      if (!lower.includes('accept-encoding')) hdrs['Accept-Encoding'] = 'gzip, deflate, br';
      if (useCookieJar && !lower.includes('cookie')) {
        const jar = cookieJar.get(url.host);
        if (jar && jar.size) hdrs.Cookie = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
      }
      if (body) hdrs['Content-Length'] = body.length;
      const reqOpts = { method, headers: hdrs, rejectUnauthorized, signal };
      const r = lib.request(url, reqOpts, (res) => {
        if (useCookieJar && res.headers['set-cookie']) {
          const jar = cookieJar.get(url.host) || new Map();
          for (const c of res.headers['set-cookie']) {
            const m = /^\s*([^=;]+)=([^;]*)/.exec(c);
            if (m) {
              if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(m[1]);
              else jar.set(m[1], m[2]);
            }
          }
          cookieJar.set(url.host, jar);
        }
        if (followRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < maxRedirects) {
          redirects++;
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          const keepBody = res.statusCode === 307 || res.statusCode === 308;
          const nextHeaders = keepBody ? headers : headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
          doRequest(keepBody ? method : method === 'HEAD' ? 'HEAD' : 'GET', next, nextHeaders, keepBody ? body : null);
          return;
        }
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
          else truncated = true;
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const buf = decompress(raw, res.headers['content-encoding']);
          const contentType = res.headers['content-type'] || '';
          const textual = isTextual(contentType, buf);
          const rawHeaders = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) rawHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            httpVersion: res.httpVersion,
            headers: rawHeaders,
            contentType,
            isBinary: !textual,
            body: textual ? buf.toString('utf8') : buf.toString('base64'),
            size: size,
            decodedSize: buf.length,
            truncated,
            timeMs: Date.now() - started,
            url: url.toString(),
            redirects,
            cookies: [...(cookieJar.get(url.host) || new Map()).entries()].map(([name, value]) => ({ name, value })),
          });
        });
        res.on('error', reject);
      });
      r.setTimeout(timeoutMs, () => r.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
      r.on('error', (e) => {
        if (e && e.name === 'AbortError') reject(new Error('Request cancelled'));
        else reject(friendlyError(e, url));
      });
      if (body) r.write(body);
      r.end();
    };
    doRequest(prepared.method, prepared.url, prepared.headers, prepared.body ? prepared.body.buffer : null);
  });
}

function friendlyError(e, url) {
  const code = e && e.code;
  const hints = {
    ECONNREFUSED: `Connection refused — is the server running on ${url.host}?`,
    ENOTFOUND: `Host not found: ${url.hostname}`,
    ETIMEDOUT: 'Connection timed out',
    ECONNRESET: 'Connection reset by the server',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate — disable "routinel.http.rejectUnauthorized" to allow it',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain — disable "routinel.http.rejectUnauthorized" to allow it',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify the certificate — disable "routinel.http.rejectUnauthorized" to allow it',
    CERT_HAS_EXPIRED: 'The server certificate has expired',
  };
  const err = new Error(hints[code] ? `${hints[code]} (${code})` : (e && e.message) || String(e));
  err.code = code;
  return err;
}

function clearCookies() {
  cookieJar.clear();
}

module.exports = { effectiveRequest, resolveVars, unresolvedVars, buildUrl, buildHeaders, buildBody, prepare, execute, clearCookies, enabledRows };

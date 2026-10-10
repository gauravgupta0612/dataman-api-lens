'use strict';
/* Plain-Node test runner: node test/run-tests.js */
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { scan } = require('../src/scanner');
const client = require('../src/http');
const model = require('../src/model');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e));
  }
}

function walk(d, acc = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, acc);
    else acc.push({ file: p, text: fs.readFileSync(p, 'utf8') });
  }
  return acc;
}

(async () => {
  console.log('Scanner');
  const res = scan(walk(path.join(__dirname, 'fixtures')));
  const find = (method, p, fw) => res.endpoints.find((e) => e.method === method && e.path === p && (!fw || e.framework === fw));
  const has = (ep, where, name) => ep && ep.params.some((x) => x.in === where && x.name === name);
  const expectations = [
    ['GET', '/api/users', 'Express', (e) => has(e, 'query', 'page') && has(e, 'header', 'authorization')],
    ['POST', '/api/users', 'Express', (e) => e.body.mode === 'json' && 'email' in e.body.example],
    ['PUT', '/api/users/:id/avatar', 'Express', (e) => e.body.mode === 'formdata'],
    ['GET', '/api/users/:id', 'NestJS', (e) => has(e, 'path', 'id') && has(e, 'query', 'expand')],
    ['POST', '/api/users', 'NestJS', (e) => Array.isArray(e.body.example.roles) && has(e, 'header', 'x-tenant')],
    ['GET', '/api/users/:id', 'Next.js', (e) => has(e, 'query', 'include')],
    ['GET', '/users/:user_id', 'FastAPI', (e) => has(e, 'header', 'x-token') && has(e, 'query', 'q') && !has(e, 'query', 'db')],
    ['POST', '/users', 'FastAPI', (e) => e.body.example.name === 'string'],
    ['GET', '/api/items', 'FastAPI', (e) => has(e, 'query', 'skip')],
    ['POST', '/v1/auth/login', 'Flask', (e) => 'username' in e.body.example && 'password' in e.body.example],
    ['GET', '/search', 'Flask', (e) => has(e, 'query', 'q')],
    ['GET', '/blog/articles/:year/', 'Django', (e) => has(e, 'path', 'year') && has(e, 'query', 'sort')],
    ['POST', '/api/posts/', 'Django REST', (e) => 'title' in e.body.example],
    ['POST', '/api/posts/:pk/publish/', 'Django REST', null],
    ['GET', '/svc/api/v1/users/:id', 'Spring', (e) => has(e, 'query', 'fields')],
    ['POST', '/svc/api/v1/users', 'Spring', (e) => 'roles' in e.body.example && has(e, 'header', 'X-Request-Id')],
    ['GET', '/svc/api/v1/users/search', 'Spring', (e) => has(e, 'query', 'page') && has(e, 'query', 'q')],
    ['GET', '/api/orders/:id', 'Ktor', (e) => has(e, 'query', 'expand')],
    ['POST', '/api/orders', 'Ktor', (e) => 'qty' in e.body.example],
    ['GET', '/api/Products/:id', 'ASP.NET Core', (e) => has(e, 'query', 'includeStock') && !has(e, 'query', 'ct')],
    ['POST', '/api/Products', 'ASP.NET Core', (e) => 'price' in e.body.example && has(e, 'header', 'X-Api-Key')],
    ['POST', '/todos', 'ASP.NET Minimal API', (e) => 'title' in e.body.example],
    ['GET', '/v1/orders/:id', 'Gin', (e) => has(e, 'query', 'verbose')],
    ['POST', '/v1/orders', 'Gin', (e) => 'item' in e.body.example],
    ['GET', '/items/:id', 'net/http', (e) => has(e, 'query', 'fmt')],
    ['POST', '/api/v1/posts', 'Laravel', (e) => 'title' in e.body.example && has(e, 'query', 'draft')],
    ['DELETE', '/api/v1/photos/:photo', 'Laravel', null],
    ['GET', '/api/articles/:article_id/comments', 'Rails', null],
    ['POST', '/api/articles/:id/publish', 'Rails', null],
    ['POST', '/api/articles', 'Rails', (e) => e.body.example.article && 'title' in e.body.example.article],
    ['GET', '/users', 'Axum', (e) => has(e, 'query', 'per_page')],
    ['POST', '/users', 'Axum', (e) => 'email' in e.body.example],
    ['GET', '/admin/stats', 'Axum', null],
    ['GET', '/pets/:petId', 'OpenAPI 3.0.0', (e) => has(e, 'query', 'verbose')],
    ['POST', '/pets', 'OpenAPI 3.0.0', (e) => e.body.example.name === 'Rex'],
    ['GET', '/stores/:storeid/orders/:orderid', 'Restlet', (e) => has(e, 'query', 'currency') && has(e, 'query', 'expand')],
    ['POST', '/stores/:storeid/orders/:orderid', 'Restlet', (e) => e.body.example.product === 'string' && e.body.example.quantity === 0 && !('ok' in e.body.example)],
    ['POST', '/stores/:storeid/orders', 'Restlet', (e) => e.body.mode === 'json'],
    ['GET', '/legacy/items/:id', 'Restlet', (e) => has(e, 'query', 'q')],
    ['DELETE', '/legacy/items/:id', 'Restlet', null],
    ['POST', '/ai/summary', 'Restlet', (e) => e.body.example.prompt === 'string'],
  ];
  for (const [m, p, fw, check] of expectations) {
    await test(`${fw}: ${m} ${p}`, () => {
      const e = find(m, p, fw);
      assert.ok(e, 'endpoint not found');
      if (check) assert.ok(check(e), 'params/body check failed: ' + JSON.stringify({ params: e.params, body: e.body }));
    });
  }
  await test('ignores commented-out routes and HTTP client calls', () => {
    assert.ok(!res.endpoints.some((e) => /commented|not-a-route/.test(e.path)));
  });
  await test('detects ports for the default environment', () => {
    assert.ok(res.hints.baseUrls.includes('http://localhost:8081'));
    assert.ok(res.hints.baseUrls.includes('http://localhost:4000'));
  });

  console.log('Model');
  await test('endpoint -> request keeps path vars, query, headers, body', () => {
    const ep = find('POST', '/svc/api/v1/users', 'Spring');
    const req = model.endpointToRequest(ep);
    assert.strictEqual(req.url, '{{baseUrl}}/svc/api/v1/users');
    assert.ok(req.headers.find((h) => h.key === 'X-Request-Id'));
    assert.strictEqual(req.body.mode, 'json');
    JSON.parse(req.body.raw);
  });
  await test('Postman export/import round-trip', () => {
    const ep = find('GET', '/v1/orders/:id', 'Gin');
    const col = { id: 'x', name: 'Test', items: [{ id: 'a', type: 'folder', name: 'f', items: [{ id: 'b', type: 'request', name: 'get order', request: model.endpointToRequest(ep) }] }] };
    const pm = model.collectionToPostman(col, { baseUrl: 'http://localhost:9090' });
    const back = model.postmanToCollection(JSON.stringify(pm));
    const req = back.collection.items[0].items[0].request;
    assert.strictEqual(req.method, 'GET');
    assert.strictEqual(req.url, '{{baseUrl}}/v1/orders/:id');
    assert.strictEqual(back.variables.baseUrl, 'http://localhost:9090');
  });
  await test('OpenAPI export', () => {
    const doc = model.endpointsToOpenApi(res.endpoints.filter((e) => !e.fromSpec), 'x', 'http://localhost');
    assert.ok(doc.paths['/v1/orders/{id}'].get.parameters.find((p) => p.name === 'id' && p.in === 'path'));
  });

  console.log('Mock server & docs');
  {
    const { MockServer } = require('../src/mock');
    const docs = require('../src/docs');
    const saved = { 'GET /v1/orders/:id': { status: 200, body: { id: '{{params.id}}', verbose: '{{query.verbose}}', note: 'saved' } } };
    const mock = new MockServer({ getEndpoints: () => res.endpoints, getMocks: () => saved });
    const port = await mock.start(0);
    const base = 'http://127.0.0.1:' + port;
    const call = async (method, p, body) => {
      const req = model.emptyRequest();
      Object.assign(req, { method, url: base + p, body: body ? { mode: 'json', raw: JSON.stringify(body) } : { mode: 'none' } });
      const r = await client.execute(client.prepare(req, {}), {});
      return { status: r.status, body: r.body ? JSON.parse(r.body) : null, source: (r.headers.find(([k]) => /x-routinel-mock/i.test(k)) || [])[1] };
    };
    await test('mock: OpenAPI documented response', async () => {
      const r = await call('GET', '/pets/7');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.name, 'Rex');
      assert.strictEqual(r.source, 'spec');
    });
    await test('mock: generated POST echoes body with id (201)', async () => {
      const r = await call('POST', '/svc/api/v1/users', { name: 'Ann' });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.name, 'Ann');
      assert.strictEqual(r.body.id, 1);
    });
    await test('mock: generated GET item uses model shape + path id', async () => {
      const r = await call('GET', '/api/Products/42');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.id, 42);
    });
    await test('mock: saved mock with templates', async () => {
      const r = await call('GET', '/v1/orders/99?verbose=yes');
      assert.deepStrictEqual(r.body, { id: 99, verbose: 'yes', note: 'saved' });
      assert.strictEqual(r.source, 'saved');
    });
    await test('mock: DELETE 204, unknown 404, wrong method 405', async () => {
      assert.strictEqual((await call('DELETE', '/api/v1/photos/3')).status, 204);
      assert.strictEqual((await call('GET', '/nope/here')).status, 404);
      assert.strictEqual((await call('PATCH', '/health')).status, 405);
    });
    await mock.stop();
    await test('docs: HTML and Markdown contain every endpoint', () => {
      const sources = [{ name: 'Fixtures', endpoints: res.endpoints, root: path.join(__dirname, 'fixtures') }];
      const html = docs.renderHtml(sources, { title: 'Fixtures API', baseUrl: 'http://localhost:8080' });
      const md = docs.renderMarkdown(sources, { title: 'Fixtures API' });
      for (const e of res.endpoints) {
        assert.ok(html.includes(e.path.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')) || html.includes(e.path.replace(/:(\w+)/g, '<em>:$1</em>')), 'html missing ' + e.path);
        assert.ok(md.includes('`' + e.path + '`'), 'md missing ' + e.path);
      }
      assert.ok(html.includes('curl -X POST'));
    });
  }

  console.log('HTTP client');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/echo?from=redirect' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc; Path=/' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const vars = { baseUrl: base, token: 'T0K3N', id: '42' };
  await test('variables, path vars, query, auth and JSON body', async () => {
    const req = model.emptyRequest();
    Object.assign(req, {
      method: 'POST',
      url: '{{baseUrl}}/users/:id',
      pathVars: [{ key: 'id', value: '{{id}}' }],
      params: [{ key: 'q', value: 'a b', enabled: true }, { key: 'off', value: '1', enabled: false }],
      auth: { type: 'bearer', token: '{{token}}' },
      body: { mode: 'json', raw: '{"n": "{{$guid}}"}' },
    });
    const r = await client.execute(client.prepare(req, vars), {});
    const echo = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(echo.url, '/users/42?q=a%20b');
    assert.strictEqual(echo.headers.authorization, 'Bearer T0K3N');
    assert.strictEqual(echo.headers['content-type'], 'application/json');
    assert.match(JSON.parse(echo.body).n, /^[0-9a-f-]{36}$/);
  });
  await test('redirects + cookie jar', async () => {
    const req = model.emptyRequest();
    req.url = '{{baseUrl}}/redirect';
    const r = await client.execute(client.prepare(req, vars), {});
    assert.strictEqual(JSON.parse(r.body).url, '/echo?from=redirect');
    assert.strictEqual(r.redirects, 1);
    const r2 = await client.execute(client.prepare(req, vars), {});
    assert.strictEqual(JSON.parse(r2.body).headers.cookie, 'sid=abc');
  });
  await test('urlencoded + multipart bodies', async () => {
    const tmp = path.join(__dirname, 'fixtures', 'openapi', 'petstore.yaml');
    const req = model.emptyRequest();
    Object.assign(req, { method: 'POST', url: '{{baseUrl}}/f', body: { mode: 'formdata', formdata: [{ key: 'a', value: '1', enabled: true }, { key: 'file', value: tmp, type: 'file', enabled: true }] } });
    let echo = JSON.parse((await client.execute(client.prepare(req, vars), {})).body);
    assert.match(echo.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.ok(echo.body.includes('filename="petstore.yaml"'));
    req.body = { mode: 'urlencoded', urlencoded: [{ key: 'x', value: 'y z', enabled: true }] };
    echo = JSON.parse((await client.execute(client.prepare(req, vars), {})).body);
    assert.strictEqual(echo.body, 'x=y%20z');
  });
  await test('friendly connection error', async () => {
    const req = model.emptyRequest();
    req.url = 'http://127.0.0.1:1/x';
    await assert.rejects(client.execute(client.prepare(req, vars), { timeoutMs: 3000 }), /refused|ECONNREFUSED/);
  });
  await test('code generation (curl / powershell / python / fetch)', () => {
    const req = model.endpointToRequest(find('POST', '/svc/api/v1/users', 'Spring'));
    const prep = client.prepare(req, vars);
    for (const lang of ['curl', 'powershell', 'python', 'fetch', 'http']) assert.ok(model.generate(lang, prep, req, vars, client.resolveVars).includes('/svc/api/v1/users'), lang);
  });
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

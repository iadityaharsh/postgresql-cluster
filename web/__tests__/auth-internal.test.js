const path = require('path');
const fs = require('fs');
const os = require('os');

describe('internal auth helpers', () => {
  let tmpDir, confPath, originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
    confPath = path.join(tmpDir, 'cluster.conf');
    originalCwd = process.cwd();
    // auth.js reads cluster.conf relative to its own location; we stub it via env
    process.env.PG_CLUSTER_CONF = confPath;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.PG_CLUSTER_CONF;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.chdir(originalCwd);
  });

  test('getInternalSecret returns null when cluster.conf missing', () => {
    const { getInternalSecret } = require('../src/middleware/auth');
    expect(getInternalSecret()).toBeNull();
  });

  test('getInternalSecret reads INTERNAL_SECRET from cluster.conf', () => {
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    const { getInternalSecret } = require('../src/middleware/auth');
    expect(getInternalSecret()).toBe('deadbeef1234');
  });

  test('isInternalRequest rejects when no secret configured', () => {
    const { isInternalRequest } = require('../src/middleware/auth');
    const req = { headers: { 'x-internal-token': 'anything' } };
    expect(isInternalRequest(req)).toBe(false);
  });

  test('isInternalRequest rejects when header missing', () => {
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    const { isInternalRequest } = require('../src/middleware/auth');
    expect(isInternalRequest({ headers: {} })).toBe(false);
  });

  test('isInternalRequest rejects wrong token', () => {
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    const { isInternalRequest } = require('../src/middleware/auth');
    const req = { headers: { 'x-internal-token': 'wrongwrong12' } };
    expect(isInternalRequest(req)).toBe(false);
  });

  test('isInternalRequest accepts matching token (timing-safe, equal length)', () => {
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    const { isInternalRequest } = require('../src/middleware/auth');
    const req = { headers: { 'x-internal-token': 'deadbeef1234' } };
    expect(isInternalRequest(req)).toBe(true);
  });

  test('isInternalRequest rejects mismatched-length token without throwing', () => {
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    const { isInternalRequest } = require('../src/middleware/auth');
    const req = { headers: { 'x-internal-token': 'short' } };
    expect(isInternalRequest(req)).toBe(false);
  });
});

describe('authMiddleware public/internal split', () => {
  let tmpDir, confPath, app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mw-test-'));
    confPath = path.join(tmpDir, 'cluster.conf');
    fs.writeFileSync(confPath, 'INTERNAL_SECRET="deadbeef1234"\n');
    process.env.PG_CLUSTER_CONF = confPath;
    jest.resetModules();

    const express = require('express');
    const { authMiddleware, setAuthConfig } = require('../src/middleware/auth');
    // Simulate auth being configured so the middleware actually guards
    setAuthConfig({ username: 'test', hash: 'x', salt: 'y' });
    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.get('/api/version', (req, res) => res.json({ ok: 'public' }));
    app.post('/api/restart/local', (req, res) => res.json({ ok: 'internal' }));
    app.post('/api/version/upgrade/apply', (req, res) => res.json({ ok: 'internal' }));
  });

  afterEach(() => {
    delete process.env.PG_CLUSTER_CONF;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = require('supertest');

  test('public path /api/version always allowed', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
  });

  test('internal path rejected without header or session', async () => {
    const res = await request(app).post('/api/restart/local');
    expect(res.status).toBe(401);
  });

  test('internal path allowed with valid X-Internal-Token', async () => {
    const res = await request(app)
      .post('/api/restart/local')
      .set('X-Internal-Token', 'deadbeef1234');
    expect(res.status).toBe(200);
  });

  test('internal path rejected with wrong X-Internal-Token', async () => {
    const res = await request(app)
      .post('/api/restart/local')
      .set('X-Internal-Token', 'wrongwrong12');
    expect(res.status).toBe(401);
  });

  test('upgrade/apply also requires header', async () => {
    const noHeader = await request(app).post('/api/version/upgrade/apply');
    expect(noHeader.status).toBe(401);
    const withHeader = await request(app)
      .post('/api/version/upgrade/apply')
      .set('X-Internal-Token', 'deadbeef1234');
    expect(withHeader.status).toBe(200);
  });
});

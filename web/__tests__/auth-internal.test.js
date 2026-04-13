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

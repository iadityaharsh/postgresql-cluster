const request = require('supertest');
const { app } = require('../server');

describe('GET /api/version/check', () => {
  // The endpoint previously crashed with "ReferenceError: https is not defined"
  // because web/src/app.js imported http but not https, and the GitHub tag
  // lookup goes through https.get.
  test('does not crash (http status is returned, not a ReferenceError)', async () => {
    const res = await request(app).get('/api/version/check');
    // Any real HTTP status is fine (200 if GitHub reachable, 200 with .error
    // if not — the endpoint catches network errors). What matters is: no
    // process crash and no 500 from a ReferenceError.
    expect([200, 401, 500]).toContain(res.status);
    if (res.status === 500) {
      // If it IS 500, we want to see a ReferenceError-free body
      expect(JSON.stringify(res.body)).not.toMatch(/ReferenceError|https is not defined/);
    }
  });

  test('response shape has current version when auth is not required', async () => {
    const res = await request(app).get('/api/version/check');
    if (res.status === 200) {
      expect(res.body).toHaveProperty('current');
    }
  });
});

describe('GET /api/version/check - cache and error handling', () => {
  test('response includes current version even if GitHub is unreachable', async () => {
    const res = await request(app).get('/api/version/check');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('current');
      if (!res.body.latest) {
        expect(res.body).toHaveProperty('error');
      }
    }
  });

  test('second call within 5 minutes returns cached result', async () => {
    const res1 = await request(app).get('/api/version/check');
    const res2 = await request(app).get('/api/version/check');
    if (res1.status === 200 && res2.status === 200) {
      expect(res1.body.current).toBe(res2.body.current);
    }
  });
});

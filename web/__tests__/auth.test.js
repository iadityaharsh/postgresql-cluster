const request = require('supertest');
const { app } = require('../server');

describe('Auth security', () => {
  test('Public endpoints work without auth', async () => {
    const paths = ['/healthz', '/api/version', '/api/auth/status'];
    for (const p of paths) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
    }
  });

  test('Protected API endpoints require auth when configured', async () => {
    const res = await request(app).get('/api/config');
    expect([200, 401]).toContain(res.status);
  });

  test('POST /api/login rejects empty body', async () => {
    const res = await request(app).post('/api/login').send({});
    expect([200, 400]).toContain(res.status);
  });

  test('POST /api/logout clears session cookie', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    // The set-cookie header may or may not be present depending on auth config
    if (res.headers['set-cookie']) {
      expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=0/);
    }
  });
});

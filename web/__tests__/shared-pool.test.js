const request = require('supertest');
const { app } = require('../server');

describe('shared PG pool', () => {
  test('GET /api/databases returns array or empty on pg-unavailable', async () => {
    const res = await request(app).get('/api/databases');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  test('GET /api/replication returns array or empty', async () => {
    const res = await request(app).get('/api/replication');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  test('GET /api/connections returns object or empty', async () => {
    const res = await request(app).get('/api/connections');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('by_state');
    }
  });
});

const request = require('supertest');
const { app } = require('../server');

describe('POST /api/version/upgrade', () => {
  test('endpoint exists and does not 404 or 500', async () => {
    const res = await request(app).post('/api/version/upgrade');
    // Without auth: 401. With auth but no cluster: 409 or 200.
    // Should never 404 or 500.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });

  test('GET /api/version/upgrade/status returns current task state', async () => {
    const res = await request(app).get('/api/version/upgrade/status');
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('running');
    }
  });
});

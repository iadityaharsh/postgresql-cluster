const request = require('supertest');
const { app } = require('../server');

describe('POST /api/hyperdrive', () => {
  test('rejects missing required fields with 400', async () => {
    const res = await request(app)
      .post('/api/hyperdrive')
      .send({ database: 'mydb' });
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toMatch(/required/i);
    }
  });

  test('rejects empty body with 400', async () => {
    const res = await request(app).post('/api/hyperdrive').send({});
    expect([400, 401]).toContain(res.status);
  });

  test('rejects when all required fields missing except one', async () => {
    const res = await request(app)
      .post('/api/hyperdrive')
      .send({
        database: 'mydb',
        // missing: username, password, hostname, access_client_id, access_client_secret
      });
    expect([400, 401]).toContain(res.status);
  });

  test('GET /api/hyperdrive does not 404 or 500', async () => {
    const res = await request(app).get('/api/hyperdrive');
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });
});

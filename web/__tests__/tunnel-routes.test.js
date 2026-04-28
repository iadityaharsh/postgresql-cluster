const request = require('supertest');
const { app } = require('../server');

describe('Tunnel routes CRUD', () => {
  test('GET /api/tunnel/routes does not 404 or 500', async () => {
    const res = await request(app).get('/api/tunnel/routes');
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });

  test('POST /api/tunnel/routes rejects missing hostname', async () => {
    const res = await request(app)
      .post('/api/tunnel/routes')
      .send({ service: 'http://localhost:3000' });
    // 400 = validation, 401 = no auth, 409 = tunnel not configured — all acceptable
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  });

  test('POST /api/tunnel/routes rejects missing service', async () => {
    const res = await request(app)
      .post('/api/tunnel/routes')
      .send({ hostname: 'app.example.com' });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  });

  test('DELETE /api/tunnel/routes/:hostname does not 404', async () => {
    const res = await request(app).delete('/api/tunnel/routes/nonexistent.example.com');
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });
});

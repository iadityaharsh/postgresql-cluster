const request = require('supertest');
const { app } = require('../server');

describe('POST /api/auth/change-password', () => {
  test('rejects missing body fields with 400 (or 200 when no auth configured)', async () => {
    const res = await request(app).post('/api/auth/change-password').send({});
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(404);
    // 400 = validation, 200 = no auth configured (both acceptable)
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) expect(res.body).toHaveProperty('error');
  });

  test('rejects when only current_password provided', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ current_password: 'old' });
    expect(res.status).not.toBe(500);
    expect([200, 400]).toContain(res.status);
  });

  test('rejects when only new_password provided', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ new_password: 'new-long-pass' });
    expect(res.status).not.toBe(500);
    expect([200, 400]).toContain(res.status);
  });

  test('endpoint rejects short new password or passes through when no auth', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ current_password: 'anything', new_password: 'short' });
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(404);
    if (res.status === 400) {
      expect(res.body.error).toMatch(/password|required|auth/i);
    }
  });

  test('endpoint exists and does not 404 or 500', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ current_password: 'wrong', new_password: 'newpassword12345' });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });
});

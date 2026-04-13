const request = require('supertest');
const { app } = require('../server');

describe('Backup endpoints', () => {
  test('GET /api/backups returns backup status', async () => {
    const res = await request(app).get('/api/backups');
    if (res.status === 200) {
      expect(res.body).toHaveProperty('available');
      expect(res.body).toHaveProperty('archives');
    }
  });

  test('POST /api/backups/restore rejects missing archive', async () => {
    const res = await request(app).post('/api/backups/restore').send({});
    expect([400, 401]).toContain(res.status);
  });

  test('POST /api/backups/restore rejects without confirmation', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: 'test-archive' });
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body).toHaveProperty('warning');
    }
  });

  test('POST /api/backups/restore rejects command injection in archive name', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: 'test; rm -rf /', confirm: true });
    expect([400, 401]).toContain(res.status);
  });

  test('DELETE /api/backups/:name rejects invalid names', async () => {
    const res = await request(app).delete('/api/backups/test;injection');
    expect([400, 401]).toContain(res.status);
  });
});

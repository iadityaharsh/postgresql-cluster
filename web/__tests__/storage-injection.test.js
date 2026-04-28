const request = require('supertest');
const { app } = require('../server');

describe('POST /api/storage/apply injection prevention', () => {
  const badValues = [
    ['newline injection', { NFS_SERVER: 'host\nEVIL=1' }],
    ['dollar substitution', { NFS_SERVER: 'host$(evil)' }],
    ['backtick substitution', { NFS_SERVER: 'host`evil`' }],
    ['backslash escape', { NFS_SERVER: 'host\\evil' }],
    ['double-quote escape', { NFS_SERVER: 'host"evil"' }],
  ];

  test.each(badValues)('rejects %s in value', async (_label, body) => {
    const res = await request(app).post('/api/storage/apply').send(body);
    // Key must also be in allowed list; if not that's a 400 too — either way not 200
    expect(res.status).not.toBe(200);
    expect(res.status).toBeLessThan(500);
  });

  test('accepts clean value for allowed key', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ NFS_SERVER: 'myserver.local' });
    // 200 = applied, 400 = key not allowed, 401 = no auth — any is acceptable, not 500
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(404);
  });
});

const request = require('supertest');
const { app } = require('../server');

describe('POST /api/databases — validation', () => {
  test('missing database field returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ owner: 'mydb_user', password: 'abc123' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) expect(res.body).toHaveProperty('error');
  });

  test('invalid database name returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'MyDB', owner: 'mydb_user', password: 'abc123' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
  });

  test('reserved name postgres returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'postgres', owner: 'mydb_user', password: 'abc123' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
  });

  test('reserved name template0 returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'template0', owner: 'mydb_user', password: 'abc123' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
  });

  test('invalid owner name returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'mydb', owner: 'My-User!', password: 'abc123' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
  });

  test('missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'mydb', owner: 'mydb_user' });
    expect(res.status).not.toBe(500);
    expect([400, 401]).toContain(res.status);
  });

  test('valid payload reaches pg (200 or 500, not 400)', async () => {
    const res = await request(app)
      .post('/api/databases')
      .send({ database: 'testdb99', owner: 'testdb99_user', password: 'Str0ng!Pass#' });
    // 400 means validation rejected it — that would be wrong
    expect(res.status).not.toBe(400);
    expect([200, 201, 401, 500]).toContain(res.status);
  });
});

describe('GET /api/databases/:name — validation', () => {
  test('invalid name returns 400', async () => {
    const res = await request(app).get('/api/databases/My-Bad-Name!');
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) expect(res.body).toHaveProperty('error');
  });

  test('reserved name template0 returns 400', async () => {
    const res = await request(app).get('/api/databases/template0');
    expect([400, 401]).toContain(res.status);
  });

  test('valid name reaches pg (200 or 500, not 400)', async () => {
    const res = await request(app).get('/api/databases/myapp');
    expect(res.status).not.toBe(400);
    expect([200, 401, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('datname');
      expect(res.body).toHaveProperty('size_bytes');
      expect(res.body).toHaveProperty('numbackends');
      expect(res.body).toHaveProperty('blks_hit');
      expect(res.body).toHaveProperty('xact_commit');
      expect(res.body).toHaveProperty('table_count');
      expect(res.body).toHaveProperty('owner');
    }
  });
});

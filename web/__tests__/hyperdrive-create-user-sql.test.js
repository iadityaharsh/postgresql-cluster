const request = require('supertest');
const { app } = require('../server');

describe('POST /api/hyperdrive/create-user input validation', () => {
  test('rejects username with SQL metacharacters', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: "alice'; DROP TABLE users; --", password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]nvalid username/);
  });

  test('rejects database with SQL metacharacters', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb"; DROP TABLE foo; --', username: 'alice', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]nvalid database/);
  });

  test('rejects username with semicolon', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: 'alice;bob', password: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects empty body', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({});
    expect(res.status).toBe(400);
  });

  test('well-formed input passes validation (may then 500 on pool.connect in test env)', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: 'alice', password: "anything with ' quote" });
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/[Ii]nvalid/);
    }
  });
});

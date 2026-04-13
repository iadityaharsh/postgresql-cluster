const fs = require('fs');
const os = require('os');
const path = require('path');

describe('updateConfKeys key validation', () => {
  const request = require('supertest');
  const { app } = require('../server');

  test('rejects key with regex metacharacters', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'FOO.*': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects key with pipe (regex alternation)', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'A|B': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects lowercase key', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'foo': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects key starting with digit', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ '1FOO': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('accepts well-formed uppercase key', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ TEST_KEY_FROM_JEST: 'ok' });
    if (res.status === 500) {
      expect(res.body.error).not.toMatch(/[Ii]nvalid config key/);
    }
  });
});

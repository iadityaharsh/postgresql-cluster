const request = require('supertest');
const { app } = require('../server');

describe('POST /api/backups/restore archive validation', () => {
  test('rejects missing archive with 400', async () => {
    const res = await request(app).post('/api/backups/restore').send({});
    expect(res.status).toBe(400);
  });

  test('rejects archive containing shell metacharacters', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: 'foo; rm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]nvalid archive/);
  });

  test('rejects archive with path traversal', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: '../../etc/passwd' });
    expect(res.status).toBe(400);
  });

  test('rejects archive with backtick', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: '`id`' });
    expect(res.status).toBe(400);
  });

  test('rejects archive with $(...)', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: '$(whoami)' });
    expect(res.status).toBe(400);
  });

  test('accepts a well-formed archive name (passes validation, may then fail on borg)', async () => {
    const res = await request(app).post('/api/backups/restore').send({ archive: 'pg-2026-04-11_02-00-00' });
    // Validation passes -> handler proceeds, then may fail on borg spawn or conflict with a running restore.
    // The contract we're testing: status is NOT 400 with "Invalid archive".
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/[Ii]nvalid archive/);
    }
  });
});

describe('POST /api/backups/restore confirmation', () => {
  test('returns warning when confirm is not set', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Cc]onfirm/);
    expect(res.body).toHaveProperty('warning');
  });

  test('returns warning when confirm is false', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name', confirm: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Cc]onfirm/);
  });

  test('proceeds when confirm is true (may fail on borg in test env)', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name', confirm: true });
    // Confirmation passes → handler proceeds → will fail on borg/psql in test env.
    // What we test: the response is NOT a 400 with "confirm" in the error message.
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/[Cc]onfirm/);
    }
  });
});

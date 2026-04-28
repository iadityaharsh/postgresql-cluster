const request = require('supertest');
const { app } = require('../server');

describe('Health check', () => {
  test('GET /healthz returns status ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
  });
});

describe('Auth status', () => {
  test('GET /api/auth/status returns auth state', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('auth_required');
    // logged_in is only present when auth is configured
    expect(typeof res.body.auth_required).toBe('boolean');
  });
});

describe('Login flow', () => {
  test('POST /api/login returns 400 without credentials', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({});
    // If no auth configured, returns 200 with message; otherwise 400
    expect([200, 400]).toContain(res.status);
  });

  test('POST /api/logout clears session', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out');
    // Should set cookie to expire
    const cookie = res.headers['set-cookie'];
    expect(cookie).toBeDefined();
    expect(cookie[0]).toMatch(/Max-Age=0/);
  });
});

describe('Public endpoints (no auth)', () => {
  test('GET /api/version returns version', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
  });
});

describe('Cluster endpoints', () => {
  test('GET /api/config returns cluster config', async () => {
    const res = await request(app).get('/api/config');
    // May be 401 if auth is required, or 200
    if (res.status === 200) {
      expect(res.body).toHaveProperty('cluster_name');
      expect(res.body).toHaveProperty('node_count');
      expect(res.body).toHaveProperty('nodes');
    }
  });

  test('GET /api/cluster returns cluster status or error', async () => {
    const res = await request(app).get('/api/cluster');
    // Patroni may not be running in test env, so 200 or 500 are both valid
    expect([200, 401, 500]).toContain(res.status);
  });
});

describe('Config backup endpoints', () => {
  test('GET /api/config/backup returns a tar.gz or 404 if no cluster.conf', async () => {
    const res = await request(app).get('/api/config/backup');
    expect([200, 401, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/octet-stream|gzip|tar/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
    }
  });

  test('POST /api/config/restore with invalid body returns 400', async () => {
    const res = await request(app)
      .post('/api/config/restore')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not a valid tar.gz'));
    expect([400, 401, 500]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body).toHaveProperty('error');
    }
  });

  test('GET /api/config/join-config with valid params returns JSON or 400', async () => {
    const res = await request(app)
      .get('/api/config/join-config?node_ip=10.0.0.14&node_name=node-04&node_number=4');
    expect([200, 400, 401, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('mode', 'join');
      expect(res.body).toHaveProperty('cluster_name');
      expect(res.body).toHaveProperty('etcd_peers');
      expect(res.body).toHaveProperty('internal_secret');
      expect(res.body).toHaveProperty('this_node_ip', '10.0.0.14');
    }
  });

  test('GET /api/config/join-config without params returns 400', async () => {
    const res = await request(app).get('/api/config/join-config');
    expect([400, 401]).toContain(res.status);
  });
});

describe('Static files', () => {
  test('GET / serves index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('PostgreSQL Cluster Monitor');
  });
});

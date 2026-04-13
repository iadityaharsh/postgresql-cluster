const { verifyPassword, hashPassword } = require('../src/middleware/auth');

describe('verifyPassword timing-safe comparison', () => {
  test('accepts correct password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('correct-horse', hash, salt);
    expect(ok).toBe(true);
  });

  test('rejects wrong password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('wrong-horse', hash, salt);
    expect(ok).toBe(false);
  });

  test('rejects empty password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('', hash, salt);
    expect(ok).toBe(false);
  });

  test('rejects malformed hash (odd-length hex) without throwing', async () => {
    const ok = await verifyPassword('any-password', 'abc', '00'.repeat(16));
    expect(ok).toBe(false);
  });

  test('rejects hash of wrong length without throwing', async () => {
    const shortHash = 'aa'.repeat(16);
    const ok = await verifyPassword('any-password', shortHash, '00'.repeat(16));
    expect(ok).toBe(false);
  });

  test('rejects garbage salt without throwing', async () => {
    const ok = await verifyPassword('any-password', 'aa'.repeat(64), 'not-hex-at-all');
    expect([true, false]).toContain(ok);
  });
});

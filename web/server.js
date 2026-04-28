const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./src/logger');

// Install logger early — captures all console output + uncaught errors to daily log files
if (require.main === module) {
  logger.install();
}

const { createApp } = require('./src/app');
const { app, PORT, conf } = createApp();

// Export for testing
module.exports = { app };

// Start server (skip when imported for testing)
if (require.main === module) {
  const SSL_CERT_PATHS = [
    { cert: '/etc/patroni/ssl/server.crt', key: '/etc/patroni/ssl/server.key' },
    { cert: path.resolve(__dirname, 'ssl', 'server.crt'), key: path.resolve(__dirname, 'ssl', 'server.key') }
  ];

  let sslOpts = null;
  for (const { cert, key } of SSL_CERT_PATHS) {
    if (fs.existsSync(cert) && fs.existsSync(key)) {
      try {
        sslOpts = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
        break;
      } catch { /* skip if unreadable */ }
    }
  }

  // Generate a self-signed cert if none found — always serve HTTPS
  if (!sslOpts) {
    const sslDir = path.resolve(__dirname, 'ssl');
    const certPath = path.join(sslDir, 'server.crt');
    const keyPath = path.join(sslDir, 'server.key');
    try {
      fs.mkdirSync(sslDir, { recursive: true });
      const hostname = require('os').hostname();
      const san = `DNS:${hostname},DNS:localhost,IP:127.0.0.1`;
      execSync(
        `umask 077 && openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=${hostname}" -addext "subjectAltName=${san}"`,
        { stdio: 'pipe', shell: true }
      );
      fs.chmodSync(keyPath, 0o600);
      sslOpts = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      console.log(`Generated self-signed TLS certificate (1yr, SAN: ${san}) at ${sslDir}`);
      console.warn('WARNING: Self-signed certificate in use. Install a CA-signed cert for production.');
    } catch (err) {
      console.error('Failed to generate self-signed cert:', err.message);
      console.log('Falling back to HTTP');
    }
  }

  let server;
  if (sslOpts) {
    server = https.createServer(sslOpts, app).listen(PORT, '0.0.0.0', () => {
      console.log(`Cluster monitor running at https://0.0.0.0:${PORT} (TLS)`);
    });
  } else {
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Cluster monitor running at http://0.0.0.0:${PORT}`);
    });
  }

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down gracefully…`);
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Shutdown timeout exceeded, forcing exit.');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

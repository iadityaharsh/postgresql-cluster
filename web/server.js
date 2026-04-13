const https = require('https');
const fs = require('fs');
const path = require('path');
const { createApp } = require('./src/app');

const { app, PORT, conf } = createApp();

// Export for testing
module.exports = { app };

// Start server (skip when imported for testing)
if (require.main === module) {
  // Try HTTPS first using existing SSL certs, fall back to HTTP
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

  if (sslOpts) {
    https.createServer(sslOpts, app).listen(PORT, '0.0.0.0', () => {
      console.log(`Cluster monitor running at https://0.0.0.0:${PORT} (TLS)`);
    });
  } else {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Cluster monitor running at http://0.0.0.0:${PORT}`);
    });
  }
}

process.on('SIGTERM', () => {
  process.exit(0);
});

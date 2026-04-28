const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.PG_MONITOR_LOG_DIR || '/var/log/pg-monitor';
const RETENTION_DAYS = parseInt(process.env.PG_MONITOR_LOG_RETENTION) || 30;

let currentDate = null;
let currentStream = null;

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function ensureStream() {
  const today = getDateStr();
  if (currentDate === today && currentStream) return currentStream;

  if (currentStream) {
    try { currentStream.end(); } catch {}
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}

  currentDate = today;
  const logPath = path.join(LOG_DIR, `pg-monitor-${today}.log`);
  currentStream = fs.createWriteStream(logPath, { flags: 'a' });
  currentStream.on('error', () => {}); // don't crash on write errors
  return currentStream;
}

const REDACT_PATTERNS = [
  /("?(?:password|pass|secret|token|key|api_token|api_key|auth)"?\s*[:=]\s*)"[^"]*"/gi,
  /("?(?:password|pass|secret|token|key|api_token|api_key|auth)"?\s*[:=]\s*)'[^']*'/gi,
  /(TUNNEL_TOKEN|INTERNAL_SECRET|PG_SUPERUSER_PASS|PG_REPLICATOR_PASS|PATRONI_API_PASS)=[^\s"']+/g,
];

function redact(msg) {
  let s = msg;
  for (const p of REDACT_PATTERNS) s = s.replace(p, (_, prefix) => `${prefix}"[REDACTED]"`);
  return s;
}

function write(level, args) {
  const raw = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const msg = redact(raw);
  const line = `[${getTimestamp()}] [${level}] ${msg}\n`;
  try {
    const stream = ensureStream();
    stream.write(line);
  } catch {}
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const file of files) {
      if (!file.startsWith('pg-monitor-') || !file.endsWith('.log')) continue;
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

function install() {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => {
    origLog(...args);
    write('INFO', args);
  };

  console.error = (...args) => {
    origError(...args);
    write('ERROR', args);
  };

  console.warn = (...args) => {
    origWarn(...args);
    write('WARN', args);
  };

  // Capture uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (err) => {
    write('FATAL', [`Uncaught exception: ${err.stack || err.message}`]);
    origError('Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack : String(reason);
    write('ERROR', [`Unhandled rejection: ${msg}`]);
    origError('Unhandled rejection:', reason);
  });

  // Clean old logs on startup and daily
  cleanOldLogs();
  setInterval(cleanOldLogs, 86400000);

  write('INFO', [`Logger initialized — log dir: ${LOG_DIR}, retention: ${RETENTION_DAYS} days`]);
}

module.exports = { install, LOG_DIR, RETENTION_DAYS };

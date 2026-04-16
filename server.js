const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const COMMAND_DIR = path.join(DATA_DIR, 'commands');
const COMMANDS_FILE = path.join(COMMAND_DIR, 'queue.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const EA_TOKEN = process.env.EA_TOKEN || '';
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const HISTORY_LIMIT = Math.max(20, Number(process.env.HISTORY_LIMIT || 300));
const HEARTBEAT_STALE_SEC = Math.max(5, Number(process.env.HEARTBEAT_STALE_SEC || 10));

for (const dir of [DATA_DIR, DAILY_DIR, COMMAND_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(COMMANDS_FILE)) {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), commands: [] }, null, 2));
}

const sseClients = new Set();

function safeBotName(name = 'BOT') {
  return String(name)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'BOT';
}

function safeSymbol(symbol = 'SYMBOL') {
  return String(symbol)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_') || 'SYMBOL';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKeyFromUnix(tsSeconds) {
  const d = Number.isFinite(tsSeconds) ? new Date(tsSeconds * 1000) : new Date();
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}`;
}

function dateIsoFromUnix(tsSeconds) {
  const d = Number.isFinite(tsSeconds) ? new Date(tsSeconds * 1000) : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function fileFor(bot, symbol, dateKey) {
  return path.join(DAILY_DIR, `${safeBotName(bot)}_${dateKey}.json`);
}

async function readJson(filePath, fallback) {
  try {
    const txt = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function authEa(req) {
  if (!EA_TOKEN) return true;
  return String(req.query.ea_token || '') === EA_TOKEN;
}

function authAdmin(req) {
  if (!ADMIN_PIN) return true;
  const pin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin || '';
  return String(pin) === ADMIN_PIN;
}

function signalText(v) {
  if (toInt(v) === 1) return 'BUY';
  if (toInt(v) === -1) return 'SELL';
  return 'WAIT';
}

function computeLiveState(snapshot) {
  const lastTs = toInt(snapshot.lastHeartbeatTs || snapshot.ts || 0);
  const age = Math.max(0, nowUnix() - lastTs);
  return {
    ageSec: age,
    isOnline: age <= HEARTBEAT_STALE_SEC,
    onlineText: age <= HEARTBEAT_STALE_SEC ? 'ONLINE' : 'OFFLINE'
  };
}

async function listDailyFiles(dateKey) {
  const names = await fsp.readdir(DAILY_DIR).catch(() => []);
  const filtered = dateKey
    ? names.filter((name) => name.endsWith(`_${dateKey}.json`))
    : names.filter((name) => name.endsWith('.json'));
  filtered.sort();
  return filtered;
}

async function loadSnapshotsByDate(dateKey) {
  const files = await listDailyFiles(dateKey);
  const rows = [];
  for (const name of files) {
    const full = path.join(DAILY_DIR, name);
    const json = await readJson(full, null);
    if (!json) continue;
    const live = computeLiveState(json);
    rows.push({
      ...json,
      fileName: name,
      ...live
    });
  }
  rows.sort((a, b) => toInt(b.lastHeartbeatTs) - toInt(a.lastHeartbeatTs));
  return rows;
}

async function loadQueue() {
  return readJson(COMMANDS_FILE, { updatedAt: new Date().toISOString(), commands: [] });
}

async function saveQueue(queue) {
  queue.updatedAt = new Date().toISOString();
  await writeJson(COMMANDS_FILE, queue);
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(message);
  }
}

app.use(express.static(PUBLIC_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, now: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  const timer = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(timer);
    sseClients.delete(res);
  });
});

app.get('/ea/heartbeat', async (req, res) => {
  if (!authEa(req)) {
    return res.status(403).json({ ok: false, error: 'bad_ea_token' });
  }

  const q = req.query;
  const ts = toInt(q.ts, nowUnix());
  const bot = safeBotName(q.bot || 'BOT');
  const symbol = safeSymbol(q.symbol || 'SYMBOL');
  const id = String(q.id || '0');
  const dateKey = dateKeyFromUnix(ts);
  const filePath = fileFor(bot, symbol, dateKey);
  const old = await readJson(filePath, null);

  const snapshot = {
    version: 1,
    fileName: path.basename(filePath),
    bot,
    symbol,
    accountId: id,
    dateKey,
    dateIso: dateIsoFromUnix(ts),
    firstSeenAt: old?.firstSeenAt || new Date().toISOString(),
    firstHeartbeatTs: old?.firstHeartbeatTs || ts,
    updatedAt: new Date().toISOString(),
    lastHeartbeatTs: ts,
    heartbeatCount: toInt(old?.heartbeatCount, 0) + 1,
    status: String(q.status || old?.status || 'UNKNOWN'),
    timeMode: String(q.timeMode || old?.timeMode || 'time'),
    action: String(q.action || old?.action || ''),
    hedge: String(q.hedge || old?.hedge || ''),
    positions: {
      buy: toInt(q.buy, old?.positions?.buy || 0),
      sell: toInt(q.sell, old?.positions?.sell || 0),
      total: toInt(q.orders, old?.positions?.total || 0)
    },
    signals: {
      m5: toInt(q.sigm5, old?.signals?.m5 || 0),
      m1: toInt(q.sigm1, old?.signals?.m1 || 0),
      all: toInt(q.sigall, old?.signals?.all || 0),
      m5Text: signalText(q.sigm5),
      m1Text: signalText(q.sigm1),
      allText: signalText(q.sigall)
    },
    metrics: {
      balance: toNum(q.balance, old?.metrics?.balance || 0),
      equity: toNum(q.equity, old?.metrics?.equity || 0),
      realProfit: toNum(q.realProfit, old?.metrics?.realProfit || 0),
      realPct: toNum(q.realPct, old?.metrics?.realPct || 0),
      dayTotal: toNum(q.dayTotal, old?.metrics?.dayTotal || 0),
      dd: toNum(q.dd, old?.metrics?.dd || 0),
      floating: toNum(q.floating, old?.metrics?.floating || 0),
      target: toNum(q.target, old?.metrics?.target || 0),
      remain: toNum(q.remain, old?.metrics?.remain || 0)
    },
    flags: {
      targetHit: toInt(q.targetHit, old?.flags?.targetHit || 0) === 1
    },
    raw: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])),
    history: Array.isArray(old?.history) ? old.history : []
  };

  snapshot.history.push({
    ts,
    updatedAt: snapshot.updatedAt,
    balance: snapshot.metrics.balance,
    equity: snapshot.metrics.equity,
    realProfit: snapshot.metrics.realProfit,
    realPct: snapshot.metrics.realPct,
    floating: snapshot.metrics.floating,
    dd: snapshot.metrics.dd,
    buy: snapshot.positions.buy,
    sell: snapshot.positions.sell,
    total: snapshot.positions.total,
    status: snapshot.status,
    action: snapshot.action
  });
  if (snapshot.history.length > HISTORY_LIMIT) {
    snapshot.history = snapshot.history.slice(-HISTORY_LIMIT);
  }

  await writeJson(filePath, snapshot);
  broadcast('heartbeat', {
    bot: snapshot.bot,
    symbol: snapshot.symbol,
    accountId: snapshot.accountId,
    fileName: snapshot.fileName,
    updatedAt: snapshot.updatedAt,
    status: snapshot.status,
    realProfit: snapshot.metrics.realProfit,
    realPct: snapshot.metrics.realPct,
    dd: snapshot.metrics.dd,
    onlineText: 'ONLINE'
  });

  res.json({
    ok: true,
    saved: true,
    file: snapshot.fileName,
    dateKey,
    updatedAt: snapshot.updatedAt
  });
});

app.get('/ea/next', async (req, res) => {
  if (!authEa(req)) {
    return res.status(403).json({ ok: false, error: 'bad_ea_token' });
  }

  const id = String(req.query.id || '0');
  const bot = safeBotName(req.query.bot || 'BOT');
  const symbol = safeSymbol(req.query.symbol || 'SYMBOL');

  const queue = await loadQueue();
  const cmd = queue.commands.find((item) => {
    if (item.status !== 'pending') return false;
    if (String(item.target?.accountId || '') !== id) return false;
    if (safeBotName(item.target?.bot || '') !== bot) return false;
    if (safeSymbol(item.target?.symbol || '') !== symbol) return false;
    return true;
  });

  if (!cmd) {
    return res.json({ ok: true, idle: true });
  }

  res.json({
    ok: true,
    nonce: cmd.nonce,
    cmd: cmd.cmd,
    createdAt: cmd.createdAt,
    note: cmd.note || '',
    lot1: cmd.payload?.lot1,
    lot2: cmd.payload?.lot2,
    lot3: cmd.payload?.lot3,
    lot4: cmd.payload?.lot4,
    lot5: cmd.payload?.lot5,
    timemode: cmd.payload?.timemode
  });
});

app.get('/ea/ack', async (req, res) => {
  if (!authEa(req)) {
    return res.status(403).json({ ok: false, error: 'bad_ea_token' });
  }

  const nonce = String(req.query.nonce || '');
  const result = String(req.query.result || '');
  const queue = await loadQueue();
  const cmd = queue.commands.find((item) => item.nonce === nonce);

  if (!cmd) {
    return res.json({ ok: true, ack: false, reason: 'nonce_not_found' });
  }

  cmd.status = 'done';
  cmd.result = result;
  cmd.ackedAt = new Date().toISOString();
  await saveQueue(queue);
  broadcast('ack', { nonce, result, target: cmd.target });
  res.json({ ok: true, ack: true, nonce, result });
});

app.get('/api/overview', async (req, res) => {
  const dateKey = String(req.query.date || dateKeyFromUnix(nowUnix()));
  const rows = await loadSnapshotsByDate(dateKey);
  res.json({ ok: true, dateKey, count: rows.length, rows });
});

app.get('/api/files', async (req, res) => {
  const dateKey = String(req.query.date || dateKeyFromUnix(nowUnix()));
  const files = await listDailyFiles(dateKey);
  res.json({ ok: true, dateKey, files });
});

app.get('/api/file/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(DAILY_DIR, name);
  const json = await readJson(full, null);
  if (!json) return res.status(404).json({ ok: false, error: 'file_not_found' });
  const live = computeLiveState(json);
  res.json({ ok: true, fileName: name, ...json, ...live });
});

app.get('/api/commands', async (req, res) => {
  if (!authAdmin(req)) return res.status(403).json({ ok: false, error: 'bad_admin_pin' });
  const queue = await loadQueue();
  const commands = [...queue.commands].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ ok: true, commands });
});

app.post('/api/command', async (req, res) => {
  if (!authAdmin(req)) return res.status(403).json({ ok: false, error: 'bad_admin_pin' });

  const { bot, symbol, accountId, cmd, note, payload } = req.body || {};
  if (!bot || !symbol || !accountId || !cmd) {
    return res.status(400).json({ ok: false, error: 'missing_bot_symbol_accountId_cmd' });
  }

  const queue = await loadQueue();
  const nonce = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    nonce,
    cmd: String(cmd),
    note: String(note || ''),
    status: 'pending',
    createdAt: new Date().toISOString(),
    target: {
      bot: safeBotName(bot),
      symbol: safeSymbol(symbol),
      accountId: String(accountId)
    },
    payload: payload && typeof payload === 'object' ? payload : {}
  };

  queue.commands.push(item);
  if (queue.commands.length > 1000) queue.commands.splice(0, queue.commands.length - 1000);
  await saveQueue(queue);
  broadcast('command', item);
  res.json({ ok: true, queued: true, nonce, item });
});

app.delete('/api/command/:nonce', async (req, res) => {
  if (!authAdmin(req)) return res.status(403).json({ ok: false, error: 'bad_admin_pin' });
  const nonce = String(req.params.nonce || '');
  const queue = await loadQueue();
  const idx = queue.commands.findIndex((item) => item.nonce === nonce);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  const [removed] = queue.commands.splice(idx, 1);
  await saveQueue(queue);
  res.json({ ok: true, removed });
});

app.get('/api/summary', async (req, res) => {
  const dateKey = String(req.query.date || dateKeyFromUnix(nowUnix()));
  const rows = await loadSnapshotsByDate(dateKey);
  const summary = rows.reduce((acc, row) => {
    acc.balance += toNum(row.metrics?.balance);
    acc.equity += toNum(row.metrics?.equity);
    acc.realProfit += toNum(row.metrics?.realProfit);
    acc.floating += toNum(row.metrics?.floating);
    acc.online += row.isOnline ? 1 : 0;
    acc.total += 1;
    return acc;
  }, { balance: 0, equity: 0, realProfit: 0, floating: 0, online: 0, total: 0 });
  res.json({ ok: true, dateKey, summary });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EA realtime dashboard running on :${PORT}`);
});

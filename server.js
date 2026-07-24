'use strict';

const express = require('express');
const net = require('net');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Backend "paladdon": Spielerliste + giveItem über die Paladdon-Bridge
// (PalChaos-UE4SS-Mod, File-IPC — der Server hat kein RCON).
const BRIDGE_URL = (process.env.BRIDGE_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
// Backend "paldefender": offizielle REST API + PalDefender-give über RCON.
const PALWORLD_API_URL = (process.env.PALWORLD_API_URL || '').replace(/\/+$/, '');
const PALWORLD_API_USER = process.env.PALWORLD_API_USER || 'admin';
const PALWORLD_API_PASS = process.env.PALWORLD_API_PASS || '';
const RCON_HOST = process.env.RCON_HOST || (PALWORLD_API_URL ? new URL(PALWORLD_API_URL).hostname : '');
const RCON_PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || PALWORLD_API_PASS;
const GIVE_COMMAND_TEMPLATE = process.env.GIVE_COMMAND_TEMPLATE || 'give {userId} {itemId} {amount}';
const BACKEND = process.env.BACKEND || (BRIDGE_URL ? 'paladdon' : 'paldefender');
const APP_USER = process.env.APP_USER || '';
const APP_PASS = process.env.APP_PASS || '';

const app = express();
app.use(express.json());

// Optional basic auth for the whole UI
if (APP_USER && APP_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === APP_USER && rest.join(':') === APP_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="palspawn"');
    res.status(401).send('Authentication required');
  });
}

// Icons ändern sich praktisch nie → lange cachen; HTML/CSS/JS/items.json
// müssen nach einem Container-Update sofort frisch kommen (ETag-Revalidierung).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.webp')) {
      res.set('Cache-Control', 'public, max-age=604800');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

// ---------------------------------------------------------------------------
// Source RCON client (PalDefender speaks standard Source RCON)
// ---------------------------------------------------------------------------

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH_RESPONSE = 2;

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + bodyBuf.length);
  buf.writeInt32LE(10 + bodyBuf.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

class Rcon {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RCON: Timeout beim Verbinden zu ${this.host}:${this.port}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        this._send(SERVERDATA_AUTH, this.password)
          .then((pkt) => {
            if (pkt.id === -1) reject(new Error('RCON: Authentifizierung fehlgeschlagen (Passwort prüfen)'));
            else resolve();
          })
          .catch(reject);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`RCON: Verbindung fehlgeschlagen (${err.message})`));
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + size) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.toString('utf8', 12, 4 + size - 2);
      this.buffer = this.buffer.subarray(4 + size);
      // Auth response answers with the request id (or -1 on failure); resolve
      // whichever pending request matches, otherwise the oldest one.
      const key = this.pending.has(id) ? id : (id === -1 ? this.pending.keys().next().value : undefined);
      if (key !== undefined && this.pending.has(key)) {
        const { resolve, timer } = this.pending.get(key);
        clearTimeout(timer);
        this.pending.delete(key);
        resolve({ id, type, body });
      }
    }
  }

  _send(type, body, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON: Timeout beim Warten auf Antwort'));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket.write(encodePacket(id, type, body), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async command(cmd) {
    const pkt = await this._send(SERVERDATA_EXECCOMMAND, cmd);
    return pkt.body;
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function bridgeFetch(pathName, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BRIDGE_URL}${pathName}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Paladdon-Bridge: BRIDGE_TOKEN ungültig');
    }
    if (!resp.ok) throw new Error(`Paladdon-Bridge antwortet mit HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Paladdon-Bridge: Timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Die Feature-Flags entscheiden, welche Panels die UI anzeigt. Bridge (In-Game-
// Ops) und offizielle REST API (Server-Administration) sind unabhängig
// voneinander konfigurierbar und können gleichzeitig aktiv sein.
const BRIDGE_OK = Boolean(BRIDGE_URL && BRIDGE_TOKEN);
const SERVER_ADMIN = Boolean(PALWORLD_API_URL && PALWORLD_API_PASS);

app.get('/api/config', (req, res) => {
  res.json({
    backend: BACKEND,
    apiConfigured: BACKEND === 'paladdon'
      ? BRIDGE_OK
      : Boolean(PALWORLD_API_URL && PALWORLD_API_PASS),
    rconConfigured: Boolean(RCON_HOST && RCON_PASSWORD),
    rconHost: RCON_HOST ? `${RCON_HOST}:${RCON_PORT}` : null,
    bridge: BRIDGE_URL || null,
    features: {
      give: true,
      teleport: BACKEND === 'paladdon' && BRIDGE_OK,
      palOps: BACKEND === 'paladdon' && BRIDGE_OK,
      bridgeAdmin: BACKEND === 'paladdon' && BRIDGE_OK,
      serverAdmin: SERVER_ADMIN,
      rcon: BACKEND !== 'paladdon' && Boolean(RCON_HOST && RCON_PASSWORD),
    },
  });
});

app.get('/api/players', async (req, res) => {
  if (BACKEND === 'paladdon') {
    if (!BRIDGE_URL || !BRIDGE_TOKEN) {
      return res.status(503).json({ error: 'BRIDGE_URL/BRIDGE_TOKEN ist nicht konfiguriert' });
    }
    try {
      const status = await bridgeFetch('/api/status');
      const mod = status.mod || {};
      const modStatus = mod.status || {};
      const players = (modStatus.players || []).map((p) => {
        const ids = p.ids || {};
        // Die REST API (Kick/Ban) erwartet die Steam-ID (steam_<id64>); der
        // Mod liefert sie als einen der Reflection-ID-Werte mit.
        const steamId = Object.values(ids).find(
          (v) => typeof v === 'string' && /^steam_[A-Za-z0-9]+$/i.test(v),
        ) || null;
        return {
          name: p.name,
          userId: p.uid,
          level: p.level ?? null,
          steamId,
          pos: p.pos && typeof p.pos.x === 'number'
            ? { x: p.pos.x, y: p.pos.y, z: p.pos.z }
            : null,
        };
      });
      return res.json({
        players,
        modAlive: mod.alive !== false,
        playersStale: modStatus.playersStale === true,
      });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }
  if (!PALWORLD_API_URL) {
    return res.status(503).json({ error: 'PALWORLD_API_URL ist nicht konfiguriert' });
  }
  try {
    const auth = Buffer.from(`${PALWORLD_API_USER}:${PALWORLD_API_PASS}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${PALWORLD_API_URL}/v1/api/players`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 401) {
      return res.status(502).json({ error: 'Palworld REST API: falsches Admin-Passwort (401)' });
    }
    if (!resp.ok) {
      return res.status(502).json({ error: `Palworld REST API antwortet mit HTTP ${resp.status}` });
    }
    const data = await resp.json();
    res.json({ players: data.players || [] });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
    res.status(502).json({ error: `Palworld REST API nicht erreichbar: ${msg}` });
  }
});

app.post('/api/give', async (req, res) => {
  const { userId, items } = req.body || {};
  if (BACKEND !== 'paladdon' && (!RCON_HOST || !RCON_PASSWORD)) {
    return res.status(503).json({ error: 'RCON_HOST/RCON_PASSWORD ist nicht konfiguriert' });
  }
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_]+$/.test(userId)) {
    return res.status(400).json({ error: 'Ungültige userId' });
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
    return res.status(400).json({ error: 'items muss eine Liste mit 1-200 Einträgen sein' });
  }
  for (const it of items) {
    if (typeof it.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(it.id)) {
      return res.status(400).json({ error: `Ungültige Item-ID: ${it.id}` });
    }
    it.amount = parseInt(it.amount, 10);
    if (!Number.isInteger(it.amount) || it.amount < 1 || it.amount > 999999) {
      return res.status(400).json({ error: `Ungültige Menge für ${it.id}` });
    }
  }

  if (BACKEND === 'paladdon') {
    if (!BRIDGE_URL || !BRIDGE_TOKEN) {
      return res.status(503).json({ error: 'BRIDGE_URL/BRIDGE_TOKEN ist nicht konfiguriert' });
    }
    try {
      const steps = items.map((it) => ({ op: 'giveItem', itemId: it.id, count: it.amount }));
      const resp = await bridgeFetch('/api/command', {
        method: 'POST',
        body: JSON.stringify({ steps, target: { uid: userId } }),
      }, 90000);
      if (resp.error) {
        return res.status(502).json({ error: `Paladdon-Bridge: ${resp.error}`, results: [] });
      }
      const stepResults = Array.isArray(resp.results) ? resp.results : [];
      const results = items.map((it, idx) => {
        const r = stepResults[idx];
        if (!r) return { id: it.id, amount: it.amount, ok: false, error: 'keine Antwort vom Mod' };
        return {
          id: it.id,
          amount: it.amount,
          ok: r.ok !== false,
          ...(r.ok === false ? { error: r.error || 'Fehler im Mod (Inventar voll?)' } : {}),
        };
      });
      return res.json({ results });
    } catch (err) {
      return res.status(502).json({ error: err.message, results: [] });
    }
  }

  const rcon = new Rcon(RCON_HOST, RCON_PORT, RCON_PASSWORD);
  const results = [];
  try {
    await rcon.connect();
    for (const it of items) {
      const cmd = GIVE_COMMAND_TEMPLATE
        .replace('{userId}', userId)
        .replace('{itemId}', it.id)
        .replace('{amount}', String(it.amount));
      try {
        const response = await rcon.command(cmd);
        results.push({ id: it.id, amount: it.amount, ok: true, response: response.trim() });
      } catch (err) {
        results.push({ id: it.id, amount: it.amount, ok: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err.message, results });
  } finally {
    rcon.close();
  }
});

function requireBridge(res) {
  if (BACKEND !== 'paladdon') {
    res.status(501).json({ error: 'Nur mit Paladdon-Bridge-Backend verfügbar' });
    return false;
  }
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    res.status(503).json({ error: 'BRIDGE_URL/BRIDGE_TOKEN ist nicht konfiguriert' });
    return false;
  }
  return true;
}

const UID_RE = /^[A-Za-z0-9_]+$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

app.post('/api/pos', async (req, res) => {
  if (!requireBridge(res)) return;
  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !UID_RE.test(userId)) {
    return res.status(400).json({ error: 'Ungültige userId' });
  }
  try {
    const resp = await bridgeFetch('/api/command', {
      method: 'POST',
      body: JSON.stringify({ steps: [{ op: 'getPos' }], target: { uid: userId } }),
    }, 30000);
    const r = (resp.results || [])[0];
    if (!r || r.ok === false || !r.data) {
      return res.status(502).json({ error: (r && r.error) || resp.error || 'getPos fehlgeschlagen' });
    }
    res.json({ pos: { x: r.data.x, y: r.data.y, z: r.data.z } });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/teleport', async (req, res) => {
  if (!requireBridge(res)) return;
  const { userId, mode } = req.body || {};
  if (typeof userId !== 'string' || !UID_RE.test(userId)) {
    return res.status(400).json({ error: 'Ungültige userId' });
  }
  let step;
  if (mode === 'to') {
    const x = num(req.body.x), y = num(req.body.y), z = num(req.body.z);
    if (x === null || y === null || z === null) {
      return res.status(400).json({ error: 'x, y, z müssen Zahlen sein' });
    }
    step = { op: 'teleportTo', x, y, z };
  } else if (mode === 'offset') {
    const dx = num(req.body.dx) ?? 0, dy = num(req.body.dy) ?? 0, dz = num(req.body.dz) ?? 0;
    step = { op: 'teleportOffset', dx, dy, dz };
  } else if (mode === 'toPlayer') {
    const targetUid = req.body.targetUid;
    if (typeof targetUid !== 'string' || !UID_RE.test(targetUid)) {
      return res.status(400).json({ error: 'Ungültige Ziel-userId' });
    }
    if (targetUid === userId) {
      return res.status(400).json({ error: 'Quelle und Ziel sind derselbe Spieler' });
    }
    step = { op: 'teleportToPlayer', uid: targetUid };
  } else {
    return res.status(400).json({ error: 'mode muss to, offset oder toPlayer sein' });
  }
  try {
    const resp = await bridgeFetch('/api/command', {
      method: 'POST',
      body: JSON.stringify({ steps: [step], target: { uid: userId } }),
    }, 30000);
    const r = (resp.results || [])[0];
    if (!r || r.ok === false) {
      return res.status(502).json({ error: (r && r.error) || resp.error || 'Teleport fehlgeschlagen' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Offizielle Palworld REST API (Server-Administration)
// Funktioniert unabhängig vom Backend, sobald PALWORLD_API_URL +
// PALWORLD_API_PASS gesetzt sind (auf dem palchaos-Server läuft die REST API
// containerintern auf Port 8212).
// ---------------------------------------------------------------------------

async function palApi(pathName, options = {}, timeoutMs = 10000) {
  const auth = Buffer.from(`${PALWORLD_API_USER}:${PALWORLD_API_PASS}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${PALWORLD_API_URL}/v1/api${pathName}`, {
      ...options,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });
    if (resp.status === 401) throw new Error('Palworld REST API: falsches Admin-Passwort (401)');
    if (!resp.ok) throw new Error(`Palworld REST API antwortet mit HTTP ${resp.status}`);
    // Aktions-Endpunkte antworten mit Text ("Successfully saved the world.")
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { message: text.trim() }; }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Palworld REST API: Timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireServerAdmin(res) {
  if (!SERVER_ADMIN) {
    res.status(503).json({ error: 'PALWORLD_API_URL/PALWORLD_API_PASS ist nicht konfiguriert' });
    return false;
  }
  return true;
}

for (const p of ['info', 'metrics', 'settings', 'gamedata']) {
  app.get(`/api/server/${p}`, async (req, res) => {
    if (!requireServerAdmin(res)) return;
    try {
      res.json(await palApi(`/${p}`));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

app.post('/api/server/announce', async (req, res) => {
  if (!requireServerAdmin(res)) return;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > 300) {
    return res.status(400).json({ error: 'message muss 1-300 Zeichen lang sein' });
  }
  try {
    res.json(await palApi('/announce', { method: 'POST', body: JSON.stringify({ message }) }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/server/save', async (req, res) => {
  if (!requireServerAdmin(res)) return;
  try {
    res.json(await palApi('/save', { method: 'POST' }, 60000));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/server/shutdown', async (req, res) => {
  if (!requireServerAdmin(res)) return;
  const waittime = parseInt(req.body?.waittime, 10);
  if (!Number.isInteger(waittime) || waittime < 1 || waittime > 3600) {
    return res.status(400).json({ error: 'waittime muss 1-3600 Sekunden sein' });
  }
  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 300) : '';
  try {
    res.json(await palApi('/shutdown', {
      method: 'POST',
      body: JSON.stringify({ waittime, ...(message ? { message } : {}) }),
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/server/stop', async (req, res) => {
  if (!requireServerAdmin(res)) return;
  try {
    res.json(await palApi('/stop', { method: 'POST' }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Kick/Ban/Unban: die REST API erwartet die Plattform-UserId (z. B. steam_<id64>)
for (const action of ['kick', 'ban', 'unban']) {
  app.post(`/api/server/${action}`, async (req, res) => {
    if (!requireServerAdmin(res)) return;
    const userid = req.body?.userId;
    if (typeof userid !== 'string' || !UID_RE.test(userid)) {
      return res.status(400).json({ error: 'Ungültige userId' });
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 300) : '';
    try {
      res.json(await palApi(`/${action}`, {
        method: 'POST',
        body: JSON.stringify({ userid, ...(message && action !== 'unban' ? { message } : {}) }),
      }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Bridge-Ops (PalChaos-Mod): validierte Whitelist weiterer In-Game-Operationen
// ---------------------------------------------------------------------------

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
};
const ID_RE = /^[A-Za-z0-9_]+$/;

// target: 'required' = Spieler nötig, 'optional' = wird mitgeschickt wenn
// vorhanden (z. B. announce), Rest der Params wird validiert/geklemmt.
const BRIDGE_OPS = {
  announce: {
    target: 'optional',
    build(b) {
      const message = typeof b.message === 'string' ? b.message.trim() : '';
      if (!message || message.length > 300) return { error: 'message muss 1-300 Zeichen lang sein' };
      return { step: { op: 'announce', message } };
    },
  },
  setGameHour: {
    target: 'optional',
    build(b) {
      const hour = clampInt(b.hour, 0, 23, null);
      if (hour === null) return { error: 'hour muss 0-23 sein' };
      return { step: { op: 'setGameHour', hour } };
    },
  },
  setHpRate: {
    target: 'required',
    build(b) {
      const rate = Number(b.rate);
      if (!Number.isFinite(rate) || rate < 0.01 || rate > 1) {
        return { error: 'rate muss zwischen 0.01 und 1 liegen' };
      }
      return { step: { op: 'setHpRate', rate } };
    },
  },
  wildWrath: {
    target: 'required',
    build(b) {
      return {
        step: {
          op: 'wildWrath',
          radiusM: clampInt(b.radiusM, 10, 200, 60),
          maxPals: clampInt(b.maxPals, 1, 15, 8),
        },
      };
    },
  },
  renamePartyPals: {
    target: 'required',
    build(b) {
      const reset = b.reset === true;
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!reset && (!name || name.length > 40)) {
        return { error: 'name muss 1-40 Zeichen lang sein' };
      }
      return {
        step: {
          op: 'renamePartyPals',
          name,
          maxPals: clampInt(b.maxPals, 1, 5, reset ? 5 : 1),
          reset,
          announceResult: b.announceResult === true,
        },
      };
    },
  },
  removeItem: {
    target: 'required',
    build(b) {
      if (typeof b.itemId !== 'string' || !ID_RE.test(b.itemId)) {
        return { error: 'Ungültige itemId' };
      }
      return { step: { op: 'removeItem', itemId: b.itemId, count: clampInt(b.count, 1, 9999, 1) } };
    },
  },
  dropRandomSlot: {
    target: 'required',
    build() { return { step: { op: 'dropRandomSlot' } }; },
  },
  listInventory: {
    target: 'required',
    build() { return { step: { op: 'listInventory' } }; },
  },
  spawnPal: {
    target: 'required',
    timeoutMs: 90000, // Spawn-Verify im Mod dauert bis ~61 s, Bridge wartet 75 s
    build(b) {
      if (typeof b.palId !== 'string' || !ID_RE.test(b.palId)) {
        return { error: 'Ungültige palId' };
      }
      const step = {
        op: 'spawnPal',
        palId: b.palId,
        count: clampInt(b.count, 1, 10, 1),
        level: clampInt(b.level, 1, 65, 1),
      };
      const despawn = clampInt(b.despawnAfterSec, 5, 600, null);
      if (despawn !== null) step.despawnAfterSec = despawn;
      return { step };
    },
  },
  spawnCaughtPal: {
    target: 'required',
    timeoutMs: 90000,
    build(b) {
      const step = {
        op: 'spawnCaughtPal',
        count: clampInt(b.count, 1, 10, 3),
        levelOffset: clampInt(b.levelOffset, -50, 50, 5),
      };
      const despawn = clampInt(b.despawnAfterSec, 5, 600, null);
      if (despawn !== null) step.despawnAfterSec = despawn;
      return { step };
    },
  },
};

app.post('/api/bridge/op', async (req, res) => {
  if (!requireBridge(res)) return;
  const body = req.body || {};
  const spec = BRIDGE_OPS[body.op];
  if (!spec) return res.status(400).json({ error: `Unbekannte Operation: ${body.op}` });
  let target;
  if (typeof body.userId === 'string' && UID_RE.test(body.userId)) {
    target = { uid: body.userId };
  } else if (spec.target === 'required') {
    return res.status(400).json({ error: 'Ungültige userId' });
  }
  const built = spec.build(body);
  if (built.error) return res.status(400).json({ error: built.error });
  try {
    const resp = await bridgeFetch('/api/command', {
      method: 'POST',
      body: JSON.stringify({ steps: [built.step], ...(target ? { target } : {}) }),
    }, spec.timeoutMs || 30000);
    const r = (resp.results || [])[0];
    if (!r || r.ok === false) {
      return res.status(502).json({ error: (r && r.error) || resp.error || `${body.op} fehlgeschlagen` });
    }
    res.json({ ok: true, data: r.data ?? null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bridge-Administration: Mod-Status, Logs, Pause
// ---------------------------------------------------------------------------

app.get('/api/bridge/status', async (req, res) => {
  if (!requireBridge(res)) return;
  try {
    const status = await bridgeFetch('/api/status');
    const mod = status.mod || {};
    const s = mod.status || {};
    res.json({
      alive: mod.alive !== false,
      modVersion: s.modVersion || null,
      armed: s.armed === true,
      allowEval: s.allowEval === true,
      ops: s.ops || [],
      playersStale: s.playersStale === true,
      recentErrors: s.recentErrors || [],
      queue: status.queue ?? null,
      paused: status.config?.paused === true,
      presence: status.presence?.state || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/bridge/logs', async (req, res) => {
  if (!requireBridge(res)) return;
  try {
    res.json(await bridgeFetch('/api/logs'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/bridge/pause', async (req, res) => {
  if (!requireBridge(res)) return;
  if (typeof req.body?.paused !== 'boolean') {
    return res.status(400).json({ error: 'paused muss true oder false sein' });
  }
  try {
    res.json(await bridgeFetch('/api/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: req.body.paused }),
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// RCON-Konsole (nur PalDefender-Backend)
// ---------------------------------------------------------------------------

app.post('/api/rcon', async (req, res) => {
  if (BACKEND === 'paladdon') {
    return res.status(501).json({ error: 'RCON ist nur im PalDefender-Backend verfügbar' });
  }
  if (!RCON_HOST || !RCON_PASSWORD) {
    return res.status(503).json({ error: 'RCON_HOST/RCON_PASSWORD ist nicht konfiguriert' });
  }
  const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!command || command.length > 250 || /[\x00-\x1f]/.test(command)) {
    return res.status(400).json({ error: 'command muss 1-250 Zeichen ohne Steuerzeichen sein' });
  }
  const rcon = new Rcon(RCON_HOST, RCON_PORT, RCON_PASSWORD);
  try {
    await rcon.connect();
    const response = await rcon.command(command);
    res.json({ response: response.trim() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    rcon.close();
  }
});

const server = app.listen(PORT, () => {
  console.log(`palspawn läuft auf Port ${PORT} (Backend: ${BACKEND})`);
  if (BACKEND === 'paladdon') {
    console.log(`  Bridge: ${BRIDGE_URL || '(nicht konfiguriert)'}`);
  } else {
    console.log(`  REST API: ${PALWORLD_API_URL || '(nicht konfiguriert)'}`);
    console.log(`  RCON:     ${RCON_HOST ? `${RCON_HOST}:${RCON_PORT}` : '(nicht konfiguriert)'}`);
  }
});

// Als PID 1 im Container bekommt Node keine Default-Signal-Handler —
// ohne diese Handler ignoriert der Prozess SIGTERM und Docker wartet
// beim Stoppen bis zum Kill-Timeout.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

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

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', immutable: false }));

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

app.get('/api/config', (req, res) => {
  res.json({
    backend: BACKEND,
    apiConfigured: BACKEND === 'paladdon'
      ? Boolean(BRIDGE_URL && BRIDGE_TOKEN)
      : Boolean(PALWORLD_API_URL && PALWORLD_API_PASS),
    rconConfigured: Boolean(RCON_HOST && RCON_PASSWORD),
    rconHost: RCON_HOST ? `${RCON_HOST}:${RCON_PORT}` : null,
    bridge: BRIDGE_URL || null,
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
      const players = (modStatus.players || []).map((p) => ({
        name: p.name,
        userId: p.uid,
        level: p.level ?? null,
      }));
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

app.listen(PORT, () => {
  console.log(`palspawn läuft auf Port ${PORT}`);
  console.log(`  REST API: ${PALWORLD_API_URL || '(nicht konfiguriert)'}`);
  console.log(`  RCON:     ${RCON_HOST ? `${RCON_HOST}:${RCON_PORT}` : '(nicht konfiguriert)'}`);
});

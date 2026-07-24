'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  items: [],
  cart: new Map(), // id -> amount
  players: [],
  backend: null,
  features: { give: true, teleport: false, palOps: false, bridgeAdmin: false, serverAdmin: false, rcon: false },
  activeTab: 'items',
  serverTimer: null,   // Metrik-Polling (nur solange Server-Tab aktiv)
  logsTimer: null,     // Bridge-Status/Log-Polling (nur solange Logs-Tab aktiv)
  settings: null,      // gecachte /api/server/settings
  iniSettings: null,   // { settings: {key: rohwert}, locked: [...] } aus der ini
  lastMetricsErr: null,
  lastBridgeErr: null,
  rconHistory: [],
  rconHistIdx: 0,
};

const els = {
  // Header / global
  playerSelect: $('#player-select'),
  refreshPlayers: $('#refresh-players'),
  serverStatus: $('#server-status'),
  tabs: $('#tabs'),
  // Items-Tab
  grid: $('#grid'),
  search: $('#search'),
  category: $('#category'),
  sort: $('#sort'),
  showUnnamed: $('#show-unnamed'),
  count: $('#result-count'),
  // Cart-Sidebar
  cartItems: $('#cart-items'),
  cartPlayer: $('#cart-player'),
  clearCart: $('#clear-cart'),
  spawn: $('#spawn'),
  log: $('#log'),
  // Spieler-Tab
  playersBox: $('#players-box'),
  unbanRow: $('#unban-row'),
  unbanSelect: $('#unban-select'),
  unbanRefresh: $('#unban-refresh'),
  unbanId: $('#unban-id'),
  unbanBtn: $('#unban-btn'),
  teleport: $('#teleport'),
  tpGetpos: $('#tp-getpos'),
  tpPos: $('#tp-pos'),
  tpX: $('#tp-x'),
  tpY: $('#tp-y'),
  tpZ: $('#tp-z'),
  tpGo: $('#tp-go'),
  tpSpots: $('#tp-spots'),
  tpSave: $('#tp-save'),
  tpDel: $('#tp-del'),
  tpPlayer: $('#tp-player'),
  tpToplayer: $('#tp-toplayer'),
  charActions: $('#char-actions'),
  hpRange: $('#hp-range'),
  hpNum: $('#hp-num'),
  hpSet: $('#hp-set'),
  rnName: $('#rn-name'),
  rnMax: $('#rn-max'),
  rnAnnounce: $('#rn-announce'),
  rnApply: $('#rn-apply'),
  rnReset: $('#rn-reset'),
  riId: $('#ri-id'),
  riCount: $('#ri-count'),
  riBtn: $('#ri-btn'),
  invLoad: $('#inv-load'),
  invBox: $('#inv-box'),
  dropBtn: $('#drop-btn'),
  itemIds: $('#item-ids'),
  // Pals-Tab
  spPalid: $('#sp-palid'),
  spCount: $('#sp-count'),
  spLevel: $('#sp-level'),
  spDespawn: $('#sp-despawn'),
  spBtn: $('#sp-btn'),
  scCount: $('#sc-count'),
  scOffset: $('#sc-offset'),
  scBtn: $('#sc-btn'),
  ghHour: $('#gh-hour'),
  ghSet: $('#gh-set'),
  ghDay: $('#gh-day'),
  ghNight: $('#gh-night'),
  wwRadius: $('#ww-radius'),
  wwMax: $('#ww-max'),
  wwBtn: $('#ww-btn'),
  // Server-Tab
  srvName: $('#srv-name'),
  srvVersion: $('#srv-version'),
  srvDesc: $('#srv-desc'),
  mFps: $('#m-fps'),
  mFrametime: $('#m-frametime'),
  mPlayers: $('#m-players'),
  mUptime: $('#m-uptime'),
  mDays: $('#m-days'),
  mBases: $('#m-bases'),
  annMsg: $('#ann-msg'),
  annBtn: $('#ann-btn'),
  saveBtn: $('#save-btn'),
  sdWait: $('#sd-wait'),
  sdMsg: $('#sd-msg'),
  sdBtn: $('#sd-btn'),
  stopBtn: $('#stop-btn'),
  setSearch: $('#set-search'),
  settingsHint: $('#settings-hint'),
  settingsBox: $('#settings-box'),
  // Logs-Tab
  bridgeAdmin: $('#bridge-admin'),
  bridgeStatus: $('#bridge-status'),
  pauseToggle: $('#pause-toggle'),
  bridgeLogs: $('#bridge-logs'),
  rconBox: $('#rcon-box'),
  rconOut: $('#rcon-out'),
  rconIn: $('#rcon-in'),
  rconSend: $('#rcon-send'),
};

const RARITY_LABELS = ['Gewöhnlich', 'Ungewöhnlich', 'Selten', 'Episch', 'Legendär'];

const CATEGORY_LABELS = {
  Accessory: 'Accessoires',
  Ammo: 'Munition',
  Armor: 'Rüstung',
  Blueprint: 'Baupläne',
  Consume: 'Verbrauchsgegenstände',
  Essential: 'Wichtige Items',
  Food: 'Nahrung',
  Glider: 'Gleiter',
  Jewelry: 'Schmuck',
  Material: 'Materialien',
  Other: 'Sonstiges',
  PalAwakening: 'Pal-Erweckung',
  PalSphere: 'Sphären',
  QuestItem: 'Quest-Items',
  Relic: 'Relikte',
  Salvage: 'Bergung',
  SphereModule: 'Sphären-Module',
  Weapon: 'Waffen',
};

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

function logLine(text, cls = 'info') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  els.log.prepend(div);
  while (els.log.children.length > 60) els.log.lastChild.remove();
}

async function apiGet(path) {
  const resp = await fetch(path);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function apiPost(path, body) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function copyText(text) {
  if (!navigator.clipboard) return logLine('Kopieren wird vom Browser nicht unterstützt.', 'err');
  navigator.clipboard.writeText(text).then(
    () => logLine(`Kopiert: ${text}`, 'info'),
    () => logLine('Kopieren fehlgeschlagen.', 'err'),
  );
}

function requirePlayer() {
  const userId = els.playerSelect.value;
  if (!userId) logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  return userId;
}

// Anzeigename mit Fallback: der Mod meldet bei leerem Server mitunter einen
// Eintrag ohne Namen — dann statt Leerstring die userId zeigen
function playerLabel(p) {
  return p.name || `Spieler ${p.userId}`;
}

function selectedPlayerName() {
  const p = state.players.find((x) => x.userId === els.playerSelect.value);
  return p ? playerLabel(p) : els.playerSelect.value;
}

// ---------------------------------------------------------------------------
// Konfiguration + Tabs
// ---------------------------------------------------------------------------

const TAB_KEY = 'palspawn.tab';

function tabAvailable(tab) {
  const f = state.features;
  if (tab === 'items' || tab === 'players') return true;
  if (tab === 'pals') return f.palOps;
  if (tab === 'server') return f.serverAdmin;
  if (tab === 'logs') return f.bridgeAdmin || f.rcon;
  return false;
}

function applyFeatures() {
  const f = state.features;
  for (const btn of els.tabs.querySelectorAll('.tab')) {
    btn.hidden = !tabAvailable(btn.dataset.tab);
  }
  els.teleport.hidden = !f.teleport;
  els.charActions.hidden = !f.palOps;
  els.unbanRow.hidden = !f.serverAdmin;
  els.unbanSelect.hidden = !f.banlist;
  els.unbanRefresh.hidden = !f.banlist;
  els.settingsHint.hidden = !f.settingsEdit;
  els.bridgeAdmin.hidden = !f.bridgeAdmin;
  els.rconBox.hidden = !f.rcon;
}

function setTab(tab) {
  if (!tabAvailable(tab)) tab = 'items';
  state.activeTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  for (const btn of els.tabs.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== `panel-${tab}`;
  }
  // Polling nur solange der jeweilige Tab aktiv ist
  stopServerPolling();
  stopLogsPolling();
  if (tab === 'server') startServerPolling();
  if (tab === 'logs' && state.features.bridgeAdmin) startLogsPolling();
  if (tab === 'players') loadBanlist();
}

async function loadConfig() {
  try {
    const data = await apiGet('api/config');
    state.backend = data.backend || null;
    state.features = { ...state.features, ...(data.features || {}) };
  } catch (err) {
    logLine(`Konfiguration: ${err.message}`, 'err');
  }
  applyFeatures();
  setTab(localStorage.getItem(TAB_KEY) || 'items');
}

// ---------------------------------------------------------------------------
// Items laden + rendern
// ---------------------------------------------------------------------------

async function loadItems() {
  const resp = await fetch('items.json?v=2');
  state.items = await resp.json();

  const cats = [...new Set(state.items.map((i) => i.category))].sort((a, b) =>
    (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b, 'de'));
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = CATEGORY_LABELS[c] || c;
    els.category.appendChild(opt);
  }

  // Datalist für „Item entfernen" (Charakter-Aktionen)
  const dl = document.createDocumentFragment();
  for (const i of state.items) {
    const opt = document.createElement('option');
    opt.value = i.id;
    if (i.localized) opt.label = i.name_de;
    dl.appendChild(opt);
  }
  els.itemIds.replaceChildren(dl);

  render();
}

function filteredItems() {
  const q = els.search.value.trim().toLowerCase();
  const cat = els.category.value;
  const showUnnamed = els.showUnnamed.checked;
  let list = state.items.filter((i) => {
    if (!showUnnamed && !i.localized) return false;
    if (cat && i.category !== cat) return false;
    if (q) {
      return i.name.toLowerCase().includes(q)
        || i.name_de.toLowerCase().includes(q)
        || i.id.toLowerCase().includes(q);
    }
    return true;
  });

  const sort = els.sort.value;
  const by = (fn, dir = 1) => (a, b) => dir * fn(a).localeCompare(fn(b), 'de');
  if (sort === 'name_de') list.sort(by((i) => i.name_de));
  else if (sort === 'name_de_desc') list.sort(by((i) => i.name_de, -1));
  else if (sort === 'name') list.sort(by((i) => i.name));
  else if (sort === 'id') list.sort(by((i) => i.id));
  else if (sort === 'category') list.sort((a, b) =>
    (CATEGORY_LABELS[a.category] || a.category).localeCompare(CATEGORY_LABELS[b.category] || b.category, 'de')
    || a.name_de.localeCompare(b.name_de, 'de'));
  else if (sort === 'rarity') list.sort((a, b) =>
    (b.rarity ?? -1) - (a.rarity ?? -1) || a.name_de.localeCompare(b.name_de, 'de'));
  return list;
}

function render() {
  const list = filteredItems();
  els.count.textContent = `${list.length} Items`;
  const frag = document.createDocumentFragment();
  for (const item of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item'
      + (state.cart.has(item.id) ? ' selected' : '')
      + (item.rarity >= 1 && item.rarity <= 4 ? ` r${item.rarity}` : '');
    btn.dataset.id = item.id;
    const rarity = RARITY_LABELS[item.rarity] ? ` – ${RARITY_LABELS[item.rarity]}` : '';
    btn.title = `${item.name} (${item.id})${rarity}`;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `icons/${item.icon}`;
    img.alt = '';

    const txt = document.createElement('div');
    txt.className = 'txt';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = item.name_de;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.name_de !== item.name ? `${item.name} · ${item.id}` : item.id;
    txt.append(nm, meta);
    btn.append(img, txt);
    frag.appendChild(btn);
  }
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'none';
    p.textContent = 'Keine Items gefunden.';
    frag.appendChild(p);
  }
  els.grid.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Warenkorb
// ---------------------------------------------------------------------------

function toggleCart(id) {
  if (state.cart.has(id)) state.cart.delete(id);
  else state.cart.set(id, 1);
  renderCart();
  const card = els.grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('selected', state.cart.has(id));
}

function renderCart() {
  const frag = document.createDocumentFragment();
  if (!state.cart.size) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.innerHTML = 'Noch nichts ausgewählt.<br>Klicke links auf ein Item.';
    frag.appendChild(p);
  }
  for (const [id, amount] of state.cart) {
    const item = state.items.find((i) => i.id === id);
    if (!item) continue;
    const row = document.createElement('div');
    row.className = 'cart-row'
      + (item.rarity >= 1 && item.rarity <= 4 ? ` r${item.rarity}` : '');

    const img = document.createElement('img');
    img.src = `icons/${item.icon}`;
    img.alt = '';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name_de;
    nm.title = item.id;

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.max = '999999';
    qty.value = amount;
    qty.setAttribute('aria-label', `Menge für ${item.name_de}`);
    qty.addEventListener('change', () => {
      const v = Math.max(1, Math.min(999999, parseInt(qty.value, 10) || 1));
      qty.value = v;
      state.cart.set(id, v);
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Entfernen';
    rm.addEventListener('click', () => toggleCart(id));

    row.append(img, nm, qty, rm);
    frag.appendChild(row);
  }
  els.cartItems.replaceChildren(frag);
  updateSpawnButton();
}

function updateSpawnButton() {
  els.spawn.disabled = !state.cart.size || !els.playerSelect.value;
}

// ---------------------------------------------------------------------------
// Spieler
// ---------------------------------------------------------------------------

// Header- und Cart-Dropdown zeigen dieselbe Spielerliste und bleiben synchron.
function fillPlayerSelect(sel) {
  const prev = sel.value;
  sel.replaceChildren();
  if (!state.players.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '– keine Spieler online –';
    sel.appendChild(opt);
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '– Spieler wählen –';
  sel.appendChild(placeholder);
  for (const p of state.players) {
    const opt = document.createElement('option');
    opt.value = p.userId;
    opt.textContent = p.level != null ? `${playerLabel(p)} (Level ${p.level})` : playerLabel(p);
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function loadPlayers() {
  els.serverStatus.textContent = '…';
  els.serverStatus.className = 'status';
  try {
    const resp = await fetch('api/players');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    state.players = data.players;
    fillPlayerSelect(els.playerSelect);
    fillPlayerSelect(els.cartPlayer);
    if (data.modAlive === false) {
      els.serverStatus.textContent = 'Mod offline!';
      els.serverStatus.className = 'status err';
    } else if (data.playersStale) {
      els.serverStatus.textContent = `${state.players.length} online (Liste veraltet)`;
      els.serverStatus.className = 'status';
    } else {
      els.serverStatus.textContent = `${state.players.length} online`;
      els.serverStatus.className = 'status ok';
    }
  } catch (err) {
    for (const sel of [els.playerSelect, els.cartPlayer]) {
      sel.replaceChildren();
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '– Server nicht erreichbar –';
      sel.appendChild(opt);
    }
    els.serverStatus.textContent = err.message;
    els.serverStatus.className = 'status err';
  }
  updateSpawnButton();
  renderTpPlayers();
  renderPlayersTable();
}

// Plattform-ID für Kick/Ban (REST API erwartet z. B. steam_<id64>):
// paladdon liefert sie als steamId, bei paldefender ist userId bereits die
// Plattform-ID.
function platformId(p) {
  if (p.steamId) return p.steamId;
  if (state.backend !== 'paladdon' && typeof p.userId === 'string' && p.userId) return p.userId;
  return null;
}

function posText(p) {
  if (p.pos && typeof p.pos.x === 'number') {
    return `${Math.round(p.pos.x)} / ${Math.round(p.pos.y)} / ${Math.round(p.pos.z)}`;
  }
  if (typeof p.location_x === 'number' && typeof p.location_y === 'number') {
    return `${Math.round(p.location_x)} / ${Math.round(p.location_y)}`;
  }
  return '–';
}

function renderPlayersTable() {
  if (!state.players.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Keine Spieler online.';
    els.playersBox.replaceChildren(p);
    return;
  }
  const hasSteam = state.players.some((p) => p.steamId);
  const hasPing = state.players.some((p) => p.ping != null);
  const hasIp = state.players.some((p) => p.ip);

  const table = document.createElement('table');
  table.className = 'data';
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  const cols = ['Name', 'Level', 'Position', 'userId'];
  if (hasSteam) cols.push('steamId');
  if (hasPing) cols.push('Ping');
  if (hasIp) cols.push('IP');
  cols.push('');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);

  const tbody = document.createElement('tbody');
  for (const p of state.players) {
    const tr = document.createElement('tr');
    const td = (text) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      tr.appendChild(cell);
      return cell;
    };
    td(playerLabel(p));
    td(p.level != null ? String(p.level) : '–');
    td(posText(p));
    const uidCell = td(p.userId || '–');
    if (p.userId) {
      uidCell.className = 'copy';
      uidCell.title = 'Klicken zum Kopieren';
      uidCell.addEventListener('click', () => copyText(p.userId));
    }
    if (hasSteam) {
      const sidCell = td(p.steamId || '–');
      if (p.steamId) {
        sidCell.className = 'copy';
        sidCell.title = 'Klicken zum Kopieren';
        sidCell.addEventListener('click', () => copyText(p.steamId));
      }
    }
    if (hasPing) td(p.ping != null ? `${Math.round(p.ping)} ms` : '–');
    if (hasIp) td(p.ip || '–');

    const actCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const sel = document.createElement('button');
    sel.type = 'button';
    sel.textContent = 'Auswählen';
    sel.addEventListener('click', () => {
      els.playerSelect.value = p.userId;
      updateSpawnButton();
      renderTpPlayers();
      logLine(`Spieler ${playerLabel(p)} ausgewählt.`, 'info');
    });
    actions.appendChild(sel);
    if (state.features.serverAdmin) {
      for (const [action, label] of [['kick', 'Kick'], ['ban', 'Bannen']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'danger';
        b.textContent = label;
        const pid = platformId(p);
        if (!pid) {
          b.disabled = true;
          b.title = 'Keine Plattform-ID (steamId) bekannt';
        } else {
          b.addEventListener('click', () => kickBan(action, p, pid));
        }
        actions.appendChild(b);
      }
    }
    actCell.appendChild(actions);
    tr.appendChild(actCell);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  els.playersBox.replaceChildren(table);
}

async function kickBan(action, p, pid) {
  const verb = action === 'kick' ? 'kicken' : 'bannen';
  const message = window.prompt(`Grund (optional) – ${playerLabel(p)} ${verb}:`, '');
  if (message === null) return; // abgebrochen
  if (!window.confirm(`${playerLabel(p)} wirklich ${verb}?`)) return;
  try {
    await apiPost(`api/server/${action}`, {
      userId: pid,
      ...(message.trim() ? { message: message.trim() } : {}),
      // Beim Bannen den Namen mitgeben — der Server merkt ihn sich für die Bann-Liste
      ...(action === 'ban' && p.name ? { name: p.name } : {}),
    });
    logLine(`${playerLabel(p)} ${action === 'kick' ? 'gekickt' : 'gebannt'}.`, 'ok');
    loadPlayers();
    if (action === 'ban') loadBanlist();
  } catch (err) {
    logLine(`${action === 'kick' ? 'Kick' : 'Bann'}: ${err.message}`, 'err');
  }
}

// Bann-Liste aus banlist.txt des Servers (nur wenn features.banlist)
async function loadBanlist() {
  if (!state.features.banlist) return;
  try {
    const d = await apiGet('api/server/banlist');
    const banned = Array.isArray(d.banned) ? d.banned : [];
    const prev = els.unbanSelect.value;
    els.unbanSelect.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = banned.length ? `– gebannte Spieler (${banned.length}) –` : '– keine Banns –';
    els.unbanSelect.appendChild(ph);
    for (const b of banned) {
      const opt = document.createElement('option');
      opt.value = b.userId;
      opt.textContent = b.name ? `${b.name} (${b.userId})` : b.userId;
      els.unbanSelect.appendChild(opt);
    }
    if ([...els.unbanSelect.options].some((o) => o.value === prev)) els.unbanSelect.value = prev;
  } catch (err) {
    logLine(`Bann-Liste: ${err.message}`, 'err');
  }
}

async function unban() {
  const userId = els.unbanId.value.trim();
  if (!userId) return logLine('Entbannen: userId eingeben oder aus der Liste wählen.', 'err');
  els.unbanBtn.disabled = true;
  try {
    await apiPost('api/server/unban', { userId });
    logLine(`${userId} entbannt.`, 'ok');
    els.unbanId.value = '';
    els.unbanSelect.value = '';
    loadBanlist();
  } catch (err) {
    logLine(`Entbannen: ${err.message}`, 'err');
  }
  els.unbanBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Spawnen (Items)
// ---------------------------------------------------------------------------

async function spawn() {
  const userId = els.playerSelect.value;
  if (!userId || !state.cart.size) return;
  const player = state.players.find((p) => p.userId === userId);
  const items = [...state.cart].map(([id, amount]) => ({ id, amount }));

  els.spawn.disabled = true;
  els.spawn.textContent = 'Spawne…';
  logLine(`Sende ${items.length} Item(s) an ${player ? player.name : userId}…`);
  try {
    const resp = await fetch('api/give', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, items }),
    });
    const data = await resp.json();
    if (data.results) {
      for (const r of data.results) {
        const item = state.items.find((i) => i.id === r.id);
        const label = item ? item.name_de : r.id;
        if (r.ok) logLine(`✓ ${r.amount}× ${label}`, 'ok');
        else logLine(`✗ ${label}: ${r.error}`, 'err');
      }
    }
    if (!resp.ok) {
      logLine(`Fehler: ${data.error || `HTTP ${resp.status}`}`, 'err');
    } else if (data.results.every((r) => r.ok)) {
      logLine('Fertig.', 'info');
    }
  } catch (err) {
    logLine(`Fehler: ${err.message}`, 'err');
  }
  els.spawn.textContent = 'Spawnen';
  updateSpawnButton();
}

// ---------------------------------------------------------------------------
// Teleport
// ---------------------------------------------------------------------------

const SPOTS_KEY = 'palspawn.spots';

function loadSpots() {
  try { return JSON.parse(localStorage.getItem(SPOTS_KEY)) || []; }
  catch { return []; }
}

function renderSpots() {
  const spots = loadSpots();
  const prev = els.tpSpots.value;
  els.tpSpots.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = spots.length ? '– gespeicherte Orte –' : '– keine Orte gespeichert –';
  els.tpSpots.appendChild(ph);
  spots.forEach((s, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = s.name;
    els.tpSpots.appendChild(opt);
  });
  if ([...els.tpSpots.options].some((o) => o.value === prev)) els.tpSpots.value = prev;
}

function renderTpPlayers() {
  const current = els.playerSelect.value;
  const prev = els.tpPlayer.value;
  els.tpPlayer.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '– zu Spieler –';
  els.tpPlayer.appendChild(ph);
  for (const p of state.players) {
    if (p.userId === current) continue;
    const opt = document.createElement('option');
    opt.value = p.userId;
    opt.textContent = playerLabel(p);
    els.tpPlayer.appendChild(opt);
  }
  if ([...els.tpPlayer.options].some((o) => o.value === prev)) els.tpPlayer.value = prev;
}

async function tpApi(path, body, okMsg) {
  try {
    const data = await apiPost(path, body);
    if (okMsg) logLine(okMsg, 'ok');
    return data;
  } catch (err) {
    logLine(`Teleport: ${err.message}`, 'err');
    return null;
  }
}

async function tpGetPos() {
  const userId = requirePlayer();
  if (!userId) return;
  els.tpGetpos.disabled = true;
  const data = await tpApi('api/pos', { userId });
  els.tpGetpos.disabled = false;
  if (!data) return;
  const { x, y, z } = data.pos;
  els.tpX.value = Math.round(x);
  els.tpY.value = Math.round(y);
  els.tpZ.value = Math.round(z);
  els.tpPos.textContent = `${Math.round(x)} / ${Math.round(y)} / ${Math.round(z)}`;
}

async function tpGo() {
  const userId = requirePlayer();
  if (!userId) return;
  const x = parseFloat(els.tpX.value), y = parseFloat(els.tpY.value), z = parseFloat(els.tpZ.value);
  if ([x, y, z].some((v) => !Number.isFinite(v))) {
    return logLine('Teleport: X, Y und Z ausfüllen (z. B. über „Position holen").', 'err');
  }
  els.tpGo.disabled = true;
  await tpApi('api/teleport', { userId, mode: 'to', x, y, z },
    `Teleportiert nach ${Math.round(x)} / ${Math.round(y)} / ${Math.round(z)}.`);
  els.tpGo.disabled = false;
}

async function tpToPlayer() {
  const userId = requirePlayer();
  if (!userId) return;
  const targetUid = els.tpPlayer.value;
  if (!targetUid) return logLine('Teleport: Zielspieler auswählen.', 'err');
  const target = state.players.find((p) => p.userId === targetUid);
  els.tpToplayer.disabled = true;
  await tpApi('api/teleport', { userId, mode: 'toPlayer', targetUid },
    `Teleportiert zu ${target ? target.name : targetUid}.`);
  els.tpToplayer.disabled = false;
}

function tpSaveSpot() {
  const x = parseFloat(els.tpX.value), y = parseFloat(els.tpY.value), z = parseFloat(els.tpZ.value);
  if ([x, y, z].some((v) => !Number.isFinite(v))) {
    return logLine('Speichern: erst Koordinaten eintragen oder „Position holen".', 'err');
  }
  const name = (window.prompt('Name des Ortes:') || '').trim();
  if (!name) return;
  const spots = loadSpots();
  spots.push({ name, x, y, z });
  localStorage.setItem(SPOTS_KEY, JSON.stringify(spots));
  renderSpots();
  els.tpSpots.value = String(spots.length - 1);
  logLine(`Ort „${name}" gespeichert.`, 'ok');
}

function tpDeleteSpot() {
  const idx = parseInt(els.tpSpots.value, 10);
  const spots = loadSpots();
  if (!Number.isInteger(idx) || !spots[idx]) return;
  const [removed] = spots.splice(idx, 1);
  localStorage.setItem(SPOTS_KEY, JSON.stringify(spots));
  renderSpots();
  logLine(`Ort „${removed.name}" gelöscht.`, 'info');
}

function tpSelectSpot() {
  const idx = parseInt(els.tpSpots.value, 10);
  const spot = loadSpots()[idx];
  if (!spot) return;
  els.tpX.value = spot.x;
  els.tpY.value = spot.y;
  els.tpZ.value = spot.z;
}

// ---------------------------------------------------------------------------
// Bridge-Ops (Charakter-Aktionen + Pals)
// ---------------------------------------------------------------------------

// Schickt eine Op an api/bridge/op. userId wird automatisch aus der globalen
// Spielerauswahl mitgeschickt (bei needPlayer=false nur, wenn gewählt).
async function bridgeOp(op, params, { needPlayer = true, okMsg, btn } = {}) {
  const userId = els.playerSelect.value;
  if (needPlayer && !userId) {
    logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
    return null;
  }
  if (btn) btn.disabled = true;
  try {
    const data = await apiPost('api/bridge/op', {
      op,
      ...(userId ? { userId } : {}),
      ...params,
    });
    if (okMsg) logLine(okMsg, 'ok');
    return data;
  } catch (err) {
    logLine(`${op}: ${err.message}`, 'err');
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function hpApply() {
  const pct = clampInt(els.hpNum.value, 1, 100, 100);
  els.hpNum.value = pct;
  els.hpRange.value = pct;
  await bridgeOp('setHpRate', { rate: Math.max(0.01, pct / 100) },
    { okMsg: `HP von ${selectedPlayerName()} auf ${pct} % gesetzt.`, btn: els.hpSet });
}

async function renameApply() {
  const name = els.rnName.value.trim();
  if (!name) return logLine('Umbenennen: Namen eingeben.', 'err');
  const maxPals = clampInt(els.rnMax.value, 1, 5, 1);
  await bridgeOp('renamePartyPals',
    { name, maxPals, reset: false, announceResult: els.rnAnnounce.checked },
    { okMsg: `Bis zu ${maxPals} Party-Pal(s) in „${name}" umbenannt.`, btn: els.rnApply });
}

async function renameReset() {
  const maxPals = clampInt(els.rnMax.value, 1, 5, 5);
  await bridgeOp('renamePartyPals',
    { name: '', maxPals, reset: true, announceResult: els.rnAnnounce.checked },
    { okMsg: 'Pal-Namen zurückgesetzt.', btn: els.rnReset });
}

async function removeItem() {
  const itemId = els.riId.value.trim();
  if (!itemId) return logLine('Item entfernen: Item-ID eingeben.', 'err');
  const count = clampInt(els.riCount.value, 1, 9999, 1);
  const item = state.items.find((i) => i.id === itemId);
  const label = item ? item.name_de : itemId;
  if (!els.playerSelect.value) return logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  if (!window.confirm(`${count}× ${label} bei ${selectedPlayerName()} entfernen?`)) return;
  const result = await bridgeOp('removeItem', { itemId, count },
    { okMsg: `${count}× ${label} entfernt.`, btn: els.riBtn });
  // Anzeige aktuell halten: entferntes Item soll sofort verschwinden
  if (result && !els.invBox.hidden) loadInventory();
}

// Inventar des gewählten Spielers auslesen (listInventory-Op) und als
// klickbare Liste rendern — Klick übernimmt Item-ID + Menge ins Entfernen-Formular.
async function loadInventory() {
  if (!els.playerSelect.value) return logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  els.invBox.hidden = false;
  els.invBox.textContent = 'Inventar wird ausgelesen…';
  const data = await bridgeOp('listInventory', {}, { btn: els.invLoad });
  if (!data) {
    els.invBox.textContent = 'Inventar konnte nicht ausgelesen werden (siehe Log).';
    return;
  }
  const slots = (data.data && Array.isArray(data.data.slots)) ? data.data.slots : [];
  // Gleiche Item-IDs über mehrere Slots aufsummieren
  const agg = new Map();
  for (const s of slots) {
    if (typeof s.itemId !== 'string' || !Number.isFinite(s.count)) continue;
    agg.set(s.itemId, (agg.get(s.itemId) || 0) + s.count);
  }
  if (!agg.size) {
    els.invBox.textContent = 'Inventar ist leer.';
    return;
  }
  const rows = [...agg.entries()].map(([id, count]) => {
    const item = state.items.find((i) => i.id === id);
    return { id, count, item, label: item ? item.name_de : id };
  }).sort((a, b) => a.label.localeCompare(b.label, 'de'));

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'inv-row';
    row.title = `${r.id} – Klick übernimmt Item + Menge ins Entfernen-Formular`;
    if (r.item) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = `icons/${r.item.icon}`;
      img.alt = '';
      row.appendChild(img);
    }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.label;
    const ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = `${r.count}×`;
    row.append(nm, ct);
    row.addEventListener('click', () => {
      els.riId.value = r.id;
      els.riCount.value = r.count;
      logLine(`${r.label} (${r.count}×) ins Entfernen-Formular übernommen.`, 'info');
    });
    frag.appendChild(row);
  }
  els.invBox.replaceChildren(frag);
  logLine(`Inventar von ${selectedPlayerName()}: ${rows.length} verschiedene Items.`, 'ok');
}

async function dropRandomSlot() {
  if (!els.playerSelect.value) return logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  if (!window.confirm(`${selectedPlayerName()} lässt einen zufälligen Inventar-Slot fallen. Sicher?`)) return;
  const result = await bridgeOp('dropRandomSlot', {},
    { okMsg: 'Zufälliger Inventar-Slot fallen gelassen.', btn: els.dropBtn });
  if (result && !els.invBox.hidden) loadInventory();
}

// ---------------------------------------------------------------------------
// Pals-Tab
// ---------------------------------------------------------------------------

async function spawnPal() {
  const palId = els.spPalid.value.trim();
  if (!palId) return logLine('Pal spawnen: Pal-ID eingeben.', 'err');
  const params = {
    palId,
    count: clampInt(els.spCount.value, 1, 10, 1),
    level: clampInt(els.spLevel.value, 1, 65, 1),
  };
  const despawn = clampInt(els.spDespawn.value, 5, 600, null);
  if (despawn !== null) params.despawnAfterSec = despawn;
  els.spBtn.textContent = 'Spawne… (bis 75 s)';
  await bridgeOp('spawnPal', params,
    { okMsg: `${params.count}× ${palId} (Level ${params.level}) gespawnt.`, btn: els.spBtn });
  els.spBtn.textContent = 'Spawnen';
}

async function spawnCaughtPal() {
  const params = {
    count: clampInt(els.scCount.value, 1, 10, 3),
    levelOffset: clampInt(els.scOffset.value, -50, 50, 5),
  };
  els.scBtn.textContent = 'Spawne… (bis 75 s)';
  await bridgeOp('spawnCaughtPal', params,
    { okMsg: `${params.count} gefangene Pal(s) gespawnt (Offset ${params.levelOffset}).`, btn: els.scBtn });
  els.scBtn.textContent = 'Spawnen';
}

async function setGameHour(hour) {
  await bridgeOp('setGameHour', { hour },
    { needPlayer: false, okMsg: `Weltzeit auf ${hour}:00 Uhr gesetzt.`, btn: els.ghSet });
}

async function wildWrath() {
  if (!els.playerSelect.value) return logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  const radiusM = clampInt(els.wwRadius.value, 10, 200, 60);
  const maxPals = clampInt(els.wwMax.value, 1, 15, 8);
  if (!window.confirm(`WildWrath: bis zu ${maxPals} wilde Pals im Umkreis von ${radiusM} m auf ${selectedPlayerName()} hetzen?`)) return;
  await bridgeOp('wildWrath', { radiusM, maxPals },
    { okMsg: `WildWrath auf ${selectedPlayerName()} ausgelöst.`, btn: els.wwBtn });
}

// ---------------------------------------------------------------------------
// Server-Tab (offizielle REST API)
// ---------------------------------------------------------------------------

function fmtUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

async function loadServerInfo() {
  try {
    const d = await apiGet('api/server/info');
    els.srvName.textContent = d.servername || 'Palworld-Server';
    els.srvVersion.textContent = d.version ? `Version ${d.version}` : '';
    els.srvDesc.textContent = d.description || '';
  } catch (err) {
    logLine(`Server-Info: ${err.message}`, 'err');
  }
}

async function loadServerMetrics() {
  try {
    const d = await apiGet('api/server/metrics');
    state.lastMetricsErr = null;
    els.mFps.textContent = d.serverfps != null ? String(d.serverfps) : '–';
    els.mFrametime.textContent = typeof d.serverframetime === 'number' ? d.serverframetime.toFixed(1) : '–';
    els.mPlayers.textContent = d.currentplayernum != null ? `${d.currentplayernum} / ${d.maxplayernum ?? '?'}` : '–';
    els.mUptime.textContent = fmtUptime(d.uptime);
    els.mDays.textContent = d.days != null ? String(d.days) : '–';
    els.mBases.textContent = d.basecampnum != null ? String(d.basecampnum) : '–';
  } catch (err) {
    // Beim 10-s-Polling nicht denselben Fehler wiederholt loggen
    if (state.lastMetricsErr !== err.message) {
      state.lastMetricsErr = err.message;
      logLine(`Server-Metriken: ${err.message}`, 'err');
    }
  }
}

async function loadSettings() {
  if (state.settings) return;
  try {
    state.settings = await apiGet('api/server/settings');
    if (state.features.settingsEdit) {
      try {
        state.iniSettings = await apiGet('api/server/settings-file');
      } catch (err) {
        logLine(`Settings-Datei: ${err.message}`, 'err');
      }
    }
    renderSettings();
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Einstellungen nicht ladbar: ${err.message}`;
    els.settingsBox.replaceChildren(p);
  }
}

// Rohwert aus der ini ("1.000000", True, "\"Name\"") mit dem Live-Wert der
// REST API (1, true, "Name") vergleichbar machen
function iniDisplay(raw) {
  if (raw == null) return null;
  if (/^".*"$/.test(raw)) return raw.slice(1, -1);
  return raw;
}
function sameValue(raw, live) {
  const d = iniDisplay(raw);
  if (d === null || live == null) return true;
  if (/^(true|false)$/i.test(String(live))) return String(live).toLowerCase() === String(d).toLowerCase();
  const nd = Number(d), nl = Number(live);
  if (Number.isFinite(nd) && Number.isFinite(nl) && String(live).trim() !== '' && d.trim() !== '') return nd === nl;
  return String(live) === String(d);
}

// Inline-Editor für einen Settings-Wert (Typ ergibt sich aus dem ini-Rohwert)
function settingEditor(td, key, raw) {
  let input;
  if (/^(True|False)$/i.test(raw)) {
    input = document.createElement('select');
    for (const v of ['True', 'False']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      input.appendChild(o);
    }
    input.value = /^true$/i.test(raw) ? 'True' : 'False';
  } else {
    input = document.createElement('input');
    input.type = /^-?[0-9.]+$/.test(raw) ? 'number' : 'text';
    if (input.type === 'number') input.step = 'any';
    input.value = iniDisplay(raw);
  }
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '✓';
  save.title = 'Speichern';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = '✕';
  cancel.title = 'Abbrechen';
  cancel.addEventListener('click', () => renderSettings());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const resp = await apiPost('api/server/settings-file', { key, value: input.value });
      state.iniSettings.settings[key] = resp.value;
      logLine(`${key} = ${iniDisplay(resp.value)} gespeichert — wirksam nach Server-Neustart.`, 'ok');
    } catch (err) {
      logLine(`${key}: ${err.message}`, 'err');
    }
    renderSettings();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save.click();
    if (e.key === 'Escape') cancel.click();
  });
  const wrap = document.createElement('span');
  wrap.className = 'set-edit';
  wrap.append(input, save, cancel);
  td.replaceChildren(wrap);
  input.focus();
}

function renderSettings() {
  if (!state.settings) return;
  const q = els.setSearch.value.trim().toLowerCase();
  const entries = Object.entries(state.settings)
    .filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
  const table = document.createElement('table');
  table.className = 'data';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of ['Einstellung', 'Wert']) {
    const th = document.createElement('th');
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const ini = state.iniSettings || { settings: {}, locked: [] };
  const locked = new Set(ini.locked || []);
  const tbody = document.createElement('tbody');
  for (const [k, v] of entries) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.textContent = k;
    const tdV = document.createElement('td');
    const raw = ini.settings[k];
    const val = document.createElement('span');
    val.textContent = String(v);
    tdV.appendChild(val);
    // Bei 🔒-Keys keinen „nach Neustart"-Hinweis: dort gewinnt beim Start die
    // Container-Konfiguration, nicht der ini-Wert
    if (raw !== undefined && !locked.has(k) && !sameValue(raw, v)) {
      const pending = document.createElement('span');
      pending.className = 'set-pending';
      pending.textContent = ` → nach Neustart: ${iniDisplay(raw)}`;
      pending.title = 'In der PalWorldSettings.ini geändert — wird beim nächsten Server-Neustart wirksam';
      tdV.appendChild(pending);
    }
    if (state.features.settingsEdit && raw !== undefined) {
      if (locked.has(k)) {
        const lock = document.createElement('span');
        lock.className = 'set-lock';
        lock.textContent = ' 🔒';
        lock.title = 'Wird beim Serverstart aus der Container-Konfiguration gesetzt — dort ändern';
        tdV.appendChild(lock);
      } else {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'set-edit-btn';
        edit.textContent = '✎';
        edit.title = `${k} bearbeiten (wirksam nach Server-Neustart)`;
        edit.addEventListener('click', () => settingEditor(tdV, k, ini.settings[k]));
        tdV.appendChild(edit);
      }
    }
    tr.append(tdK, tdV);
    tbody.appendChild(tr);
  }
  if (!entries.length) {
    const tr = document.createElement('tr');
    const tdE = document.createElement('td');
    tdE.colSpan = 2;
    tdE.className = 'muted';
    tdE.textContent = 'Keine Treffer.';
    tr.appendChild(tdE);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  els.settingsBox.replaceChildren(table);
}

function startServerPolling() {
  if (!state.features.serverAdmin) return;
  loadServerInfo();
  loadSettings();
  loadServerMetrics();
  state.serverTimer = setInterval(loadServerMetrics, 10000);
}

function stopServerPolling() {
  if (state.serverTimer) {
    clearInterval(state.serverTimer);
    state.serverTimer = null;
  }
}

async function srvAnnounce() {
  const message = els.annMsg.value.trim();
  if (!message) return logLine('Ankündigung: Nachricht eingeben.', 'err');
  els.annBtn.disabled = true;
  try {
    await apiPost('api/server/announce', { message });
    logLine('Ankündigung gesendet.', 'ok');
    els.annMsg.value = '';
  } catch (err) {
    logLine(`Ankündigung: ${err.message}`, 'err');
  }
  els.annBtn.disabled = false;
}

async function srvSave() {
  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Speichere…';
  try {
    await apiPost('api/server/save');
    logLine('Welt gespeichert.', 'ok');
  } catch (err) {
    logLine(`Speichern: ${err.message}`, 'err');
  }
  els.saveBtn.disabled = false;
  els.saveBtn.textContent = 'Welt speichern';
}

async function srvShutdown() {
  const waittime = clampInt(els.sdWait.value, 1, 3600, 60);
  els.sdWait.value = waittime;
  const message = els.sdMsg.value.trim();
  if (!window.confirm(`Server in ${waittime} s herunterfahren (mit Speichern)?`)) return;
  els.sdBtn.disabled = true;
  try {
    await apiPost('api/server/shutdown', { waittime, ...(message ? { message } : {}) });
    logLine(`Shutdown in ${waittime} s eingeleitet.`, 'ok');
  } catch (err) {
    logLine(`Shutdown: ${err.message}`, 'err');
  }
  els.sdBtn.disabled = false;
}

async function srvStop() {
  if (!window.confirm('Server sofort stoppen?')) return;
  if (!window.confirm('Wirklich? Der Server stoppt SOFORT und speichert NICHT!')) return;
  els.stopBtn.disabled = true;
  try {
    await apiPost('api/server/stop');
    logLine('Force-Stop gesendet.', 'ok');
  } catch (err) {
    logLine(`Force-Stop: ${err.message}`, 'err');
  }
  els.stopBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Logs-Tab: Bridge-Admin + RCON
// ---------------------------------------------------------------------------

function fmtTs(ts) {
  if (ts == null) return '';
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString('de-DE');
}

function kvRow(frag, key, value, cls) {
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = cls ? `v ${cls}` : 'v';
  v.textContent = value;
  frag.append(k, v);
}

async function refreshBridgeStatus() {
  try {
    const d = await apiGet('api/bridge/status');
    state.lastBridgeErr = null;
    const frag = document.createDocumentFragment();
    kvRow(frag, 'Mod', d.alive ? 'online' : 'offline', d.alive ? 'ok' : 'err');
    kvRow(frag, 'Version', d.modVersion || '–');
    kvRow(frag, 'Armed', d.armed ? 'ja' : 'nein', d.armed ? 'ok' : undefined);
    kvRow(frag, 'Queue', d.queue != null ? String(d.queue) : '–');
    kvRow(frag, 'Spielerliste', d.playersStale ? 'veraltet' : 'aktuell', d.playersStale ? 'err' : 'ok');
    if (d.presence) kvRow(frag, 'Presence', String(d.presence));
    const errors = Array.isArray(d.recentErrors) ? d.recentErrors : [];
    kvRow(frag, 'Fehler', errors.length ? `${errors.length} zuletzt` : 'keine', errors.length ? 'err' : 'ok');
    for (const e of errors.slice(-5)) {
      kvRow(frag, fmtTs(e.ts), e.message || JSON.stringify(e), 'err');
    }
    els.bridgeStatus.replaceChildren(frag);
    els.pauseToggle.checked = d.paused === true;
  } catch (err) {
    if (state.lastBridgeErr !== err.message) {
      state.lastBridgeErr = err.message;
      logLine(`Bridge-Status: ${err.message}`, 'err');
    }
  }
}

async function refreshBridgeLogs() {
  try {
    const data = await apiGet('api/bridge/logs');
    const entries = Array.isArray(data) ? data : (Array.isArray(data.logs) ? data.logs : []);
    const frag = document.createDocumentFragment();
    for (const e of entries.slice(-200)) {
      const div = document.createElement('div');
      if (typeof e === 'string') {
        div.textContent = e;
      } else if (e && typeof e === 'object') {
        const level = e.level != null ? String(e.level) : '';
        const raw = e.msg ?? e.message ?? '';
        const msg = typeof raw === 'string' && raw ? raw : JSON.stringify(e);
        div.textContent = `${fmtTs(e.ts)} ${level ? `[${level}] ` : ''}${msg}`.trim();
        if (/err/i.test(level)) div.className = 'err';
      } else {
        div.textContent = String(e);
      }
      frag.appendChild(div);
    }
    const box = els.bridgeLogs;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.replaceChildren(frag);
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch {
    // Fehler bereits über refreshBridgeStatus sichtbar
  }
}

function logsTick() {
  refreshBridgeStatus();
  refreshBridgeLogs();
}

function startLogsPolling() {
  logsTick();
  state.logsTimer = setInterval(logsTick, 5000);
}

function stopLogsPolling() {
  if (state.logsTimer) {
    clearInterval(state.logsTimer);
    state.logsTimer = null;
  }
}

async function togglePause() {
  const paused = els.pauseToggle.checked;
  els.pauseToggle.disabled = true;
  try {
    await apiPost('api/bridge/pause', { paused });
    logLine(paused ? 'Twitch-Trolls pausiert.' : 'Twitch-Trolls fortgesetzt.', 'ok');
  } catch (err) {
    els.pauseToggle.checked = !paused;
    logLine(`Pause: ${err.message}`, 'err');
  }
  els.pauseToggle.disabled = false;
}

// --- RCON-Konsole ---

function rconPrint(text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  els.rconOut.appendChild(div);
  while (els.rconOut.children.length > 400) els.rconOut.firstChild.remove();
  els.rconOut.scrollTop = els.rconOut.scrollHeight;
}

async function rconSubmit() {
  const command = els.rconIn.value.trim();
  if (!command) return;
  state.rconHistory.push(command);
  state.rconHistIdx = state.rconHistory.length;
  els.rconIn.value = '';
  rconPrint(`> ${command}`, 'cmd');
  els.rconSend.disabled = true;
  try {
    const d = await apiPost('api/rcon', { command });
    rconPrint(d.response || '(keine Antwort)');
  } catch (err) {
    rconPrint(`Fehler: ${err.message}`, 'err');
  }
  els.rconSend.disabled = false;
  els.rconIn.focus();
}

function rconKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    rconSubmit();
  } else if (e.key === 'ArrowUp') {
    if (!state.rconHistory.length) return;
    e.preventDefault();
    state.rconHistIdx = Math.max(0, state.rconHistIdx - 1);
    els.rconIn.value = state.rconHistory[state.rconHistIdx] || '';
  } else if (e.key === 'ArrowDown') {
    if (!state.rconHistory.length) return;
    e.preventDefault();
    state.rconHistIdx = Math.min(state.rconHistory.length, state.rconHistIdx + 1);
    els.rconIn.value = state.rconHistory[state.rconHistIdx] || '';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Tabs
els.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setTab(btn.dataset.tab);
});

// Items-Tab
let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 120);
});
els.category.addEventListener('change', render);
els.sort.addEventListener('change', render);
els.showUnnamed.addEventListener('change', render);
els.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.item');
  if (card) toggleCart(card.dataset.id);
});
els.clearCart.addEventListener('click', () => {
  state.cart.clear();
  renderCart();
  render();
});
els.refreshPlayers.addEventListener('click', loadPlayers);
// Header- und Cart-Auswahl synchron halten; Wechsel invalidiert die Inventaranzeige
function onPlayerChange(source) {
  const other = source === els.playerSelect ? els.cartPlayer : els.playerSelect;
  if ([...other.options].some((o) => o.value === source.value)) other.value = source.value;
  updateSpawnButton();
  renderTpPlayers();
  els.invBox.hidden = true;
  els.invBox.replaceChildren();
}
els.playerSelect.addEventListener('change', () => onPlayerChange(els.playerSelect));
els.cartPlayer.addEventListener('change', () => onPlayerChange(els.cartPlayer));
els.spawn.addEventListener('click', spawn);

// Teleport
els.tpGetpos.addEventListener('click', tpGetPos);
els.tpGo.addEventListener('click', tpGo);
els.tpToplayer.addEventListener('click', tpToPlayer);
els.tpSave.addEventListener('click', tpSaveSpot);
els.tpDel.addEventListener('click', tpDeleteSpot);
els.tpSpots.addEventListener('change', tpSelectSpot);

// Spieler-Tab
els.unbanSelect.addEventListener('change', () => {
  if (els.unbanSelect.value) els.unbanId.value = els.unbanSelect.value;
});
els.unbanRefresh.addEventListener('click', loadBanlist);
els.unbanBtn.addEventListener('click', unban);
els.hpRange.addEventListener('input', () => { els.hpNum.value = els.hpRange.value; });
els.hpNum.addEventListener('change', () => {
  const pct = clampInt(els.hpNum.value, 1, 100, 100);
  els.hpNum.value = pct;
  els.hpRange.value = pct;
});
els.hpSet.addEventListener('click', hpApply);
els.rnApply.addEventListener('click', renameApply);
els.rnReset.addEventListener('click', renameReset);
els.riBtn.addEventListener('click', removeItem);
els.invLoad.addEventListener('click', loadInventory);
els.dropBtn.addEventListener('click', dropRandomSlot);

// Pals-Tab
els.spBtn.addEventListener('click', spawnPal);
els.scBtn.addEventListener('click', spawnCaughtPal);
els.ghSet.addEventListener('click', () => setGameHour(clampInt(els.ghHour.value, 0, 23, 9)));
els.ghDay.addEventListener('click', () => setGameHour(9));
els.ghNight.addEventListener('click', () => setGameHour(22));
els.wwBtn.addEventListener('click', wildWrath);

// Server-Tab
els.annBtn.addEventListener('click', srvAnnounce);
els.annMsg.addEventListener('keydown', (e) => { if (e.key === 'Enter') srvAnnounce(); });
els.saveBtn.addEventListener('click', srvSave);
els.sdBtn.addEventListener('click', srvShutdown);
els.stopBtn.addEventListener('click', srvStop);
let settingsTimer;
els.setSearch.addEventListener('input', () => {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(renderSettings, 120);
});

// Logs-Tab
els.pauseToggle.addEventListener('change', togglePause);
els.rconIn.addEventListener('keydown', rconKeydown);
els.rconSend.addEventListener('click', rconSubmit);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Stunden-Auswahl 0-23 für die Weltzeit
for (let h = 0; h < 24; h++) {
  const opt = document.createElement('option');
  opt.value = String(h);
  opt.textContent = `${h}:00 Uhr`;
  els.ghHour.appendChild(opt);
}
els.ghHour.value = '9';

loadItems();
renderSpots();
loadConfig().then(loadPlayers);
setInterval(loadPlayers, 60000);

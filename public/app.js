'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  items: [],
  cart: new Map(), // id -> amount
  players: [],
};

const els = {
  grid: $('#grid'),
  search: $('#search'),
  category: $('#category'),
  sort: $('#sort'),
  showUnnamed: $('#show-unnamed'),
  count: $('#result-count'),
  playerSelect: $('#player-select'),
  refreshPlayers: $('#refresh-players'),
  serverStatus: $('#server-status'),
  cartItems: $('#cart-items'),
  clearCart: $('#clear-cart'),
  spawn: $('#spawn'),
  log: $('#log'),
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

async function loadPlayers() {
  els.serverStatus.textContent = '…';
  els.serverStatus.className = 'status';
  try {
    const resp = await fetch('api/players');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    state.players = data.players;
    const prev = els.playerSelect.value;
    els.playerSelect.replaceChildren();
    if (!state.players.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '– keine Spieler online –';
      els.playerSelect.appendChild(opt);
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '– Spieler wählen –';
      els.playerSelect.appendChild(placeholder);
      for (const p of state.players) {
        const opt = document.createElement('option');
        opt.value = p.userId;
        opt.textContent = p.level != null ? `${p.name} (Level ${p.level})` : p.name;
        els.playerSelect.appendChild(opt);
      }
      if ([...els.playerSelect.options].some((o) => o.value === prev)) {
        els.playerSelect.value = prev;
      }
    }
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
    els.playerSelect.replaceChildren();
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '– Server nicht erreichbar –';
    els.playerSelect.appendChild(opt);
    els.serverStatus.textContent = err.message;
    els.serverStatus.className = 'status err';
  }
  updateSpawnButton();
  renderTpPlayers();
}

// ---------------------------------------------------------------------------
// Spawnen
// ---------------------------------------------------------------------------

function logLine(text, cls = 'info') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  els.log.prepend(div);
  while (els.log.children.length > 60) els.log.lastChild.remove();
}

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
    opt.textContent = p.name;
    els.tpPlayer.appendChild(opt);
  }
  if ([...els.tpPlayer.options].some((o) => o.value === prev)) els.tpPlayer.value = prev;
}

function requirePlayer() {
  const userId = els.playerSelect.value;
  if (!userId) logLine('Bitte zuerst oben einen Spieler auswählen.', 'err');
  return userId;
}

async function tpApi(path, body, okMsg) {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
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
// Events
// ---------------------------------------------------------------------------

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
els.playerSelect.addEventListener('change', () => { updateSpawnButton(); renderTpPlayers(); });
els.spawn.addEventListener('click', spawn);
els.tpGetpos.addEventListener('click', tpGetPos);
els.tpGo.addEventListener('click', tpGo);
els.tpToplayer.addEventListener('click', tpToPlayer);
els.tpSave.addEventListener('click', tpSaveSpot);
els.tpDel.addEventListener('click', tpDeleteSpot);
els.tpSpots.addEventListener('change', tpSelectSpot);

loadItems();
loadPlayers();
renderSpots();
setInterval(loadPlayers, 60000);

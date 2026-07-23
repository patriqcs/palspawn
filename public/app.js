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
};

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
  const resp = await fetch('items.json');
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
  return list;
}

function render() {
  const list = filteredItems();
  els.count.textContent = `${list.length} Items`;
  const frag = document.createDocumentFragment();
  for (const item of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item' + (state.cart.has(item.id) ? ' selected' : '');
    btn.dataset.id = item.id;
    btn.title = `${item.name} (${item.id})`;

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
    row.className = 'cart-row';

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
        opt.textContent = `${p.name} (Level ${p.level})`;
        els.playerSelect.appendChild(opt);
      }
      if ([...els.playerSelect.options].some((o) => o.value === prev)) {
        els.playerSelect.value = prev;
      }
    }
    els.serverStatus.textContent = `${state.players.length} online`;
    els.serverStatus.className = 'status ok';
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
els.playerSelect.addEventListener('change', updateSpawnButton);
els.spawn.addEventListener('click', spawn);

loadItems();
loadPlayers();
setInterval(loadPlayers, 60000);

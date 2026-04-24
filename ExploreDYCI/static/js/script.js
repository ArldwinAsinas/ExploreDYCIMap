/* ════════════════════════════════════════════════════════════
   STATE MACHINE
   Single source of truth. Never mutate _state directly.
   All rendering derives from state via renderFromState().
════════════════════════════════════════════════════════════ */
const MODES = { SEARCH: 'search', DETAIL: 'detail', DIRECTIONS: 'directions' };

let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]'); // array of room names
if (!Array.isArray(recentSearches)) recentSearches = [];
recentSearches = recentSearches
  .map(item => typeof item === 'string' ? item : item?.name || '')
  .filter(Boolean)
  .slice(0, 5);

let _state = {
  mode: MODES.SEARCH,
  query: '',
  suggestions: [],
  selectedRoom: null,
  // directions
  origin: null,       // { name, latlng, room? }
  destination: null,  // { name, latlng, room? }
  originQuery: '',
  destQuery: '',
  originSuggestions: [],
  destSuggestions: [],
  route: null,        // array of LatLng | false (no path) | null (not searched)
  // category filter
  activeCategory: ['all'],
  // map: which overlays are rendered
  shownRoomId: null,
};

function getState()      { return _state; }
function setState(patch) {
  _state = Object.assign({}, _state, patch);
  renderFromState(_state);
}

/* ════════════════════════════════════════════════════════════
   DATA LAYER
════════════════════════════════════════════════════════════ */
let _rooms = [];

const BUILDING_NAMES = {
  '0': '',
  'a': 'Building A',
  'b': 'Building B',
  'c': 'Building C',
  'd': 'Building D',
  'e': 'Aula Magna'
};

const ROOM_TYPE = {
  'office': 'Office',
  'classroom': 'Classroom',
  'cr': 'Comfort Room',
  'utility': 'Utility',
  'facility': 'Facility',
  'lab': 'Lab',
  'canteen': 'Canteen',
  'others': 'Others',
  'na': 'Not Applicable'
}

const FLOOR_NAMES = {
  '1': 'First Floor',
  '2': 'Second Floor',
};

function parseCSV(text) {
  const lines = text.trim().split('\n');
  _rooms = lines.slice(1).map((line, i) => {
    const match = line.match(/(".*?"|[^",]+)(?=,|$)/g);
    if (!match) return null;
    const coords = parseCoordString(match[1].replace(/^"|"$/g, ''));
    const center = centroid(coords);
    return {
      id: 'room_' + i,
      name:     match[0].replace(/^"|"$/g, '').trim(),
      nameLower:match[0].replace(/^"|"$/g, '').trim().toLowerCase(),
      coords,
      center,           // [x, y] in CRS.Simple space
      type:     match[2].trim(),
      building: match[3].trim(),
      floor:    match[4].trim(),
      description: (match[5] && match[5].trim() !== '0')
  ? match[5].replace(/^"|"$/g, '').replace(/\r?\n/g, ' ').trim()
  : ''
    };
  }).filter(Boolean);
  return _rooms;
}

function parseCoordString(raw) {
  // "x1,y1;x2,y2;..." or "x1 y1;x2 y2;..."
  return raw.split(';').map(pair => {
    const parts = pair.trim().split(/[,\s]+/);
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    return [x, y];
  });
}

function centroid(coords) {
  const s = coords.reduce((a,c) => [a[0]+c[0], a[1]+c[1]], [0,0]);
  return [s[0]/coords.length, s[1]/coords.length];
}

function searchRooms(query, limit = 8) {
  if (!query) return [];
  const q = query.toLowerCase().trim();
  return _rooms.filter(r =>
    r.nameLower.includes(q) ||
    r.type?.toLowerCase().includes(q) ||
    r.building?.toLowerCase().includes(q)
  ).slice(0, limit);
}

function getRoomByName(name) {
  const n = name.toLowerCase().trim();
  return _rooms.find(r => r.nameLower === n) ||
         _rooms.find(r => r.nameLower.includes(n)) || null;
}

/* ════════════════════════════════════════════════════════════
   MAP LAYER
════════════════════════════════════════════════════════════ */
const MAP_BOUNDS  = [[0,0],[1080,1920]];
const MAP_IMAGE   = 'static/images/elida-map.svg';

const _map = L.map('map', {
  crs: L.CRS.Simple,
  zoomControl: false,
  zoomAnimation: true,
  fadeAnimation: true,
});
L.control.zoom({ position: 'bottomright' }).addTo(_map);
L.imageOverlay(MAP_IMAGE, MAP_BOUNDS).addTo(_map);
_map.fitBounds(MAP_BOUNDS);
_map.setMaxBounds(MAP_BOUNDS);
_map.setMaxZoom(5);
_map.options.zoomSnap = 0.25;

const _layerPolygons = L.layerGroup().addTo(_map);
const _layerMarkers  = L.layerGroup().addTo(_map);
const _layerRoute    = L.layerGroup().addTo(_map);

function mapClearAll() {
  _layerPolygons.clearLayers();
  _layerMarkers.clearLayers();
  _layerRoute.clearLayers();
}

function mapShowRoom(room, zoomIn = true) {
  mapClearAll();
  // polygon
  const latlngs = room.coords.map(([x,y]) => [x, y]);
  const poly = L.polygon(latlngs, {
    color: '#4285F4', weight: 2.5,
    fillColor: '#4285F4', fillOpacity: 0.18,
  }).addTo(_layerPolygons);
  // marker
  const center = L.latLng(room.center[0], room.center[1]);
  L.marker(center, { icon: makePin('room') }).addTo(_layerMarkers);
  if (zoomIn) {
    _map.flyToBounds(poly.getBounds(), { padding: [80,80], maxZoom: 3, duration: 0.5 });
  }
}

function mapShowRoute(originLL, destLL, routePoints) {
  mapClearAll();
  // markers
  L.marker([originLL.lat, originLL.lng], { icon: makePin('start') }).addTo(_layerMarkers);
  L.marker([destLL.lat,   destLL.lng],   { icon: makePin('end')   }).addTo(_layerMarkers);
  // route line
  if (routePoints && routePoints.length >= 2) {
    const line = L.polyline(routePoints, {
      color: '#4285F4', weight: 4.5, opacity: 0.9,
      dashArray: '12 6', lineCap: 'round', lineJoin: 'round',
    }).addTo(_layerRoute);
    // Animate dash
    const pathEl = line.getElement();
    if (pathEl) pathEl.style.animation = 'dashMove 0.7s linear infinite';

    // Arrow decorators
    if (window.L && L.polylineDecorator) {
      L.polylineDecorator(line, {
        patterns: [{
          offset: '10%', repeat: '22%',
          symbol: L.Symbol.arrowHead({
            pixelSize: 9, polygon: false,
            pathOptions: { color: '#4285F4', weight: 2.5, opacity: 0.85 }
          })
        }]
      }).addTo(_layerRoute);
    }
    _map.flyToBounds(line.getBounds(), { padding: [90,90], duration: 0.6 });
  } else {
    _map.flyToBounds(L.latLngBounds([[originLL.lat, originLL.lng],[destLL.lat, destLL.lng]]), { padding: [100,100] });
  }
}

function makePin(type) {
  const colors = { start:'#22c55e', end:'#ef4444', room:'#4285F4' };
  const labels = { start:'A', end:'B', room:'●' };
  const c = colors[type]; const l = labels[type];
  return L.divIcon({
    className: '',
    html: `<div class="nav-pin" style="background:${c}"><span>${l}</span></div>`,
    iconSize: [30,30], iconAnchor: [15,30],
  });
}

/* Map click — only acts in DIRECTIONS mode when no origin yet */
_map.on('click', e => {
  const st = getState();
  //if (st.mode !== MODES.DIRECTIONS) return;
  //if (st.origin) return; // already set
  const ll = e.latlng;
   console.log("X:", e.latlng.lat, "Y:", e.latlng.lng);
  setState({
    origin: { name: `Point (${Math.round(ll.lat)}, ${Math.round(ll.lng)})`, latlng: ll, room: null },
    originQuery: `Point (${Math.round(ll.lat)}, ${Math.round(ll.lng)})`,
  });
});

/* ════════════════════════════════════════════════════════════
   PATHFINDER
   Replace nodes/edges with your real graph data.
════════════════════════════════════════════════════════════ */
function nearestNode(x, y) {
  let best = null, bestD = Infinity;

  nodes.forEach(n => {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  });

  return best;
}

function bfsPath(startNode, endNode) {
  if (startNode.id === endNode.id) return [startNode];

  const visited = new Set([startNode.id]);
  const queue = [[startNode]];

  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];

    for (const nid of (edges[cur.id] || [])) {
      if (!nid) continue;

      if (nid === endNode.id) {
        const n = nodes.find(n => n.id === nid);
        if (!n) continue;
        const fullPath = [...path, n];
        console.log("Path found:", fullPath.map(n => n.id).join(' → '));
        return fullPath;
      }

      if (!visited.has(nid)) {
        visited.add(nid);
        const n = nodes.find(n => n.id === nid);
        if (!n) {
          console.warn("Missing node:", nid, "referenced from", cur.id);
          continue;
        }
        queue.push([...path, n]);
      }
    }
  }

  console.warn("No path found between", startNode.id, "and", endNode.id);
  return null;
}

function calcRoute(origin, destination) {
  const ox = origin.latlng ? origin.latlng.lat : origin.room?.center[0];
  const oy = origin.latlng ? origin.latlng.lng : origin.room?.center[1];
  const dx = destination.room?.center[0];
  const dy = destination.room?.center[1];
  if (ox == null || dx == null) return false;

  const sn = nearestNode(ox, oy);
  const en = nearestNode(dx, dy);
  if (!sn || !en) return false;

  const path = bfsPath(sn, en);
  if (!path) return false;

    console.log("ORIGIN:", origin);
console.log("DEST:", destination);

  // Build LatLng array: origin → path nodes → destination (all in [X, Y] order)
  return [
    [ox, oy],
    ...path.map(n => [n.x, n.y]),
    [dx, dy],
  ];

}

/* ════════════════════════════════════════════════════════════
   RENDERER  (state → DOM + map)
   This is the ONLY place that touches DOM based on state.
════════════════════════════════════════════════════════════ */
function renderFromState(st) {
  /* ── Panels visibility ── */
  const searchPanel     = document.getElementById('search-panel');
  const directionsPanel = document.getElementById('directions-panel');
  const sidebar         = document.getElementById('sidebar');

  searchPanel.classList.toggle('hidden',     st.mode === MODES.DIRECTIONS || st.mode === MODES.DETAIL);
  directionsPanel.classList.toggle('hidden', st.mode !== MODES.DIRECTIONS);
  sidebar.classList.toggle('open',           st.mode === MODES.DETAIL);

  /* ── Search mode ── */
if (st.mode === MODES.SEARCH) {
  document.getElementById('search-input').value = st.query;

  renderSuggestionList(
    document.getElementById('search-suggestions'),
    st.suggestions,
    st.query,
    room => handleRoomSelected(room)
  );

  document.getElementById('search-clear')
    .classList.toggle('visible', st.query.length > 0);

  // ✅ SHOW CATEGORY ROOMS INSTEAD OF CLEARING
  mapShowRoomsByCategory(st.activeCategory);
}

  /* ── Detail mode ── */
  if (st.mode === MODES.DETAIL && st.selectedRoom) {
    const r = st.selectedRoom;
    document.getElementById('sidebar-name').textContent = r.name;
    const chips = document.getElementById('sidebar-chips');
    chips.innerHTML = '';
    if (r.description) {
      const desc = document.createElement('p');
      desc.style.marginTop = '10px';
      desc.style.fontSize = '13px';
      desc.style.color = '#444';
      desc.textContent = r.description;
      chips.appendChild(desc);
    }
[
  ['🏢', (r.building !== '0') ? (BUILDING_NAMES[r.building] || r.building) : null],
  ['📋', (r.type !== '0') ? (ROOM_TYPE[r.type] || r.type) : null],
  ['🏠', (r.floor !== '0') ? 'Floor ' + r.floor : null]
]
.filter(([,v]) => v && v !== 'undefined')
      .forEach(([icon, val]) => {
        const span = document.createElement('span');
        span.className = 'detail-chip';
        span.textContent = `${icon} ${val}`;
        chips.appendChild(span);
      });
    mapShowRoom(r);
  }

  /* ── Directions mode ── */
  if (st.mode === MODES.DIRECTIONS) {
    document.getElementById('origin-input').value = st.originQuery;
    document.getElementById('dest-input').value   = st.destQuery;

    renderSuggestionList(
      document.getElementById('origin-suggestions'),
      st.originSuggestions,
      st.originQuery,
      room => handleOriginSelected(room)
    );
    renderSuggestionList(
      document.getElementById('dest-suggestions'),
      st.destSuggestions,
      st.destQuery,
      room => handleDestSelected(room)
    );

    // click hint: show when no origin set
    const hint = document.getElementById('click-hint');
    hint.classList.toggle('hidden', !!st.origin);

    // route status
    const statusEl = document.getElementById('route-status');
    if (st.route === null) {
      statusEl.textContent = '';
      statusEl.className = 'route-status';
    } else if (st.route === false) {
      statusEl.textContent = '⚠ No route found between these locations.';
      statusEl.className = 'route-status error';
    } else {
      statusEl.textContent = `✓ Route found`;
      statusEl.className = 'route-status success';
    }

    // map
    if (st.route && st.route !== false && st.origin && st.destination) {
      const oLL = st.origin.latlng  || L.latLng(st.origin.room.center[0],  st.origin.room.center[1]);
      const dLL = st.destination.latlng || L.latLng(st.destination.room.center[0], st.destination.room.center[1]);
      mapShowRoute(oLL, dLL, st.route);
    } else if (!st.route && st.destination) {
      // show destination room only
      mapShowRoom(st.destination.room, false);
    }
  }

  const categoryBar = document.getElementById('category-bar');

// Hide kapag naka-detail (sidebar open)
categoryBar.classList.toggle('hidden', st.mode === MODES.DETAIL);
  /* ── Category bar position ── */
  // When sidebar is open, the category bar would overlap — handled by CSS fixed left
}

function renderSuggestionList(container, rooms, query, onSelect) {
  if (!rooms || rooms.length === 0) {
  container.innerHTML = '';
  container.classList.add('hidden');
  return;
}

container.classList.remove('hidden'); // ensure visible

  if (!query && rooms.length) {
  const header = document.createElement('div');
  header.style.padding = '8px 14px';
  header.style.fontSize = '11px';
  header.style.color = '#888';
  header.textContent = 'Recent Searches';
  container.appendChild(header);
}
  container.classList.remove('hidden');
  container.innerHTML = '';
  rooms.forEach((room, i) => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.dataset.index = i;
    const icon = iconForType(room.type);
    const highlighted = highlightMatch(room.name, query);
    const metaParts = [
  (room.type !== '0') ? (ROOM_TYPE[room.type] || room.type) : null,
  (room.building !== '0') ? (BUILDING_NAMES[room.building] || room.building) : null,
  (room.floor !== '0') ? ('Floor ' + room.floor) : null
];

const meta = metaParts.filter(v => v && v !== 'undefined').join(' · ');
    item.innerHTML = `
      <span class="sugg-icon">${icon}</span>
      <span class="sugg-text">
        <span class="sugg-name">${highlighted}</span>
        <span class="sugg-meta">${meta}</span>
      </span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); onSelect(room); container.classList.add('hidden');});
    container.appendChild(item);
  });
}

function highlightMatch(text, query) {
  if (!query) return text;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<b>$1</b>');
}

function iconForType(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('office'))    return '🏢';
  if (t.includes('class') || t.includes('room')) return '🚪';
  if (t.includes('cr') || t.includes('rest'))    return '🚻';
  if (t.includes('lab'))       return '🔬';
  if (t.includes('canteen') || t.includes('food')) return '🍴';
  if (t.includes('facility'))  return '🏛️';
  return '📍';
}

/* ════════════════════════════════════════════════════════════
   CONTROLLER  (event → setState)
   Pure logic — figures out what the new state should be.
════════════════════════════════════════════════════════════ */

/* Search mode */

function saveRecent(room) {
  const name = typeof room === 'string' ? room : room?.name;
  if (!name) {
    console.warn("Invalid room for recent search:", room);
    return;
  }

  recentSearches = recentSearches.filter(r => r !== name);
  recentSearches.unshift(name);
  recentSearches = recentSearches.slice(0, 5);

  localStorage.setItem('recentSearches', JSON.stringify(recentSearches));

  console.log("SAVED:", recentSearches);
}

function handleSearchInput(value) {
  if (!value) {
    setState({
      query: '',
      suggestions: recentSearches
        .map(name => getRoomByName(name))
        .filter(Boolean),
    });
    return;
  }

  setState({
    query: value,
    suggestions: searchRooms(value)
  });
}
function handleSearchClear() {
  setState({ query: '', suggestions: [], mode: MODES.SEARCH, selectedRoom: null });
  document.getElementById('search-input').focus();
}
function handleRoomSelected(room) {
  saveRecent(room);
  setState({
    mode: MODES.DETAIL,
    selectedRoom: room,
    query: room.name,
    suggestions: [],
  });
  document.getElementById('search-panel').classList.add('hidden');
}

/* Sidebar */
function handleSidebarClose() {
  setState({ mode: MODES.SEARCH, selectedRoom: null, query: '' });
  document.getElementById('search-panel').classList.remove('hidden');
}
function handleDirectionsRequested() {
  const st = getState();
  const room = st.selectedRoom;
  if (!room) return;
  setState({
    mode: MODES.DIRECTIONS,
    destination: { name: room.name, latlng: null, room },
    destQuery: room.name,
    origin: null,
    originQuery: '',
    route: null,
  });
  // focus origin input after transition
  setTimeout(() => document.getElementById('origin-input').focus(), 100);
}

/* Directions — origin */
function handleOriginInput(value) {
  setState({ originQuery: value, originSuggestions: searchRooms(value) });
}
function handleOriginSelected(room) {
  setState({
    origin: { name: room.name, latlng: null, room },
    originQuery: room.name,
    originSuggestions: [],
    route: null,
  });
  document.getElementById('origin-input').blur();
}

/* Directions — destination */
function handleDestInput(value) {
  setState({ destQuery: value, destSuggestions: searchRooms(value) });
}
function handleDestSelected(room) {
  setState({
    destination: { name: room.name, latlng: null, room },
    destQuery: room.name,
    destSuggestions: [],
    route: null,
  });
}

/* Swap */
function handleSwap() {
  const st = getState();
  const btn = document.getElementById('btn-swap');
  btn.classList.add('spinning');
  setTimeout(() => btn.classList.remove('spinning'), 220);
  setState({
    origin: st.destination,
    destination: st.origin,
    originQuery: st.destQuery,
    destQuery: st.originQuery,
    route: null,
  });
}

/* Route search */
function handleRouteSearch() {
  const st = getState();
  console.log("ORIGIN:", st.origin);
console.log("DEST:", st.destination);
  if (!st.origin || !st.destination) {
    if (!st.origin) {
      document.getElementById('route-status').textContent = 'Set a starting point first.';
      document.getElementById('route-status').className = 'route-status error';
    }
    return;
  }
  const route = calcRoute(st.origin, st.destination);
  setState({ route: route || false });
}

/* Back */
function handleBack() {
  const st = getState();
  // Go back to detail view of destination room if we have one
  if (st.destination?.room) {
    setState({
      mode: MODES.DETAIL,
      selectedRoom: st.destination.room,
      query: st.destination.room.name,
    });
  } else {
    setState({ mode: MODES.SEARCH, query: '' });
  }
}

/* Category filter */
function handleCategoryFilter(type) {
  setState({ activeCategory: type });
  // In your full implementation you'd show/hide markers here
  // For now we just track the state
}

/* ════════════════════════════════════════════════════════════
   EVENT WIRING  (register all DOM listeners once)
════════════════════════════════════════════════════════════ */
function wireEvents() {
  /* Search input */
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', e => handleSearchInput(e.target.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') handleSearchClear();
  });

  document.getElementById('search-clear').addEventListener('click', handleSearchClear);

  /* Sidebar */
  document.getElementById('sidebar-close').addEventListener('click', handleSidebarClose);
  document.getElementById('btn-directions').addEventListener('click', handleDirectionsRequested);
  // Prevent sidebar from closing on internal clicks
  document.getElementById('sidebar').addEventListener('click', e => e.stopPropagation());

  /* Directions back/swap/search */
  document.getElementById('btn-back').addEventListener('click', handleBack);
  document.getElementById('btn-swap').addEventListener('click', handleSwap);
  document.getElementById('btn-search-route').addEventListener('click', handleRouteSearch);

  /* Directions origin input */
  const originInput = document.getElementById('origin-input');
  originInput.addEventListener('input', e => handleOriginInput(e.target.value));

  /* Directions destination input (allow edit) */
  const destInput = document.getElementById('dest-input');
  destInput.removeAttribute('readonly');
  destInput.addEventListener('input', e => handleDestInput(e.target.value));

  /* Category buttons */
document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    let current = [...getState().activeCategory];

    if (type === 'all') {
      if (current.includes('all')) {
        // toggle OFF all
        current = [];
        btn.classList.remove('active');
      } else {
        // toggle ON all → clear others
        current = ['all'];
        document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    } else {
      // remove "all" if selecting others
      current = current.filter(c => c !== 'all');
      document.querySelector('[data-type="all"]').classList.remove('active');

      if (current.includes(type)) {
        current = current.filter(c => c !== type);
        btn.classList.remove('active');
      } else {
        current.push(type);
        btn.classList.add('active');
      }
    }

    setState({ activeCategory: current });
  });
});

  /* Close suggestions when clicking outside UI */
  document.addEventListener('click', e => {
    const inSearch = e.target.closest('#search-panel');
    const inDir    = e.target.closest('#directions-panel');
    const inSidebar= e.target.closest('#sidebar');
    if (!inSearch && !inDir && !inSidebar) {
      setState({ suggestions: [], originSuggestions: [], destSuggestions: [] });
    }
  });

  /* Keyboard navigation in search suggestions */
  let selectedIdx = -1;
  searchInput.addEventListener('keydown', e => {
    const items = document.querySelectorAll('#search-suggestions .suggestion-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx+1, items.length-1); updateActive(items, selectedIdx); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); selectedIdx = Math.max(selectedIdx-1, -1); updateActive(items, selectedIdx); }
    if (e.key === 'Enter' && selectedIdx >= 0) { items[selectedIdx]?.dispatchEvent(new Event('mousedown')); selectedIdx = -1; }
    if (e.key === 'Enter' && selectedIdx === -1) {
      const rooms = searchRooms(searchInput.value);
      if (rooms[0]) handleRoomSelected(rooms[0]);
    }
  });
  searchInput.addEventListener('input', () => { selectedIdx = -1; });

  searchInput.addEventListener('focus', () => {
  if (!searchInput.value) {
    setState({
      query: '',
      suggestions: recentSearches
        .map(name => getRoomByName(name))
        .filter(Boolean),
    });
  }
});

  /* Auto-search route when both fields filled in directions */
  [originInput, destInput].forEach(inp => {
    inp.addEventListener('change', () => {
      const st = getState();
      if (st.origin && st.destination) handleRouteSearch();
    });
  });
}

function updateActive(items, idx) {
  items.forEach((item, i) => item.classList.toggle('active', i === idx));
  if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
}

/* ════════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  wireEvents();

  fetch('rooms.csv')
    .then(r => r.text())
    .then(text => {
      parseCSV(text);
      console.log(`Loaded ${_rooms.length} rooms`);
    })
    .catch(() => console.warn('rooms.csv not found — running without room data'));

  // Render initial state
  renderFromState(getState());

  // Focus search on load
  setTimeout(() => document.getElementById('search-input').focus(), 200);
});

let nodes = [];
let edges = {};

fetch('nodes.csv')
  .then(res => res.text())
  .then(text => {
    parseNodesCSV(text);
  });

function parseNodesCSV(data) {
  const lines = data.trim().split('\n').slice(1);

  nodes = [];
  edges = {};

  lines.forEach(line => {
    const [id, x, y, connections] = line.split(',');

    const cleanId = id?.trim();
    const px = parseFloat(x);
    const py = parseFloat(y);

    // ❌ skip invalid rows completely
    if (!cleanId || isNaN(px) || isNaN(py)) return;

    nodes.push({
      id: cleanId,
      x: px,
      y: py
    });

    edges[cleanId] = connections
      ? connections
          .split(';')
          .map(c => c.trim())
          .filter(c => c) // ✅ remove empty strings
      : [];
  });

  console.log("NODES:", nodes);
}
function mapShowRoomsByCategory(categories) {
  mapClearAll();

  const filtered = categories.length === 0
    ? []
    : categories.includes('all')
      ? _rooms
      : _rooms.filter(r => categories.includes(r.type?.toLowerCase()));

  filtered.forEach(room => {
    const latlngs = room.coords.map(([x,y]) => [x,y]);

    L.polygon(latlngs, {
      color: '#4285F4',
      weight: 1.5,
      fillOpacity: 0.1,
      interactive: true
    }).addTo(_layerPolygons);

    const center = L.latLng(room.center[0], room.center[1]);

    L.marker(center, {
      icon: makePin('room')
    })
    .addTo(_layerMarkers)
    .on('click', () => {
      handleRoomSelected(room);
    });


  });
}
/* Город — пробная векторная карта в духе референса.
 *
 * Карта приходит не картинками, а объектами (дороги, вода, парки, дома,
 * названия) с OpenFreeMap, и каждому мы сами задаём вид через MapLibre.
 *
 * Город нарезан по улицам, железным дорогам и рекам на кусочки
 * (data/zones.json), кусочки собраны в участки вокруг станций метро и МЦК
 * (data/cells.json). Поверх лежат знаковые места — парки, кластеры, рынки
 * (data/landmarks.json). Открываются кусочки и знаковые места.
 *
 * Как сделано свечение только внутри открытого. Весь город рисуем
 * «освещённым»: тёплые улицы, зелёные парки, огоньки вдоль дорожек. Сверху
 * кладём «туман» — тёмный многоугольник на весь мир с дырками там, где
 * открыто. Под туманом яркие улицы приглушаются до серых, в дырках горят.
 * Подписи, замки и неоновый контур лежат уже поверх тумана.
 */
'use strict';

const DATA_VERSION = 14;
// новая нарезка — новые кусочки, старые отметки к ним не подходят
const OPEN_KEY = 'gorod.vector-zones.v8';
// что открыто для примера при первом запуске: участок целиком, пара кусочков, места
const C = {
  bg: '#0a0f17', land: '#0d131c', building: '#141b27',
  water: '#0b2536', waterEdge: '#35d6e6',
  park: '#17502d', wood: '#134526', grass: '#164a2a',
  road: '#ffe6ad', roadGlow: '#ffab3d', path: '#f3cf86', rail: '#4d5666',
  neon: '#3ff0dc', label: '#8792a4', halo: '#0a0f17',
  // интересные места — свой сиреневый цвет: тёплые фонари и бирюзовое «открыто» его не глушат
  poi: '#c3a2ff', poiText: '#ddd0ff', poiRing: '#f4efff',
};
const FOG_OPACITY = 0.84;
const FONT = { reg: ['Noto Sans Regular'], bold: ['Noto Sans Bold'], ital: ['Noto Sans Italic'] };
const NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']];
const WORLD = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
const KIND_LABEL = { park: 'парк', cluster: 'культурное пространство', market: 'рынок, еда' };

const App = { map: null, cells: [], zones: [], places: [], pois: [], poiPoints: [], byId: {},
  zonesOf: {}, poisOf: {}, poisOfZone: {}, open: new Set(), current: null, me: null };

/* ============================ данные ============================ */

async function loadData() {
  // номер версии данных: меняем после пересборки, чтобы браузер не взял старые из кэша
  const get = (u) => fetch(`${u}?v=${DATA_VERSION}`).then((r) => r.json());
  const [cells, zones, places, pois, admin] = await Promise.all([
    get('data/cells.json'), get('data/zones.json'), get('data/landmarks.json'), get('data/pois.json'),
    get('data/admin.json')]);
  // фото и описания из Википедии — не обязательны: нет файла — карта работает без них
  App.photos = await get('data/photos.json').catch(() => ({}));
  App.admin = admin.features;
  App.cells = cells.features;
  App.zones = zones.features;
  App.places = places.features;
  // обычные интересные места (музеи, усадьбы…) — точки; знаковые уже есть как контуры
  App.pois = pois;
  App.poiPoints = pois.filter((p) => !p.landmark).map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: Object.assign({}, p, { kind: 'poi' }),
  }));
  for (const f of [...App.cells, ...App.zones, ...App.places, ...App.poiPoints]) App.byId[f.properties.id] = f;

  for (const c of App.cells) {
    const p = c.properties;
    // у пересадочного узла одно название — главная станция идёт первой (см. build_metro_cells.py)
    p.short = p.stations[0] || p.name;
    App.zonesOf[p.id] = [];
    App.poisOf[p.id] = [];
  }
  for (const z of App.zones) {
    z.properties.kind = 'zone';
    App.zonesOf[z.properties.cell].push(z);
    App.poisOfZone[z.properties.id] = [];
  }
  // знаковые места — первыми в списке участка
  for (const p of [...pois].sort((a, b) => b.landmark - a.landmark)) {
    App.poisOf[p.cell]?.push(p);
    App.poisOfZone[p.zone]?.push(p);
  }

  // своя карта у каждого: отметки живут только в этом браузере, новый человек начинает с нуля
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPEN_KEY)); } catch (e) { /* нет — пустая карта */ }
  App.open = new Set(Array.isArray(saved) ? saved.filter((id) => App.byId[id]) : []);
}

function saveOpen() {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...App.open])); } catch (e) { /* не страшно */ }
}

/* Что открыто. В App.open лежат отметки, и у них разный смысл:
 * - кусочек отмечен кнопкой «Я здесь был» — ты там гулял, он светится целиком;
 * - галочка у места (театр, музей, Флакон) — ты был в самом месте, но район
 *   этим не исследован: загорается только место, кусочек остаётся тёмным. */
const marked = (id) => App.open.has(id);
const isOpen = (f) => marked(f.properties.id);
const openFeatures = () => [...App.zones, ...App.places].filter(isOpen);
const fc = (features) => ({ type: 'FeatureCollection', features });

function togglePoi(p) {
  if (marked(p.id)) App.open.delete(p.id); else App.open.add(p.id);
}

/* Отметить или снять «Я здесь был» у кусочка. Отметки мест внутри не трогаем:
 * это отдельная история — был ли ты в самом месте. */
function setZoneOpen(zone, open) {
  if (open) App.open.add(zone.properties.id); else App.open.delete(zone.properties.id);
}

/* сколько кусочков участка открыто: [открыто, всего] */
const progress = (cell) => {
  const zs = App.zonesOf[cell.properties.id];
  return [zs.filter(isOpen).length, zs.length];
};
const labelPoint = (f, extra) => turf.point([f.properties.lng, f.properties.lat],
  Object.assign({ id: f.properties.id, name: f.properties.short || f.properties.name, kind: f.properties.kind }, extra));

function fogGeometry(features) {
  const world = turf.polygon([WORLD]);
  if (!features.length) return world;
  try {
    return turf.difference(fc([world, ...features])) || world;
  } catch (e) {
    // кривой контур сломал вычитание — делаем дырки вручную, без склейки
    console.warn('туман собран без склейки', e);
    const polys = features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
    const holes = polys.map((poly) => turf.rewind(turf.polygon(poly), { reverse: true }).geometry.coordinates[0]);
    return turf.polygon([WORLD, ...holes]);
  }
}

/* ============================ значки ============================ */

function icon(size, draw, h = size) {
  const r = 2;
  const c = document.createElement('canvas');
  c.width = size * r; c.height = h * r;
  const g = c.getContext('2d');
  g.scale(r, r);
  draw(g, size, h);
  return g.getImageData(0, 0, size * r, h * r);
}

/* Плашка под названием открытого места. Карта растягивает её под текст:
 * тянется только середина, скруглённые углы и свечение остаются как есть. */
function pillImage() {
  const data = icon(44, (g) => {
    g.shadowColor = 'rgba(63,240,220,.55)'; g.shadowBlur = 5;
    g.fillStyle = 'rgba(9,20,24,.92)'; g.strokeStyle = C.neon; g.lineWidth = 1.2;
    g.beginPath(); g.roundRect(5, 5, 34, 22, 8); g.fill(); g.stroke();
  }, 32);
  const px = (v) => v * 2; // координаты растяжки — в точках самой картинки
  return { data, opts: { pixelRatio: 2, stretchX: [[px(14), px(30)]], stretchY: [[px(13), px(19)]],
    content: [px(10), px(9), px(34), px(23)] } };
}

/* Маленькие значки видов мест: рисуем одной функцией нужным цветом. */
const GLYPHS = {
  park: (g) => { g.beginPath(); g.moveTo(7, 0.5); g.lineTo(12.5, 9); g.lineTo(1.5, 9); g.closePath(); g.fill(); g.fillRect(6, 9, 2, 4.5); },
  cluster: (g) => { g.beginPath(); g.moveTo(1, 13.5); g.lineTo(1, 6); g.lineTo(5, 8.5); g.lineTo(5, 5); g.lineTo(9, 7.5); g.lineTo(9, 1); g.lineTo(13, 1); g.lineTo(13, 13.5); g.closePath(); g.fill(); },
  market: (g) => { g.fillRect(1.5, 5, 11, 1.8); g.fillRect(2.5, 6.8, 9, 6.7); g.beginPath(); g.moveTo(1, 5); g.lineTo(7, 1); g.lineTo(13, 5); g.fill(); },
  metro: (g) => { g.font = 'bold 12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('М', 7, 7.8); },
  area: (g) => { g.fillRect(1, 6, 4, 7.5); g.fillRect(5.5, 2, 4, 11.5); g.fillRect(10, 5, 3, 8.5); },
};

function makeIcons() {
  const icons = { pill: pillImage() };
  for (const [kind, draw] of Object.entries(GLYPHS)) {
    icons[`ico-${kind}`] = icon(14, (g) => { g.fillStyle = '#9ff6ea'; draw(g); });
    icons[`poi-${kind}`] = icon(14, (g) => { g.fillStyle = C.poi; draw(g); });
  }
  Object.assign(icons, {
    lock: icon(18, (g) => {
      g.fillStyle = '#6b7689'; g.strokeStyle = '#6b7689'; g.lineWidth = 2;
      g.beginPath(); g.arc(9, 7.5, 3.6, Math.PI, 0); g.stroke();
      g.fillRect(9 - 3.6 - 1, 7.5, 2, 2); g.fillRect(9 + 3.6 - 1, 7.5, 2, 2);
      g.beginPath(); g.roundRect(3.5, 8.5, 11, 8, 2); g.fill();
    }),
    // метро — просто красная «М», без круга; тонкая тёмная обводка по контуру буквы,
    // чтобы не терялась на горящих улицах
    // своя геометричная «М» в духе метро (не копия логотипа), светло-серая: широкие ножки,
    // глубокая «галочка» посередине, расширение книзу
    metro: icon(20, (g) => {
      const m = new Path2D('M1.5 17.5 L5.6 3 L10 11.2 L14.4 3 L18.5 17.5 L15 17.5 L13.1 9.6 L10 15.2 L6.9 9.6 L5 17.5 Z');
      g.lineJoin = 'round'; g.lineWidth = 2.6; g.strokeStyle = 'rgba(10,15,23,.85)';
      g.stroke(m);
      g.fillStyle = '#c9d0da';
      g.fill(m);
    }),
    lamp: icon(14, (g) => {
      const grad = g.createRadialGradient(7, 7, 0, 7, 7, 7);
      grad.addColorStop(0, 'rgba(255,248,215,1)');
      grad.addColorStop(0.25, 'rgba(255,205,110,.9)');
      grad.addColorStop(1, 'rgba(255,170,60,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 14, 14);
    }),
  });
  return icons;
}

/* ============================ стиль ============================ */

const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'];

/* Толщина улицы по её классу, растёт с приближением. */
function roadWidth(k) {
  const at = (w) => ['*', k, ['match', ['get', 'class'],
    ['motorway', 'trunk'], w[0], 'primary', w[1], 'secondary', w[2], 'tertiary', w[3], 'minor', w[4], w[5]]];
  return ['interpolate', ['exponential', 1.6], ['zoom'],
    10, at([1.2, 0.9, 0.7, 0.5, 0.25, 0.15]),
    16, at([6, 5, 4, 3.2, 2, 1.2]),
    18, at([12, 10, 8, 7, 5, 3])];
}

function buildStyle() {
  const empty = fc([]);
  const road = ['all', ['in', ['get', 'class'], ['literal', ROADS]], ['!=', ['get', 'brunnel'], 'tunnel']];
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      fog: { type: 'geojson', data: empty },
      openFill: { type: 'geojson', data: empty },
      metro: { type: 'geojson', data: `data/metro.json?v=${DATA_VERSION}` },
      cells: { type: 'geojson', data: fc(App.cells) },
      zones: { type: 'geojson', data: fc(App.zones) },
      admin: { type: 'geojson', data: fc(App.admin) },
      adminLabels: { type: 'geojson', data: fc(App.admin.map((f) => turf.point([f.properties.lng, f.properties.lat], f.properties))) },
      selected: { type: 'geojson', data: empty },
      hover: { type: 'geojson', data: empty },
      places: { type: 'geojson', data: fc(App.places) },
      poiPoints: { type: 'geojson', data: empty },
      cellLabels: { type: 'geojson', data: empty },
      placeLabels: { type: 'geojson', data: empty },
      openLabels: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

      /* ---- «освещённый» город, потом его накроет туман ---- */
      { id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse',
        paint: { 'fill-color': ['match', ['get', 'class'], 'cemetery', C.wood, C.land] } },
      { id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]],
        paint: { 'fill-color': ['match', ['get', 'class'], 'wood', C.wood, C.grass] } },
      // в слое park лежат и охранные зоны (буферная зона Кремля, памятники) — их не красим
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park',
        filter: ['in', ['get', 'class'], ['literal', ['park', 'nature_reserve', 'national_park']]],
        paint: { 'fill-color': C.park, 'fill-opacity': 0.8 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': C.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway',
        paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 4] } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13,
        paint: { 'fill-color': C.building } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
        paint: { 'line-color': C.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.6] } },
      // пешеходные дорожки; платформы вокзалов не рисуем — там от них сплошная рябь
      { id: 'path', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', ['==', ['get', 'class'], 'path'], ['!=', ['get', 'subclass'], 'platform']],
        paint: { 'line-color': C.path, 'line-opacity': 0.75, 'line-dasharray': [2, 1.5],
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 17, 1.6] } },
      { id: 'road-glow', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.roadGlow, 'line-opacity': 0.5, 'line-width': roadWidth(4), 'line-blur': roadWidth(3) } },
      { id: 'road', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.road, 'line-width': roadWidth(1) } },
      // фонари: при приближении мельче и тусклее, чтобы не рябило и не спорило с местами
      { id: 'lamps', type: 'symbol', source: 'omt', 'source-layer': 'transportation', minzoom: 14,
        filter: ['all', ['in', ['get', 'class'], ['literal', ['minor', 'service', 'path', 'tertiary']]],
          ['!=', ['get', 'subclass'], 'platform'], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 60, 'icon-image': 'lamp',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 15.5, 0.55, 18, 0.45],
          'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.9, 15.5, 0.6, 17, 0.35] } },

      /* ---- туман: весь мир минус открытое ---- */
      { id: 'fog', type: 'fill', source: 'fog', paint: { 'fill-color': C.bg, 'fill-opacity': FOG_OPACITY } },

      /* ---- поверх тумана ---- */
      /* Три ступени деления по мере приближения, со сменой без рывков:
       * издалека — округа (ЦАО, САО…), на среднем масштабе — районы,
       * вблизи — наши участки у метро и кусочки. */
      { id: 'okrug-line', type: 'line', source: 'admin', maxzoom: 11, filter: ['==', ['get', 'level'], 'okrug'],
        paint: { 'line-color': '#6d809e', 'line-width': 1.8,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 10.3, 0.9, 10.9, 0] } },
      { id: 'district-line', type: 'line', source: 'admin', minzoom: 10, maxzoom: 12.6,
        filter: ['==', ['get', 'level'], 'district'],
        paint: { 'line-color': '#3f4e66', 'line-width': 1.1,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 10.2, 0, 10.7, 0.9, 12, 0.9, 12.5, 0] } },
      { id: 'zone-line', type: 'line', source: 'zones', minzoom: 12.5,
        paint: { 'line-color': '#222c3b', 'line-width': ['interpolate', ['linear'], ['zoom'], 12.5, 0.4, 16, 1],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13, 1] } },
      { id: 'cell-line', type: 'line', source: 'cells', minzoom: 11.8,
        paint: { 'line-color': '#34435a', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 15, 1.6],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 11.9, 0, 12.4, 1] } },
      { id: 'water-edge-glow', type: 'line', source: 'omt', 'source-layer': 'water',
        paint: { 'line-color': C.waterEdge, 'line-opacity': 0.22, 'line-width': 5, 'line-blur': 4 } },
      { id: 'water-edge', type: 'line', source: 'omt', 'source-layer': 'water',
        paint: { 'line-color': C.waterEdge, 'line-opacity': 0.45, 'line-width': 0.8 } },
      // знаковые места видно и в тумане: сиреневый пунктир — «здесь есть что-то стоящее»
      { id: 'place-line', type: 'line', source: 'places',
        paint: { 'line-color': C.poi, 'line-opacity': 0.75, 'line-dasharray': [2, 1.6],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 1.6] } },
      // заливка открытого: издалека улицы тонкие и почти не светят — без неё
      // открытое читалось бы только по контуру. Вблизи прозрачнее: там горят улицы.
      { id: 'open-fill', type: 'fill', source: 'openFill',
        paint: { 'fill-color': C.neon,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.42, 12, 0.3, 14, 0.12, 16, 0.05] } },
      // неон — по краю тумана, то есть по внешней границе всего открытого,
      // без сетки между соседними открытыми кусочками
      { id: 'open-glow', type: 'line', source: 'fog',
        paint: { 'line-color': C.neon, 'line-opacity': 0.5, 'line-width': 12, 'line-blur': 9 } },
      { id: 'open-line', type: 'line', source: 'fog',
        paint: { 'line-color': C.neon, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 2.4] } },
      // под мышкой (на компьютере): легче, чем выделение по нажатию
      { id: 'hover-fill', type: 'fill', source: 'hover', paint: { 'fill-color': '#dff6ff', 'fill-opacity': 0.06 } },
      { id: 'hover-line', type: 'line', source: 'hover',
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.45, 'line-width': 1.4 } },
      // то, на что нажали: светлая заливка и контур, открытым от этого не становится
      { id: 'sel-fill', type: 'fill', source: 'selected', paint: { 'fill-color': '#dff6ff', 'fill-opacity': 0.1 } },
      { id: 'sel-glow', type: 'line', source: 'selected',
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 8, 'line-blur': 6 } },
      { id: 'sel-line', type: 'line', source: 'selected',
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': 2 } },
      // место, к которому перелетели из списка, — белое кольцо вокруг точки
      { id: 'sel-point', type: 'circle', source: 'selected', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 15, 'circle-color': 'rgba(255,255,255,0.08)',
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } },
      { id: 'zone-hit', type: 'fill', source: 'zones', paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      { id: 'place-hit', type: 'fill', source: 'places', paint: { 'fill-color': '#000', 'fill-opacity': 0 } },

      { id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15,
        layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT.reg, 'text-size': 11 },
        paint: { 'text-color': '#8b95a6', 'text-halo-color': C.halo, 'text-halo-width': 1.4 } },
      { id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': NAME, 'text-font': FONT.ital, 'text-size': 12 },
        paint: { 'text-color': '#5fc3d0', 'text-halo-color': C.halo, 'text-halo-width': 1.2 } },
      { id: 'water-label-line', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'text-field': NAME, 'text-font': FONT.ital, 'text-size': 12, 'symbol-placement': 'line' },
        paint: { 'text-color': '#5fc3d0', 'text-halo-color': C.halo, 'text-halo-width': 1.2 } },
      // станции — из своей выгрузки (data/metro.json): подложка отдаёт метро только
      // с масштаба ~12.5, а нам нужно раньше
      { id: 'metro', type: 'symbol', source: 'metro', minzoom: 11.7,
        layout: { 'icon-image': 'metro', 'icon-size': ['interpolate', ['linear'], ['zoom'], 11.7, 0.85, 13, 1.05, 16, 1.35],
          'text-field': ['step', ['zoom'], '', 12.9, ['get', 'name']], 'text-font': FONT.bold,
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.9, 10.5, 16, 13.5],
          'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true,
          'symbol-sort-key': -1 },
        paint: { 'text-color': '#ffffff', 'text-halo-color': C.halo, 'text-halo-width': 2, 'text-halo-blur': 0.4 } },
      { id: 'place-label-city', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        layout: { 'text-field': NAME, 'text-font': FONT.bold,
          'text-size': ['match', ['get', 'class'], 'city', 18, 12] },
        paint: { 'text-color': '#c9d1dc', 'text-halo-color': C.halo, 'text-halo-width': 1.6 } },
      // интересные места: сиреневая точка в светлом ободке с тёмной «подложкой» вокруг —
      // по форме и цвету не спутать с фонарём; бирюзовая — уже был
      // где был — бирюзовое свечение вокруг точки, видно и издалека, и в тёмном кусочке
      { id: 'poi-glow', type: 'circle', source: 'poiPoints', minzoom: 11.5, filter: ['get', 'visited'],
        paint: { 'circle-color': C.neon, 'circle-opacity': 0.35, 'circle-blur': 0.8,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 9, 16, 22] } },
      { id: 'poi-halo', type: 'circle', source: 'poiPoints', minzoom: 12.5,
        paint: { 'circle-color': C.bg, 'circle-opacity': 0.75,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 6, 16, 11] } },
      // не был — сиреневая точка с приближения 12.5
      { id: 'poi-dot', type: 'circle', source: 'poiPoints', minzoom: 12.5, filter: ['!', ['get', 'visited']],
        paint: { 'circle-color': C.poi,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 3, 16, 6],
          'circle-stroke-color': C.poiRing, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12.5, 1, 16, 2] } },
      // был — бирюзовая, крупнее, с белым ободком и видна уже с 11.5
      { id: 'poi-dot-visited', type: 'circle', source: 'poiPoints', minzoom: 11.5, filter: ['get', 'visited'],
        paint: { 'circle-color': C.neon,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 4, 16, 9],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11.5, 1, 16, 2.5] } },
      { id: 'poi-label', type: 'symbol', source: 'poiPoints', minzoom: 13,
        // где был — подпись с галочкой уже с 13; остальные — только с 14.5
        layout: { 'text-field': ['step', ['zoom'],
          ['case', ['get', 'visited'], ['concat', '✓ ', ['get', 'name']], ''],
          14.5, ['case', ['get', 'visited'], ['concat', '✓ ', ['get', 'name']], ['get', 'name']]],
          'text-font': FONT.bold, 'text-size': 11,
          'text-anchor': 'left', 'text-offset': [1.1, 0], 'text-max-width': 10, 'text-optional': true },
        paint: { 'text-color': ['case', ['get', 'visited'], C.neon, C.poiText],
          'text-halo-color': C.halo, 'text-halo-width': 2.2, 'text-halo-blur': 0.5 } },
      // закрытые участки: замок и название
      // округа издалека: крупное «ЦАО» и под ним полное название
      { id: 'okrug-label', type: 'symbol', source: 'adminLabels', maxzoom: 11,
        filter: ['==', ['get', 'level'], 'okrug'],
        layout: { 'text-field': ['format', ['get', 'short'], { 'font-scale': 1 },
          ['concat', '\n', ['get', 'name']], { 'font-scale': 0.5 }],
          'text-font': FONT.bold, 'text-size': 20, 'text-letter-spacing': 0.08, 'text-max-width': 12 },
        paint: { 'text-color': '#c9d2de', 'text-halo-color': C.halo, 'text-halo-width': 2,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 10.3, 1, 10.9, 0] } },
      // районы на среднем масштабе
      { id: 'district-label', type: 'symbol', source: 'adminLabels', minzoom: 10.2, maxzoom: 12.6,
        filter: ['==', ['get', 'level'], 'district'],
        layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': FONT.bold, 'text-letter-spacing': 0.12,
          'text-size': ['interpolate', ['linear'], ['zoom'], 10.5, 10, 12, 12], 'text-max-width': 8 },
        paint: { 'text-color': '#9aa6b8', 'text-halo-color': C.halo, 'text-halo-width': 1.6,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 10.3, 0, 10.8, 1, 12, 1, 12.5, 0] } },
      // закрытые участки у метро вблизи: замок и название
      { id: 'cell-label', type: 'symbol', source: 'cellLabels', minzoom: 12.1,
        layout: { 'icon-image': 'lock', 'icon-anchor': 'bottom', 'icon-size': 0.85,
          'text-field': ['upcase', ['get', 'name']],
          'text-font': FONT.reg, 'text-letter-spacing': 0.12,
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 15, 12],
          'text-anchor': 'top', 'text-offset': [0, 0.3], 'text-max-width': 9, 'text-optional': true },
        paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.4,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.1, 0, 12.5, 1],
          'icon-opacity': ['interpolate', ['linear'], ['zoom'], 12.1, 0, 12.5, 1] } },
      // закрытые знаковые места: сиреневый значок и название — важнее замков участков
      { id: 'place-label', type: 'symbol', source: 'placeLabels', minzoom: 10.5,
        layout: { 'icon-image': ['concat', 'poi-', ['get', 'kind']],
          'text-field': ['step', ['zoom'], '', 11.5, ['get', 'name']],
          'text-font': FONT.bold, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.7],
          'text-max-width': 9, 'text-optional': true },
        paint: { 'text-color': C.poiText, 'text-halo-color': C.halo, 'text-halo-width': 2.2, 'text-halo-blur': 0.5 } },
      { id: 'open-label', type: 'symbol', source: 'openLabels',
        layout: {
          // одна строка: значок, название, прогресс; висит над верхним краем места
          'text-field': ['format',
            ['image', ['concat', 'ico-', ['get', 'kind']]], {},
            '  ', {},
            ['get', 'name'], {},
            ['concat', '  ', ['get', 'status']], { 'font-scale': 0.85, 'text-color': C.neon }],
          'text-font': FONT.bold, 'text-size': 11.5, 'text-anchor': 'bottom', 'text-offset': [0, -0.5],
          'text-max-width': 40,
          'icon-image': 'pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [2, 7, 2, 5],
          // знаковые места важнее участков: при нехватке места прячется участок
          'symbol-sort-key': ['match', ['get', 'kind'], ['metro', 'area'], 2, 1],
        },
        paint: { 'text-color': '#eef3f8' } },
      // когда плашка крупнее самого места — только светящееся название без рамки
      { id: 'open-name', type: 'symbol', source: 'openLabels',
        layout: { 'text-field': ['get', 'shortText'], 'text-font': FONT.bold, 'text-size': 11,
          'text-anchor': 'bottom', 'text-offset': [0, -0.3],
          'text-max-width': 10, 'symbol-sort-key': ['match', ['get', 'kind'], ['metro', 'area'], 2, 1] },
        paint: { 'text-color': C.neon, 'text-halo-color': C.halo, 'text-halo-width': 1.6 } },
    ],
  };
}

/* ============================ перерисовка ============================ */

function refresh() {
  const map = App.map;
  const open = openFeatures();
  map.getSource('fog').setData(fogGeometry(open));
  map.getSource('openFill').setData(fc(open));
  // участок без единого открытого кусочка — замок; хоть один — плашка с прогрессом
  const touched = App.cells.filter((c) => progress(c)[0] > 0);
  map.getSource('cellLabels').setData(fc(App.cells.filter((c) => progress(c)[0] === 0).map((f) => labelPoint(f))));
  map.getSource('placeLabels').setData(fc(App.places.filter((f) => !isOpen(f)).map((f) => labelPoint(f))));
  for (const f of App.poiPoints) f.properties.visited = isOpen(f);
  map.getSource('poiPoints').setData(fc(App.poiPoints));
  map.getSource('openLabels').setData(fc([
    ...App.places.filter(isOpen).map((f) => withLabelZooms(f, '✓', '')),
    ...touched.map((c) => {
      const [k, n] = progress(c);
      // подпись участка — над его открытой частью, а не над краем всего участка
      const lit = fc(App.zonesOf[c.properties.id].filter(isOpen));
      return k === n ? withLabelZooms(c, '✓', '', lit) : withLabelZooms(c, `${k}/${n}`, ` · ${k}/${n}`, lit);
    }),
  ]));
  updateLabelFilters();
  drawCounter();
  saveOpen();
}

/* С какого приближения место на экране не меньше подписи: подпись висит над
 * местом, и над крошечным кусочком большая плашка выглядела бы чужой.
 * Считаем по прямоугольнику вокруг места. */
function fitZoom(f, pxW) {
  const [w, s, e, n] = turf.bbox(f);
  const lat = (s + n) / 2;
  const metersPerPxAtZ0 = (40075016.686 * Math.cos(lat * Math.PI / 180)) / 512;
  const widthM = (e - w) * 111320 * Math.cos(lat * Math.PI / 180);
  return Math.log2((pxW * metersPerPxAtZ0) / Math.max(widthM, 1));
}

/* Самая северная точка места — туда вешаем подпись, чтобы она не закрывала
 * то, что внутри. */
function topPoint(f) {
  let best = null;
  turf.coordEach(f, (c) => { if (!best || c[1] > best[1]) best = c; });
  return best;
}

function withLabelZooms(f, status, suffix, shape = f) {
  const name = f.properties.short || f.properties.name;
  const shortText = name + suffix;
  const [lng, lat] = topPoint(shape);
  const pt = labelPoint(f, {
    status, shortText,
    pillZ: fitZoom(shape, name.length * 7 + 60),
    textZ: fitZoom(shape, (shortText.length * 6.5 + 8) * 0.6),
  });
  pt.geometry.coordinates = [lng, lat];
  return pt;
}

/* Плашка — если место крупное на экране, название — если среднее, иначе ничего:
 * открытость и так видна по неону и горящим улицам. */
function updateLabelFilters() {
  const z = App.map.getZoom();
  // в режиме «не был» плашки открытых знаковых территорий тоже прячем
  const hideDone = App.poiFilter === 'todo'
    ? ['!', ['in', ['get', 'kind'], ['literal', ['park', 'cluster', 'market']]]] : true;
  App.map.setFilter('open-label', ['all', ['<=', ['get', 'pillZ'], z], hideDone]);
  App.map.setFilter('open-name', ['all', ['<=', ['get', 'textZ'], z], ['>', ['get', 'pillZ'], z], hideDone]);
}

const SVG = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICONS = {
  park: SVG('M12 2 5 12h3l-3 5h6v5h2v-5h6l-3-5h3z'),
  cluster: SVG('M2 22V10l6 4V9l6 4V2h8v20z'),
  market: SVG('M3 9h18v3H3zm1 3h16v10H4zM2 9l10-7 10 7z'),
  metro: SVG('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm4.5 13h-2v-5l-2.5 4-2.5-4v5h-2V8h2l2.5 4.2L14.5 8h2z'),
  area: SVG('M3 21V9l5-3v4l5-3v4l5-3v13zM6 17h2v-2H6zm5 0h2v-2h-2zm5 0h2v-2h-2z'),
  lock: SVG('M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z'),
};

function drawCounter() {
  const n = App.cells.filter((c) => progress(c)[0] > 0).length, total = App.cells.length;
  const k = App.pois.filter((p) => App.open.has(p.id)).length;
  document.getElementById('countText').textContent = `${n} / ${total}`;
  // в шапке — участки у метро; кусочки считаются внутри участка (на плашках «4/9»),
  // общее число кусочков в тысячах ничего бы не говорило
  document.getElementById('countSub').textContent = `участков открыто · мест ${k}`;
  const len = 2 * Math.PI * 15;
  document.getElementById('ringFg').style.strokeDasharray = `${Math.max(len * n / total, 0.01)} ${len}`;
}

/* ============================ карточка ============================ */

const cellTitle = (c) => c.properties.short;
/* остальные станции пересадочного узла — мелко в подзаголовке */
const alsoStations = (c) => (c.properties.stations.length > 1 ? ` · ещё ${c.properties.stations.slice(1).join(', ')}` : '');

function setCellOpen(cell, open) {
  for (const z of App.zonesOf[cell.properties.id]) setZoneOpen(z, open);
}

function setButton(id, text, primary, onclick) {
  const btn = document.getElementById(id);
  btn.hidden = !text;
  if (!text) return;
  btn.className = 'card-btn' + (primary ? '' : ' ghost');
  btn.textContent = text;
  btn.onclick = () => { onclick(); refresh(); showCard(App.current); };
}

/* back — карточка, из которой пришли (кусочек или участок, где был список мест):
 * в карточке места появляется «← назад». Кнопки внутри карточки перерисовывают
 * её через showCard(App.current) — «назад» при этом сохраняется. */
function showCard(f, back) {
  if (back !== undefined) App.back = back;
  else if (f !== App.current) App.back = null;
  App.current = f;
  const backBtn = document.getElementById('cardBack');
  backBtn.hidden = !App.back;
  backBtn.onclick = () => { const b = App.back; App.back = null; showCard(b); };
  const p = f.properties;
  const kind = p.kind;
  let title, sub, icoKind, open, badge;

  if (kind === 'zone') {
    const cell = App.byId[p.cell];
    const [k, n] = progress(cell);
    open = isOpen(f);
    title = p.name || (cell.properties.kind === 'metro' ? `У метро «${cell.properties.short}»` : cell.properties.short);
    sub = `${cell.properties.kind === 'metro' ? 'м. ' : ''}${cellTitle(cell)} · открыто ${k} из ${n}`;
    icoKind = cell.properties.kind;
    drawList(cell, p.id);
    badge = open ? 'ОТКРЫТО' : 'НЕ БЫЛИ';
    setButton('cardBtn', open ? 'Закрыть обратно' : 'Я здесь был', !open, () => setZoneOpen(f, !open));
    setButton('cardBtn2', k === n ? 'Закрыть весь участок' : 'Открыть весь участок', false,
      () => setCellOpen(cell, k !== n));
  } else if (kind === 'metro' || kind === 'area') {
    const [k, n] = progress(f);
    open = k > 0;
    title = cellTitle(f);
    sub = `${kind === 'metro' ? `участок у метро · ${p.district}${alsoStations(f)}` : 'участок без метро рядом'} · ${n} кусочков`;
    icoKind = kind;
    drawList(f, null);
    badge = k === 0 ? 'НЕ БЫЛИ' : k === n ? 'ОТКРЫТО' : `${k} ИЗ ${n}`;
    setButton('cardBtn', k === n ? 'Закрыть весь участок' : 'Открыть весь участок', k !== n,
      () => setCellOpen(f, k !== n));
    setButton('cardBtn2', null);
  } else {
    // знаковое место (контур) или обычное интересное место (точка)
    const poi = App.pois.find((x) => x.id === p.id);
    open = isOpen(f);
    title = p.name;
    sub = kind === 'poi' ? p.kind_label : `${KIND_LABEL[kind] || 'место'} · ${p.area_ha} га`;
    if (poi) sub += ` · ${App.byId[poi.cell] ? cellTitle(App.byId[poi.cell]) : ''}`;
    icoKind = kind === 'poi' ? 'cluster' : kind;
    badge = open ? 'БЫЛ ЗДЕСЬ' : 'НЕ БЫЛИ';
    setButton('cardBtn', open ? 'Снять отметку' : 'Я здесь был', !open,
      () => (poi ? togglePoi(poi) : open ? App.open.delete(p.id) : App.open.add(p.id)));
    setButton('cardBtn2', null);
    drawList(null);
  }

  document.getElementById('cardTitle').textContent = title;
  document.getElementById('cardSub').textContent = sub;
  const ico = document.getElementById('cardIco');
  // у места — фото и пара предложений из Википедии, если нашлись
  const ph = App.photos[p.id];
  const isPlace = kind !== 'zone' && kind !== 'metro' && kind !== 'area';
  if (isPlace && ph && ph.img) {
    ico.className = 'card-ico photo';
    ico.innerHTML = '';
    ico.style.backgroundImage = `url("${ph.img}")`;
    ico.dataset.src = ph.src || 'Википедия';
    ico.onclick = () => openPhoto(ph, p.name);  // нажатие — фото на весь экран
  } else {
    ico.className = 'card-ico' + (open ? '' : ' locked');
    ico.style.backgroundImage = '';
    ico.innerHTML = open ? (ICONS[icoKind] || ICONS.park) : ICONS.lock;
    ico.onclick = null;
  }
  const desc = document.getElementById('cardDesc');
  desc.hidden = !(isPlace && ph && (ph.text || ph.url));
  if (!desc.hidden) {
    desc.textContent = ph.text ? `${ph.text} ` : '';
    const a = document.createElement('a');
    a.href = ph.url; a.target = '_blank'; a.rel = 'noopener';
    // куда ведёт ссылка: статья Википедии, запись Викиданных или сам снимок на Commons
    a.textContent = ph.src === 'Wikimedia Commons' ? 'Фото целиком'
      : ph.src === 'Викиданные' ? 'Подробнее' : 'Подробнее в Википедии';
    desc.append(a);
  }
  const b = document.getElementById('cardBadge');
  b.className = 'badge' + (open ? '' : ' locked');
  b.textContent = badge;
  document.getElementById('card').hidden = false;
  // у точки контура нет — подсвечиваем кусочек, в котором она стоит
  const sel = kind === 'poi' ? App.byId[p.zone] : f;
  App.map.getSource('selected').setData(fc(sel ? [sel] : []));
  keepVisible(kind === 'poi' ? f.geometry.coordinates : [p.lng, p.lat]);
}

/* На телефоне карточка закрывает пол-экрана: если выбранное оказалось
 * под ней, сдвигаем карту, чтобы оно было видно над карточкой. */
function keepVisible(lngLat) {
  const cardH = document.getElementById('card').offsetHeight;
  const { y } = App.map.project(lngLat);
  const bottom = window.innerHeight - cardH - 24;
  if (y > 110 && y < bottom) return;
  // offset, а не padding: padding у MapLibre запоминается и мешал бы дальше
  const visibleMid = (110 + bottom) / 2;
  App.map.easeTo({ center: lngLat, offset: [0, visibleMid - window.innerHeight / 2], duration: 400 });
}

/* Список интересных мест — только того, что обведено белым: у кусочка —
 * его места, у участка — все места участка. Кружок слева — отметка «был»,
 * нажатие на название плавно переносит карту к месту. */
function drawList(cell, zoneId) {
  const box = document.getElementById('cardList');
  box.hidden = !cell;
  if (!cell) return;
  const all = App.poisOf[cell.properties.id];
  const list = zoneId ? all.filter((p) => p.zone === zoneId) : all;
  box.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = list.length
    ? `Интересные места · был в ${list.filter((p) => App.open.has(p.id)).length} из ${list.length}`
    : 'Здесь интересных мест пока не знаем';
  box.append(h);
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'poi' + (App.open.has(p.id) ? ' done' : '') + (p.landmark ? ' gold' : '');
    row.innerHTML = '<button class="mark" title="Отметить, что был здесь">✓</button>'
      + '<button class="poi-go" title="Показать на карте"><span class="txt"><b></b><small></small></span></button>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('small').textContent = p.kind_label;
    const ph = App.photos[p.id];
    if (ph && ph.img) {  // маленькое фото места рядом с названием
      const t = document.createElement('span');
      t.className = 'thumb';
      t.style.backgroundImage = `url("${ph.img}")`;
      row.querySelector('.poi-go').prepend(t);
      row.querySelector('.poi-go').classList.add('with-thumb');
    }
    row.querySelector('.mark').onclick = () => { togglePoi(p); refresh(); showCard(App.current); };
    // название или стрелка — карточка самого места (фото, описание), карта летит к нему
    row.querySelector('.poi-go').onclick = () => { showCard(App.byId[p.id], App.current); flyToPoi(p); };
    box.append(row);
  }
  // из кусочка — переход ко всему участку, если там есть что-то ещё
  if (zoneId && all.length > list.length) {
    const more = document.createElement('button');
    more.className = 'card-btn ghost more';
    more.textContent = `Все места участка «${cell.properties.short}» (${all.length})`;
    more.onclick = () => showCard(cell);
    box.append(more);
  }
}

/* Плавный перелёт к месту из списка. Карточка остаётся открытой, место
 * встаёт в видимую часть экрана над ней и обводится кольцом. */
function flyToPoi(p) {
  const f = App.byId[p.id];
  if (!f) return;
  const map = App.map;
  const cardH = document.getElementById('card').offsetHeight;
  const visibleMid = (110 + window.innerHeight - cardH - 24) / 2;
  const offset = [0, visibleMid - window.innerHeight / 2];
  let center, zoom;
  if (f.geometry.type === 'Point') {
    center = f.geometry.coordinates;
    zoom = Math.max(map.getZoom(), 16);
  } else {
    // у знакового места есть контур — подбираем приближение, чтобы он влез целиком
    center = [f.properties.lng, f.properties.lat];
    const cam = map.cameraForBounds(turf.bbox(f), { padding: 40 });
    zoom = Math.min(cam ? cam.zoom : 15, 16.5);
  }
  map.flyTo({ center, zoom, offset, speed: 0.7, curve: 1.3, essential: true });
  // обводим само место, а выделение кусочка или участка оставляем
  const sel = App.current && App.current.geometry.type !== 'Point' ? [App.current] : [];
  map.getSource('selected').setData(fc([...sel, f.geometry.type === 'Point' ? f : turf.pointOnFeature(f)]));
}

/* Фото места на весь экран. Берём версию пошире (1280 точек) через Special:FilePath —
 * он сам отдаёт исходник, если тот меньше, в отличие от готовых миниатюр. */
function bigPhotoUrl(img) {
  if (img.includes('Special:FilePath/')) return img.replace(/\?width=\d+/, '?width=1280');
  // миниатюра …/480px-Имя.jpg; хвост с метками (?utm_source=…) отрезаем,
  // иначе он попадёт в имя файла и вместо 1280 точек придёт исходник на несколько мегабайт
  const m = img.split('?')[0].match(/\/\d+px-([^/]+)$/);
  return m ? `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}?width=1280` : img;
}

function openPhoto(ph, name) {
  const box = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  img.src = ph.img;                 // сразу показываем то, что уже загружено…
  const big = new Image();          // …и подменяем на крупное, когда догрузится
  big.onload = () => { if (!box.hidden) img.src = big.src; };
  big.src = bigPhotoUrl(ph.img);
  img.alt = name;
  document.getElementById('lightboxCap').textContent = `${name} · Фото: ${ph.src || 'Википедия'}`;
  box.hidden = false;
}

function closePhoto() {
  document.getElementById('lightbox').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

const hideCard = () => {
  App.current = null;
  App.back = null;
  document.getElementById('card').hidden = true;
  App.map.getSource('selected').setData(fc([]));
};

/* ============================ запуск ============================ */

function initMap() {
  const map = App.map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: [37.62, 55.745],
    zoom: 11,
    minZoom: 8,
    maxZoom: 18,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  // значки рисуем сами на холсте и отдаём карте, когда она их попросит
  const icons = makeIcons();
  map.on('styleimagemissing', (e) => {
    const im = icons[e.id];
    if (!im || map.hasImage(e.id)) return;
    if (im.opts) map.addImage(e.id, im.data, im.opts);
    else map.addImage(e.id, im, { pixelRatio: 2 });
  });
  map.on('load', refresh);
  // пороги подписей зависят от приближения — пересчитываем раз в кадр, не чаще
  let pending = false;
  map.on('zoom', () => {
    if (pending || !map.isStyleLoaded()) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; updateLabelFilters(); });
  });

  // порядок важен: сначала подписи, потом знаковые места, потом кусочки
  const CLICK_LAYERS = ['open-label', 'open-name', 'place-label', 'poi-dot', 'poi-dot-visited', 'poi-label', 'cell-label', 'place-hit', 'zone-hit'];
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: CLICK_LAYERS });
    hits.sort((a, b) => CLICK_LAYERS.indexOf(a.layer.id) - CLICK_LAYERS.indexOf(b.layer.id));
    const f = hits.length && App.byId[hits[0].properties.id];
    if (f) showCard(f); else hideCard();
  });
  for (const layer of ['zone-hit', 'place-hit']) {
    map.on('mousemove', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  // подсветка под мышкой: знаковое место важнее кусочка под ним;
  // перерисовываем, только когда мышка перешла на другой объект
  let hovered = null;
  map.on('mousemove', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ['place-hit', 'zone-hit'] });
    const h = hits.find((x) => x.layer.id === 'place-hit') || hits[0];
    const id = h ? h.properties.id : null;
    if (id === hovered) return;
    hovered = id;
    map.getSource('hover').setData(fc(id && App.byId[id] ? [App.byId[id]] : []));
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    hovered = null;
    map.getSource('hover').setData(fc([]));
  });

  document.getElementById('btnZoomIn').onclick = () => map.zoomIn();
  document.getElementById('btnZoomOut').onclick = () => map.zoomOut();
  document.getElementById('cardClose').onclick = hideCard;
  // фото на весь экран закрывается нажатием на него, крестиком или Esc
  document.getElementById('lightbox').onclick = closePhoto;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhoto(); });
  document.getElementById('btnLocate').onclick = locate;
  document.getElementById('btnHere').onclick = markHere;
  document.getElementById('btnTrip').onclick = () => openTrip('weekend');
  document.getElementById('tripClose').onclick = closeTrip;
  for (const b of document.querySelectorAll('#tripTabs button')) b.onclick = () => openTrip(b.dataset.tab);
  for (const b of document.querySelectorAll('#poiFilter button')) b.onclick = () => applyPoiFilter(b.dataset.f);
  // открыть карту по своим фото
  document.getElementById('btnPhotos').onclick = openImport;
  document.getElementById('importClose').onclick = closeImport;
  document.getElementById('importPick').onclick = () => {
    App.importWaiting = true;
    document.getElementById('importFiles').click();
  };
  // Окно выбора закрылось, а файлов ещё нет — значит, телефон готовит фото
  // (скачивает из iCloud, переделывает формат). Окно импорта сразу убираем,
  // карта свободна, а сверху висит плашка с бегущей полоской.
  const showPreparing = () => {
    setTimeout(() => {
      if (!App.importWaiting) return;
      closeImport();
      showImportPill('Телефон готовит фото…', null);
    }, 400);
  };
  window.addEventListener('focus', showPreparing);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) showPreparing(); });
  document.getElementById('importFiles').addEventListener('cancel', () => {  // закрыли, ничего не выбрав
    App.importWaiting = false;
    if (!App.importRun) hideImportPill();  // прошлое чтение ещё идёт — его плашку не трогаем
  });
  document.getElementById('importFiles').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';  // чтобы можно было выбрать те же фото ещё раз
    App.importWaiting = false;
    if (files.length) importPhotos(files); else hideImportPill();
  };
  // × на плашке: остановить чтение (или перестать ждать телефон) и убрать плашку
  document.getElementById('impPillClose').onclick = () => {
    App.importWaiting = false;
    if (App.importRun) App.importRun.stop = true;
    hideImportPill();
  };
  for (const b of document.querySelectorAll('#importPeriod button')) {
    b.onclick = () => {
      App.importDays = Number(b.dataset.p);
      for (const x of document.querySelectorAll('#importPeriod button')) x.classList.toggle('on', x === b);
    };
  }
  map.on('load', () => {
    let saved = 'all';
    try { saved = localStorage.getItem(FILTER_KEY) || 'all'; } catch (e) { /* по умолчанию все */ }
    applyPoiFilter(saved);
  });
}

/* ============================ фильтр мест ============================ */

const FILTER_KEY = 'gorod.poi-filter';

/* Какие интересные места показывать: все, только где не был (что ещё разведать)
 * или только где был (что уже собрано). Касается точек мест и знаковых
 * территорий; открытые кусочки и туман не трогаем. */
function applyPoiFilter(mode) {
  const map = App.map;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const byVisited = mode === 'todo' ? ['!', ['get', 'visited']] : mode === 'done' ? ['get', 'visited'] : null;
  vis('poi-dot', mode !== 'done');
  vis('poi-dot-visited', mode !== 'todo');
  vis('poi-glow', mode !== 'todo');
  map.setFilter('poi-halo', byVisited);
  map.setFilter('poi-label', byVisited);
  // знаковые территории, где не был: пунктир и подпись — прячем в режиме «был»
  vis('place-line', mode !== 'done');
  vis('place-label', mode !== 'done');
  App.poiFilter = mode;
  updateLabelFilters(); // плашки открытых знаковых территорий — прячем в режиме «не был»
  for (const b of document.querySelectorAll('#poiFilter button')) b.classList.toggle('on', b.dataset.f === mode);
  try { localStorage.setItem(FILTER_KEY, mode); } catch (e) { /* не страшно */ }
}

/* ============================ открыть по фото ============================ */

/* Быстрый поиск кусочка по точке: кусочки разложены по клеткам 0,01° —
 * для тысяч фото перебирать все 3,6 тыс. кусочков было бы долго. */
function zoneAt(lng, lat) {
  if (!App.zoneGrid) {
    const grid = new Map();
    App.zones.forEach((z, i) => {
      const [w, s, e, n] = turf.bbox(z);
      for (let x = Math.floor(w * 100); x <= Math.floor(e * 100); x++) {
        for (let y = Math.floor(s * 100); y <= Math.floor(n * 100); y++) {
          const k = `${x}:${y}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
      }
    });
    App.zoneGrid = grid;
  }
  const pt = turf.point([lng, lat]);
  for (const i of App.zoneGrid.get(`${Math.floor(lng * 100)}:${Math.floor(lat * 100)}`) || []) {
    if (turf.booleanPointInPolygon(pt, App.zones[i])) return App.zones[i];
  }
  return null;
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function openImport() {
  hideCard();
  closeTrip();
  document.getElementById('photoImport').hidden = false;
  document.getElementById('bottombar').classList.add('away');
  document.getElementById('importResult').replaceChildren();
}

function closeImport() {
  document.getElementById('photoImport').hidden = true;
  document.getElementById('bottombar').classList.remove('away');
}

/* Плашка импорта сверху карты. pct = null — «бегущая» полоска (ждём телефон),
 * число — обычный прогресс, false — без полоски (показываем итог). */
function showImportPill(text, pct) {
  document.getElementById('impPill').hidden = false;
  document.getElementById('impPillText').textContent = text;
  const prog = document.getElementById('impPillProg');
  prog.hidden = pct === false;
  prog.classList.toggle('wait', pct === null);
  document.getElementById('impPillBar').style.width = typeof pct === 'number' ? `${pct}%` : '';
  document.getElementById('impPillResult').replaceChildren();
}

function hideImportPill() {
  document.getElementById('impPill').hidden = true;
  document.getElementById('impPillResult').replaceChildren();
}

/* Читаем из фото только место и дату съёмки (exifr, прямо в браузере),
 * находим кусочки и спрашиваем, открыть ли. Сами фото никуда не уходят.
 * Всё идёт фоном: окно импорта закрыто, прогресс — в плашке сверху. */
async function importPhotos(files) {
  if (App.importRun) App.importRun.stop = true;  // новый выбор отменяет прошлое чтение
  const run = App.importRun = { stop: false };
  closeImport();
  const days = App.importDays ?? 365;
  const since = days ? Date.now() - days * 864e5 : 0;
  showImportPill(`Читаю фото: 0 из ${files.length}`, 0);
  const zones = new Map();
  let withGps = 0, noGps = 0, old = 0, outside = 0, done = 0;

  // одно фото: место съёмки (exifr читает только начало файла) и дата
  const one = async (f) => {
    const gps = await exifr.gps(f).catch(() => null);
    if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) { noGps += 1; return; }
    const meta = await exifr.parse(f, ['DateTimeOriginal', 'CreateDate']).catch(() => null);
    const shot = meta && (meta.DateTimeOriginal || meta.CreateDate);
    const t = shot instanceof Date ? shot.getTime() : f.lastModified;
    if (since && t < since) { old += 1; return; }
    withGps += 1;
    const z = zoneAt(gps.longitude, gps.latitude);
    if (z) zones.set(z.properties.id, z); else outside += 1;
  };
  // по 6 фото одновременно: чтение с диска параллелится, так заметно быстрее
  let next = 0, lastPaint = 0;
  const worker = async () => {
    while (next < files.length && !run.stop) {
      await one(files[next++]);
      done += 1;
      if (performance.now() - lastPaint > 120 || done === files.length) {
        lastPaint = performance.now();
        const pct = Math.round(100 * done / files.length);
        if (!run.stop) {
          document.getElementById('impPillText').textContent =
            `Читаю фото: ${pct}% · ${done} из ${files.length} · кусочков: ${zones.size}`;
          document.getElementById('impPillBar').style.width = `${pct}%`;
        }
        await new Promise((r) => setTimeout(r));  // даём экрану и карте обновиться
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (run.stop) return;  // остановили крестиком или выбрали фото заново
  App.importRun = null;
  const fresh = [...zones.values()].filter((z) => !isOpen(z));
  showImportPill('Фото прочитаны', false);
  const res = document.getElementById('impPillResult');
  const say = (text) => { const p = document.createElement('p'); p.textContent = text; res.append(p); };
  if (!withGps && !old) {
    say(`В выбранных фото (${files.length}) нет места съёмки. Скорее всего, телефон убрал его при выборе из галереи — так делают iPhone в Safari и новые Android ради приватности.`);
    say('Попробуйте выбрать фото через «Файлы» (кнопка «Обзор»), а не через галерею. Не выйдет — скажите, есть другой способ: загрузить историю перемещений из Google Карт.');
    return;
  }
  say(`Фото с местом съёмки: ${withGps}${days ? ' за последний год' : ''}.`
    + (old ? ` Ещё ${old} — старше года, их пропустили.` : '')
    + (noGps ? ` Без места: ${noGps}.` : '')
    + (outside ? ` Вне Москвы: ${outside}.` : ''));
  say(fresh.length
    ? `Это ${zones.size} ${plural(zones.size, 'кусочек', 'кусочка', 'кусочков')} на карте, из них новых — ${fresh.length}. Открыть их?`
    : `Это ${zones.size} ${plural(zones.size, 'кусочек', 'кусочка', 'кусочков')}, и все они у вас уже открыты.`);
  if (!fresh.length) return;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<button class="card-btn">Открыть</button><button class="card-btn ghost">Не надо</button>';
  row.firstChild.onclick = () => {
    for (const z of fresh) setZoneOpen(z, true);
    refresh();
    hideImportPill();
    App.map.fitBounds(turf.bbox(fc(fresh)), { padding: { top: 120, bottom: 120, left: 40, right: 40 }, maxZoom: 14, duration: 900 });
    toast(`Открыто кусочков: ${fresh.length}`);
  };
  row.lastChild.onclick = hideImportPill;
  res.append(row);
}

/* ============================ где я ============================ */

/* Узнать, где человек. Последнее место запоминаем: «Рядом» и «На выходные»
 * считают расстояния от него. */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('нет геолокации')); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      App.here = { ll: [pos.coords.longitude, pos.coords.latitude], acc: pos.coords.accuracy };
      if (!App.me) {
        const el = document.createElement('div');
        el.className = 'me';
        App.me = new maplibregl.Marker({ element: el });
      }
      App.me.setLngLat(App.here.ll).addTo(App.map);
      resolve(App.here);
    }, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

const GEO_FAIL = 'Не получилось узнать, где вы. Разрешите сайту доступ к геолокации в настройках браузера.';

function locate() {
  getPosition().then(({ ll }) => App.map.flyTo({ center: ll, zoom: Math.max(App.map.getZoom(), 15) }))
    .catch(() => toast(GEO_FAIL));
}

/* «Я здесь»: открыть кусочек, в котором человек сейчас стоит. */
async function markHere() {
  const btn = document.getElementById('btnHere');
  const label = btn.lastChild;
  btn.disabled = true;
  label.textContent = ' Ищу вас…';
  try {
    const { ll, acc } = await getPosition();
    const pt = turf.point(ll);
    const zone = App.zones.find((z) => turf.booleanPointInPolygon(pt, z));
    App.map.flyTo({ center: ll, zoom: Math.max(App.map.getZoom(), 15) });
    if (!zone) { toast('Вы за пределами карты — здесь пока нечего открывать'); return; }
    const was = isOpen(zone);
    setZoneOpen(zone, true);
    refresh();
    showCard(zone);
    const name = zone.properties.name || `у метро «${App.byId[zone.properties.cell].properties.short}»`;
    const rough = acc > 150 ? ` (точность ~${Math.round(acc / 10) * 10} м)` : '';
    toast(was ? `Этот кусочек уже открыт${rough}` : `Открыто: ${name}${rough}`);
  } catch (e) {
    toast(GEO_FAIL);
  } finally {
    btn.disabled = false;
    label.textContent = ' Я здесь';
  }
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(App.toastTimer);
  App.toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ============================ куда поехать ============================ */

const km = (a, b) => turf.distance(turf.point(a), turf.point(b));
const fmtKm = (d) => (d < 1 ? `${Math.max(50, Math.round(d * 20) * 50)} м` : `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} км`);
// от чего считать расстояние: от человека, если знаем, где он, иначе от центра карты
const origin = () => (App.here ? App.here.ll : App.map.getCenter().toArray());
const originText = () => (App.here ? 'от вас' : 'от центра карты');
// у знакового места координаты — в его контуре, у обычного — в самой записи
const poiLL = (p) => (p.landmark ? [App.byId[p.id].properties.lng, App.byId[p.id].properties.lat] : [p.lng, p.lat]);

/* Идеи на выходные: участки, где ещё не были ни в одном кусочке, в которых
 * много неотмеченных мест (знаковые считаем за три), не слишком близко —
 * это поездка, а не прогулка у дома — и не слишком далеко. */
function weekendIdeas() {
  const o = origin();
  return App.cells.map((c) => {
    const [k] = progress(c);
    const pois = App.poisOf[c.properties.id].filter((p) => !marked(p.id));
    const score = pois.length + 2 * pois.filter((p) => p.landmark).length;
    const d = km(o, [c.properties.lng, c.properties.lat]);
    return { c, k, pois, d, rank: score / (1 + d / 8) };
  }).filter((x) => x.k === 0 && x.pois.length >= 2 && x.d >= 3 && x.d <= 25)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 15);
}

function openTrip(tab) {
  App.tripTab = tab;
  hideCard();
  document.getElementById('trip').hidden = false;
  document.getElementById('bottombar').classList.add('away');
  for (const b of document.querySelectorAll('#tripTabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  drawTrip();
  // тихо уточняем, где человек: расстояния станут честнее
  if (!App.here) getPosition().then(() => { if (!document.getElementById('trip').hidden) drawTrip(); }).catch(() => {});
}

function closeTrip() {
  document.getElementById('trip').hidden = true;
  document.getElementById('bottombar').classList.remove('away');
}

function drawTrip() {
  const body = document.getElementById('tripBody');
  body.replaceChildren();
  if (App.tripTab === 'weekend') drawWeekend(body); else drawNear(body);
}

function drawWeekend(body) {
  const ideas = weekendIdeas();
  if (!ideas.length) {
    body.insertAdjacentHTML('beforeend', '<p class="hint">Похоже, вокруг всё открыто. Отодвиньте карту в другую часть города и откройте снова.</p>');
    return;
  }
  App.ideaIdx = (App.ideaIdx || 0) % ideas.length;
  const { c, pois, d } = ideas[App.ideaIdx];
  const p = c.properties;
  const top = [...pois].sort((a, b) => b.landmark - a.landmark).slice(0, 5);
  const box = document.createElement('div');
  box.className = 'idea';
  box.innerHTML = '<p class="hint"></p><h2></h2><p class="meta"></p><p class="why"></p><ul></ul>'
    + '<div class="card-row"><button class="card-btn" data-a="show">Показать на карте</button>'
    + '<button class="card-btn ghost" data-a="next">Другое предложение</button></div>';
  box.querySelector('.hint').textContent = `Предложение ${App.ideaIdx + 1} из ${ideas.length}`;
  box.querySelector('h2').textContent = p.kind === 'metro' ? `У метро «${p.short}»` : p.short;
  box.querySelector('.meta').textContent = `${p.district ? `${p.district} · ` : ''}${fmtKm(d)} ${originText()}`;
  box.querySelector('.why').textContent = `Вы здесь ещё не были. Интересных мест: ${pois.length}. Например:`;
  const ul = box.querySelector('ul');
  for (const x of top) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span> <small></small>';
    li.firstChild.textContent = x.name;
    li.lastChild.textContent = `· ${x.kind_label}`;
    ul.append(li);
  }
  box.querySelector('[data-a="show"]').onclick = () => {
    closeTrip();
    App.map.fitBounds(turf.bbox(c), { padding: { top: 110, bottom: 260, left: 30, right: 30 }, duration: 900 });
    showCard(c);
  };
  box.querySelector('[data-a="next"]').onclick = () => { App.ideaIdx += 1; drawTrip(); };
  body.append(box);
}

function drawNear(body) {
  const o = origin();
  const list = App.pois.filter((p) => !marked(p.id))
    .map((p) => ({ p, d: km(o, poiLL(p)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 25);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `Где вы ещё не были — ближайшие ${originText()}.`;
  if (!App.here) {
    const b = document.createElement('button');
    b.className = 'linkbtn';
    b.textContent = ' Считать от меня';
    b.onclick = () => getPosition().then(drawTrip).catch(() => toast(GEO_FAIL));
    hint.append(b);
  }
  body.append(hint);
  for (const { p, d } of list) {
    const row = document.createElement('button');
    row.className = 'near-row';
    row.innerHTML = '<span><b></b><small></small></span><span class="dist"></span>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('small').textContent = p.kind_label;
    row.querySelector('.dist').textContent = fmtKm(d);
    row.onclick = () => { closeTrip(); showCard(App.byId[p.id]); flyToPoi(p); };
    body.append(row);
  }
}

loadData().then(initMap).catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;top:40%;width:100%;text-align:center">Не загрузилось: ${e.message}</p>`);
});

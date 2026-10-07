/* Быстрый старт: отметить знакомое за пару минут, чтобы вместо пустой карты
 * сразу была своя Москва.
 *
 * Три способа, их можно пройти по шагам при первом запуске или по одному
 * из меню «Быстро отметить» (кнопка справа):
 *   1. Твои места — дом, работа, учёба: ставишь метку, открывается район вокруг.
 *   2. Станции метро — где выходил: открываются кусочки у выхода.
 *   3. Знаменитые места карточками: вправо — был, влево — не был, вверх — хочу.
 * Плюс прежний импорт по фото.
 *
 * Работает поверх vector.js: берёт оттуда App, refresh(), zoneAt(), toast() и т. п.
 */
'use strict';

const ANCHOR_KEY = 'gorod.anchors';
const WISH_KEY = 'gorod.wish';
const SWIPED_KEY = 'gorod.swiped';
const ONBOARD_KEY = 'gorod.onboarded';

const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
// в макетах (?demo=1) ничего не сохраняем — как и отметки
const saveJSON = (k, v) => { if (DEMO) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* не страшно */ } };

App.anchors = loadJSON(ANCHOR_KEY, []);           // [{ type, ll: [lng, lat] }]
App.wish = new Set(loadJSON(WISH_KEY, []));       // куда хочу сходить (id мест)
App.swiped = new Set(loadJSON(SWIPED_KEY, []));   // какие карточки уже показывали
App.stations = [];                                // [{ name, pts: [[lng, lat], …] }]

/* Свои места. r — радиус в км, в котором открываем кусочки: у дома человек
 * исходил всё вокруг, у работы и учёбы — меньше. */
const ANCHOR_TYPES = [
  { type: 'home', label: 'Дом', hint: 'где живёшь сейчас', r: 1.0, many: false },
  { type: 'work', label: 'Работа', hint: 'офис, где бываешь по делам', r: 0.6, many: true },
  { type: 'study', label: 'Учёба', hint: 'школа, институт', r: 0.6, many: true },
  { type: 'past', label: 'Прошлый дом', hint: 'где жил раньше', r: 0.8, many: true },
  { type: 'often', label: 'Часто бываю', hint: 'родители, друзья, спорт', r: 0.5, many: true },
];
const anchorType = (t) => ANCHOR_TYPES.find((a) => a.type === t);
const STATION_R = 0.45;

/* Знаменитые места для карточек: самое известное — вперемешку парки,
 * музеи, площадки, чтобы не было подряд десяти парков. */
const DECK = [
  'Красная площадь', 'Парк Горького', 'ВДНХ', 'Третьяковская галерея', 'Зарядье', 'Москва-Сити',
  'Парк Воробьёвы горы', 'Государственный универсальный магазин (ГУМ)', 'Винзавод', 'ГЭС-2',
  'Музей-заповедник «Коломенское»', 'Патриаршие пруды', 'Флакон', 'Новодевичий монастырь',
  'парк Сокольники', 'Останкинская телевизионная башня', 'Государственный музей изобразительных искусств имени А. С. Пушкина',
  'Дворцово-парковый ансамбль «Царицыно»', 'Даниловский рынок', 'Музеон', 'Собор Василия Блаженного',
  'Измайловский парк', 'Кремль в Измайлово', 'Мемориальный музей космонавтики', 'Хлебозавод',
  'Нескучный сад', 'Сад «Эрмитаж»', 'Лужники', 'Исторический музей', 'Депо', 'Парк Победы',
  'Музей-заповедник Кусково', 'Главный ботанический сад', 'Стена Цоя', 'Александровский сад',
  'ARTPLAY', 'Смотровая площадка Panorama360', 'Шуховская башня', 'Донской монастырь', 'Парк Останкино',
  'Большой Московский Государственный цирк', 'Музей Москвы', 'Жилой дом на Котельнической набережной',
  'Рабочий и колхозница', 'Ботанический сад МГУ «Аптекарский огород»', 'Лефортовский парк',
];

/* ============================ общее ============================ */

/* Кусочки, центр которых не дальше r км от точки (плюс тот, где сама точка).
 * Считаем по плоскости — на таких расстояниях точно, и в разы быстрее turf. */
function zonesNear([lng, lat], r) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  const out = App.zones.filter((z) => {
    const dx = (z.properties.lng - lng) * kx, dy = (z.properties.lat - lat) * ky;
    return dx * dx + dy * dy <= r * r;
  });
  const here = zoneAt(lng, lat);
  if (here && !out.includes(here)) out.push(here);
  return out;
}

/* Открыть кусочки; вернуть, сколько из них новых. */
function openZones(zones) {
  let fresh = 0;
  for (const z of zones) if (!isOpen(z)) { setZoneOpen(z, true); fresh += 1; }
  return fresh;
}

function nearestStation(ll) {
  let best = null, bestD = Infinity;
  for (const s of App.stations) {
    for (const p of s.pts) {
      const d = km(ll, p);
      if (d < bestD) { bestD = d; best = s.name; }
    }
  }
  return best ? { name: best, d: bestD } : null;
}

/* «у м. Курская»: сначала по участку, в котором точка (у пересадочного узла — главное
 * название), иначе по ближайшей станции. */
const whereText = (ll) => {
  const z = zoneAt(ll[0], ll[1]);
  const cell = z && App.byId[z.properties.cell];
  if (cell && cell.properties.kind === 'metro') return `у м. ${cell.properties.short}`;
  const s = nearestStation(ll);
  return s ? (s.d < 1.5 ? `у м. ${s.name}` : `${fmtKm(s.d)} от м. ${s.name}`) : '';
};

/* Показать на карте всё открытое. */
function fitOpen() {
  const open = openFeatures();
  if (!open.length) return;
  App.map.fitBounds(turf.bbox(fc(open)), { padding: { top: 140, bottom: 140, left: 40, right: 70 }, maxZoom: 14, duration: 900 });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ============================ окно быстрого старта ============================ */

/* По шагам (первый запуск или «пройти всё»): App.wizard — номер шага,
 * иначе null — открыли один способ из меню. */
const STEPS = ['anchors', 'stations', 'swipe', 'summary'];

function openOb(step) {
  hideCard();
  closeTrip();
  closeImport();
  App.obStep = step;
  document.getElementById('ob').hidden = false;
  document.getElementById('bottombar').classList.add('away');
  const body = document.getElementById('obBody');
  const foot = document.getElementById('obFoot');
  body.replaceChildren();
  foot.replaceChildren();
  body.scrollTop = 0;
  const inWizard = App.wizard !== null && App.wizard !== undefined && step !== 'hub';
  document.getElementById('obStep').textContent = inWizard && step !== 'summary' ? `шаг ${App.wizard + 1} из 3` : '';
  ({ hub: drawHub, anchors: drawAnchorsStep, stations: drawStationsStep, summary: drawSummary, reset: drawReset })[step](body, foot, inWizard);
}

function closeOb() {
  document.getElementById('ob').hidden = true;
  document.getElementById('bottombar').classList.remove('away');
}

function setTitle(t) { document.getElementById('obTitle').textContent = t; }

function footButtons(foot, buttons) {
  const row = el('div', 'row');
  for (const [text, primary, fn] of buttons) {
    const b = el('button', primary ? 'card-btn' : 'card-btn ghost', text);
    b.onclick = fn;
    row.append(b);
  }
  foot.append(row);
  return row;
}

/* Следующий шаг (по шагам) или закрыть и показать, что открылось (по одному). */
function stepDone(message) {
  refresh();
  if (App.wizard !== null && App.wizard !== undefined) {
    App.wizard += 1;
    showWizardStep();
    return;
  }
  closeOb();
  if (message) toast(message);
  fitOpen();
}

function startWizard() {
  App.wizard = 0;
  saveJSON(ONBOARD_KEY, true);
  showWizardStep();
}

function showWizardStep() {
  const step = STEPS[App.wizard];
  if (step === 'swipe') openSwipe(); else openOb(step);
}

/* ---------- меню «Быстро отметить» ---------- */

function drawHub(body, foot) {
  App.wizard = null;
  setTitle('Быстро отметить, где был');
  body.append(el('p', 'hint', 'Чтобы не протыкивать карту вручную. Каждый способ можно пройти сколько угодно раз.'));
  const items = [
    ['Твои места', 'дом, работа, учёба — откроем район вокруг', () => openOb('anchors'),
      'M12 3 2 11h3v9h5v-6h4v6h5v-9h3z'],
    ['Станции метро', 'где выходил — откроем кусочки у выходов', () => openOb('stations'),
      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm4.5 13h-2v-5l-2.5 4-2.5-4v5h-2V8h2l2.5 4.2L14.5 8h2z'],
    ['Знаменитые места', 'карточками: был, не был, хочу сходить', () => openSwipe(),
      'M4 5h12v16H4zm14-2v16h2V3zM6 7v8h8V7z'],
    ['По фото из галереи', 'место съёмки откроет кусочки', () => { closeOb(); openImport(); },
      'M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z'],
  ];
  for (const [title, sub, fn, ico] of items) {
    const b = el('button', 'ob-item');
    b.innerHTML = `${SVG(ico)}<span><b></b><small></small></span>`;
    b.querySelector('b').textContent = title;
    b.querySelector('small').textContent = sub;
    b.onclick = fn;
    body.append(b);
  }
  // стереть всё — мелкой серой ссылкой в самом низу, чтобы не нажать случайно
  const reset = el('button', 'ob-reset', 'Стереть всю карту…');
  reset.onclick = () => openOb('reset');
  body.append(reset);
  footButtons(foot, [['Пройти всё по шагам', false, startWizard]]);
}

/* ---------- стереть всю карту ---------- */

function drawReset(body, foot) {
  setTitle('Стереть всю карту?');
  const zs = App.zones.filter(isOpen).length + App.places.filter(isOpen).length;
  const places = App.pois.filter((p) => !p.landmark && marked(p.id)).length;
  body.append(el('p', '', `Пропадут все отметки: открытых кусочков и территорий — ${zs}, мест — ${places}, `
    + `твои места (дом, работа…) — ${App.anchors.length}, список «Хочу» — ${App.wish.size}.`));
  body.append(el('p', 'hint', 'Вернуть будет нельзя. Тема и фильтр мест останутся.'));
  footButtons(foot, [['Стереть', false, resetAll], ['Оставить', true, () => openOb('hub')]])
    .firstChild.classList.add('danger');
}

function resetAll() {
  App.open.clear();
  App.anchors = [];
  App.wish.clear();
  App.swiped.clear();
  App.stSel = new Set();
  for (const k of [ANCHOR_KEY, WISH_KEY, SWIPED_KEY, ONBOARD_KEY]) {
    try { localStorage.removeItem(k); } catch (e) { /* не страшно */ }
  }
  refresh();  // сохранит пустой список отметок
  closeOb();
  hideCard();
  App.map.flyTo({ center: [37.62, 55.745], zoom: 11, duration: 800 });
  toast('Карта очищена — можно начать заново');
  // как при первом запуске
  setTimeout(() => { document.getElementById('welcome').hidden = false; }, 900);
}

/* ---------- 1. твои места ---------- */

function drawAnchorsStep(body, foot, inWizard) {
  setTitle('Твои места');
  body.append(el('p', 'hint', 'Отметь, где живёшь, работаешь, учишься, — откроем район вокруг. Любой пункт можно пропустить.'));
  for (const t of ANCHOR_TYPES) {
    const mine = App.anchors.filter((a) => a.type === t.type);
    const row = el('div', 'ob-anchor');
    const txt = el('span');
    txt.append(el('b', '', t.label), el('small', '', mine.length ? '' : t.hint));
    for (const a of mine) {
      const chip = el('span', 'ob-placed', whereText(a.ll) || 'отмечено');
      const x = el('button', '', '×');
      x.title = 'Убрать метку (открытое останется)';
      x.onclick = () => { App.anchors.splice(App.anchors.indexOf(a), 1); saveJSON(ANCHOR_KEY, App.anchors); drawAnchors(); openOb('anchors'); };
      chip.append(x);
      txt.append(chip);
    }
    const btn = el('button', mine.length ? 'card-btn ghost' : 'card-btn', mine.length ? (t.many ? 'Ещё' : 'Изменить') : 'Указать');
    btn.onclick = () => startPick(t);
    row.append(txt, btn);
    body.append(row);
  }
  footButtons(foot, inWizard
    ? (App.anchors.length ? [['Дальше', true, () => stepDone()]] : [['Пропустить', false, () => stepDone()], ['Дальше', true, () => stepDone()]])
    : [['Готово', true, () => stepDone()]]);
}

/* Выбор точки: метка стоит в центре экрана, карту двигают под ней,
 * пунктиром видно, какие кусочки откроются. */
function startPick(t) {
  App.picking = t;
  closeOb();
  hideCard();
  document.body.classList.add('picking');
  document.getElementById('pick').hidden = false;
  document.getElementById('pickTitle').textContent = `${t.label}: где это?`;
  document.getElementById('pickSearch').value = '';
  document.getElementById('pickFound').replaceChildren();
  const old = !t.many && App.anchors.find((a) => a.type === t.type);
  const center = old ? old.ll : App.here ? App.here.ll : null;
  // радиус целиком на экране: для дома (1 км) — дальше, для остального — ближе
  const zoom = t.r >= 0.8 ? 13 : 13.6;
  if (center) App.map.jumpTo({ center, zoom });
  else if (App.map.getZoom() < 12.5) App.map.jumpTo({ zoom: 12.8 });
  App.map.on('move', pickMoved);
  pickMoved();
}

let pickFrame = 0;
function pickMoved() {
  if (pickFrame) return;
  pickFrame = requestAnimationFrame(() => {
    pickFrame = 0;
    if (!App.picking) return;
    const ll = App.map.getCenter().toArray();
    const zs = zonesNear(ll, App.picking.r);
    App.map.getSource('preview').setData(fc(zs));
    const fresh = zs.filter((z) => !isOpen(z)).length;
    const where = whereText(ll);
    document.getElementById('pickInfo').textContent = zs.length
      ? `${where ? `${where} · ` : ''}откроется кусочков: ${fresh}${fresh < zs.length ? ` (ещё ${zs.length - fresh} уже открыты)` : ''}`
      : 'Здесь карта заканчивается — подвинь ближе к Москве';
  });
}

function endPick() {
  App.picking = null;
  App.map.off('move', pickMoved);
  App.map.getSource('preview').setData(fc([]));
  document.body.classList.remove('picking');
  document.getElementById('pick').hidden = true;
}

function pickConfirm() {
  const t = App.picking;
  const ll = App.map.getCenter().toArray();
  const zs = zonesNear(ll, t.r);
  if (!zs.length) { toast('Здесь карта заканчивается — подвинь ближе к Москве'); return; }
  if (!t.many) App.anchors = App.anchors.filter((a) => a.type !== t.type);
  App.anchors.push({ type: t.type, ll: ll.map((v) => Math.round(v * 1e5) / 1e5) });
  saveJSON(ANCHOR_KEY, App.anchors);
  const fresh = openZones(zs);
  endPick();
  refresh();
  toast(fresh ? `${t.label}: открыто кусочков — ${fresh}` : `${t.label}: отмечено, район уже был открыт`);
  openOb('anchors');
}

/* Поиск по своим данным, без интернета: станции, участки, интересные места. */
function pickSearch(q) {
  const box = document.getElementById('pickFound');
  box.replaceChildren();
  q = q.trim().toLowerCase();
  if (q.length < 2) return;
  const found = [];
  const add = (name, sub, ll) => { if (!found.some((f) => f.name === name && f.sub === sub)) found.push({ name, sub, ll }); };
  const rank = (n) => (n.toLowerCase().startsWith(q) ? 0 : 1);
  for (const s of App.stations) if (s.name.toLowerCase().includes(q)) add(s.name, 'станция метро', s.pts[0]);
  for (const p of App.pois) if (p.name.toLowerCase().includes(q)) add(p.name, p.kind_label, poiLL(p));
  found.sort((a, b) => rank(a.name) - rank(b.name) || (a.sub === 'станция метро' ? -1 : 1));
  for (const f of found.slice(0, 6)) {
    const b = el('button');
    b.append(el('b', '', f.name), el('small', '', f.sub));
    b.onclick = () => {
      box.replaceChildren();
      document.getElementById('pickSearch').blur();
      App.map.flyTo({ center: f.ll, zoom: 14, duration: 700 });
    };
    box.append(b);
  }
  if (!found.length) box.append(el('p', 'hint', 'Ничего не нашлось — подвинь карту руками'));
}

/* ---------- 2. станции метро ---------- */

function drawStationsStep(body, foot, inWizard) {
  setTitle('Станции метро');
  body.append(el('p', 'hint', 'Где выходил из метро хотя бы раз? Отметь — откроем кусочки у выхода. Сверху — ближайшие к твоим местам.'));
  const input = el('input', 'ob-search');
  input.type = 'search';
  input.placeholder = 'Найти станцию';
  const chips = el('div', 'chips');
  body.append(input, chips);
  App.stSel = App.stSel || new Set();

  // откуда считать «ближайшие»: свои места, потом где я, потом центр
  const from = App.anchors.length ? App.anchors.map((a) => a.ll) : [App.here ? App.here.ll : [37.618, 55.751]];
  const dist = (s) => Math.min(...from.flatMap((o) => s.pts.map((p) => km(o, p))));
  const sorted = [...App.stations].sort((a, b) => dist(a) - dist(b));
  const isDone = (s) => s.pts.some((p) => { const z = zoneAt(p[0], p[1]); return z && isOpen(z); });

  const primary = footButtons(foot, inWizard
    ? [['Пропустить', false, () => { App.stSel.clear(); stepDone(); }], ['Дальше', true, () => openStations()]]
    : [['Открыть', true, () => openStations()]]).lastChild;
  const updateFoot = () => {
    const n = App.stSel.size;
    primary.textContent = n ? `${inWizard ? 'Дальше' : 'Открыть'} · ${n}` : (inWizard ? 'Дальше' : 'Готово');
  };

  const draw = () => {
    chips.replaceChildren();
    const q = input.value.trim().toLowerCase();
    const list = q ? sorted.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 60)
      : [...sorted.filter((s) => App.stSel.has(s.name)), ...sorted.slice(0, 40).filter((s) => !App.stSel.has(s.name))];
    for (const s of list) {
      const done = isDone(s);
      const c = el('button', 'chip' + (App.stSel.has(s.name) ? ' on' : '') + (done ? ' done' : ''), (done ? '✓ ' : '') + s.name);
      c.onclick = () => {
        if (App.stSel.has(s.name)) App.stSel.delete(s.name); else App.stSel.add(s.name);
        c.classList.toggle('on');
        updateFoot();
      };
      chips.append(c);
    }
    if (!q && sorted.length > 40) chips.append(el('p', 'hint', 'Нет нужной? Найди поиском — здесь все станции метро и МЦК.'));
  };
  input.oninput = draw;
  draw();
  updateFoot();
}

function openStations() {
  let fresh = 0;
  const n = App.stSel.size;
  for (const name of App.stSel) {
    const s = App.stations.find((x) => x.name === name);
    if (s) for (const p of s.pts) fresh += openZones(zonesNear(p, STATION_R));
  }
  App.stSel.clear();
  stepDone(n ? `Станций: ${n}, открыто кусочков: ${fresh}` : '');
}

/* ---------- 3. знаменитые места карточками ---------- */

function openSwipe() {
  hideCard();
  closeOb();
  closeTrip();
  const byName = new Map(App.pois.map((p) => [p.name, p]));
  App.deck = DECK.map((n) => byName.get(n))
    .filter((p) => p && App.photos[p.id] && App.photos[p.id].img && !App.swiped.has(p.id) && !marked(p.id));
  App.deckPos = 0;
  App.deckHist = [];
  if (!App.deck.length) {
    toast('Знаменитые места уже разобраны — остальные ищи на карте');
    finishSwipe();
    return;
  }
  document.getElementById('swipe').hidden = false;
  document.getElementById('bottombar').classList.add('away');
  drawDeck();
}

function deckCard(p) {
  const card = el('div', 'sw-card');
  const ph = el('div', 'sw-photo');
  const img = App.photos[p.id].img;
  const big = img.replace('/500px-', '/960px-');
  ph.style.backgroundImage = big !== img ? `url("${big}"), url("${img}")` : `url("${img}")`;
  const cell = App.byId[p.cell];
  const text = el('div', 'sw-text');
  const kind = p.kind_label === 'место' ? 'достопримечательность' : p.kind_label;
  text.append(el('b', '', p.name), el('small', '', `${kind}${cell ? ` · у м. ${cell.properties.short}` : ''}`));
  card.append(ph, el('div', 'sw-stamp yes', 'БЫЛ'), el('div', 'sw-stamp no', 'НЕ БЫЛ'), el('div', 'sw-stamp want', 'ХОЧУ'), text);
  return card;
}

function drawDeck() {
  const deck = document.getElementById('swipeDeck');
  deck.replaceChildren();
  const left = App.deck.length - App.deckPos;
  document.getElementById('swipeCount').textContent = left > 0 ? `${App.deckPos + 1} из ${App.deck.length}` : '';
  document.getElementById('swipeUndo').disabled = !App.deckHist.length;
  // следующая карточка лежит под верхней — видно, что стопка не кончилась
  if (left > 1) deck.append(Object.assign(deckCard(App.deck[App.deckPos + 1]), { className: 'sw-card under' }));
  for (const p of App.deck.slice(App.deckPos + 2, App.deckPos + 4)) new Image().src = App.photos[p.id].img.replace('/500px-', '/960px-');
  if (left > 0) {
    const top = deckCard(App.deck[App.deckPos]);
    deck.append(top);
    dragCard(top);
  }
}

/* Перетаскивание верхней карточки пальцем или мышкой. */
function dragCard(card) {
  let x0 = 0, y0 = 0, dx = 0, dy = 0, on = false;
  const stamps = { yes: card.querySelector('.yes'), no: card.querySelector('.no'), want: card.querySelector('.want') };
  const dirOf = () => (dy < -80 && Math.abs(dy) > Math.abs(dx) ? 'want' : dx > 90 ? 'yes' : dx < -90 ? 'no' : null);
  card.addEventListener('pointerdown', (e) => {
    on = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!on) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    stamps.yes.style.opacity = Math.max(0, Math.min(1, dx / 90));
    stamps.no.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    stamps.want.style.opacity = Math.abs(dy) > Math.abs(dx) ? Math.max(0, Math.min(1, -dy / 80)) : 0;
  });
  const up = () => {
    if (!on) return;
    on = false;
    const dir = dirOf();
    if (dir) { decide(dir); return; }
    card.style.transition = '';
    card.style.transform = '';
    for (const s of Object.values(stamps)) s.style.opacity = 0;
  };
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
}

/* Решение по верхней карточке: улетает в свою сторону, отметка ставится сразу. */
function decide(dir) {
  const p = App.deck[App.deckPos];
  if (!p) return;
  const card = document.querySelector('#swipeDeck .sw-card:not(.under)');
  if (card) {
    card.style.transition = 'transform .28s ease-in, opacity .28s';
    card.style.transform = dir === 'want' ? 'translate(0,-120%)' : `translate(${dir === 'yes' ? 140 : -140}%, 20px) rotate(${dir === 'yes' ? 18 : -18}deg)`;
    card.style.opacity = '0';
    card.querySelector(`.${dir}`).style.opacity = 1;
  }
  if (dir === 'yes') App.open.add(p.id);
  if (dir === 'want') App.wish.add(p.id);
  App.swiped.add(p.id);
  App.deckHist.push({ p, dir });
  App.deckPos += 1;
  setTimeout(() => (App.deckPos >= App.deck.length ? finishSwipe() : drawDeck()), 260);
}

function undoSwipe() {
  const last = App.deckHist.pop();
  if (!last) return;
  if (last.dir === 'yes') App.open.delete(last.p.id);
  if (last.dir === 'want') App.wish.delete(last.p.id);
  App.swiped.delete(last.p.id);
  App.deckPos -= 1;
  drawDeck();
}

function finishSwipe() {
  const was = !document.getElementById('swipe').hidden;
  document.getElementById('swipe').hidden = true;
  document.getElementById('bottombar').classList.remove('away');
  saveJSON(WISH_KEY, [...App.wish]);
  saveJSON(SWIPED_KEY, [...App.swiped]);
  const yes = (App.deckHist || []).filter((h) => h.dir === 'yes').length;
  const want = (App.deckHist || []).filter((h) => h.dir === 'want').length;
  stepDone(was && (yes || want) ? `Был: ${yes}, хочу сходить: ${want}${want ? ' — список в «Куда поехать»' : ''}` : '');
}

/* ---------- итог ---------- */

function drawSummary(body, foot) {
  App.wizard = null;
  // крупно — участки: доля площади вышла бы крошечной (в карте вся Новая Москва) и только расстроила
  const zs = App.zones.filter(isOpen);
  const cells = App.cells.filter((c) => progress(c)[0] > 0).length;
  const places = App.pois.filter((p) => marked(p.id)).length;
  setTitle(zs.length || places ? 'Вот твоя Москва' : 'Карта пока чистая');
  body.append(el('p', 'imp-big', `${cells} ${plural(cells, 'участок', 'участка', 'участков')}`),
    el('p', 'hint', `из ${App.cells.length} — в каждом ты уже бывал`));
  const ul = el('ul', 'ob-sum');
  for (const t of [`открыто кусочков: ${zs.length}`, `мест, где был: ${places}`, `хочу сходить: ${App.wish.size}`]) ul.append(el('li', '', t));
  body.append(ul);
  body.append(el('p', 'hint', 'Дальше: на прогулке жми «Я здесь»; фото из галереи и всё, что было выше, — в яркой кнопке с молнией справа; «Куда поехать» подскажет, где ты ещё не был.'));
  footButtons(foot, [['Смотреть карту', true, () => { closeOb(); fitOpen(); }]]);
}

/* ---------- «Хочу» в «Куда поехать» ---------- */

function drawWish(body) {
  const list = App.pois.filter((p) => App.wish.has(p.id));
  if (!list.length) {
    body.append(el('p', 'hint', 'Здесь будут места, куда хочешь сходить. Добавить: ✦ справа → «Знаменитые места», карточку — вверх.'));
    return;
  }
  const o = origin();
  body.append(el('p', 'hint', `Куда хочешь сходить — по расстоянию ${originText()}.`));
  for (const { p, d } of list.map((p) => ({ p, d: km(o, poiLL(p)) })).sort((a, b) => a.d - b.d)) {
    const row = el('div', 'wish-row');
    const go = el('button', 'near-row');
    go.innerHTML = '<span><b></b><small></small></span><span class="dist"></span>';
    go.querySelector('b').textContent = (marked(p.id) ? '✓ ' : '') + p.name;
    go.querySelector('small').textContent = p.kind_label;
    go.querySelector('.dist').textContent = fmtKm(d);
    go.onclick = () => { closeTrip(); showCard(App.byId[p.id]); flyToPoi(p); };
    const x = el('button', 'wish-x', '×');
    x.title = 'Убрать из списка';
    x.onclick = () => { App.wish.delete(p.id); saveJSON(WISH_KEY, [...App.wish]); drawTrip(); };
    row.append(go, x);
    body.append(row);
  }
}

/* ---------- свои места на карте ---------- */

function drawAnchors() {
  const src = App.map && App.map.getSource('anchors');
  if (!src) return;
  src.setData(fc(App.anchors.map((a) => turf.point(a.ll, { label: anchorType(a.type)?.label || '' }))));
}

/* ============================ запуск ============================ */

function onboardInit() {
  fetch(`data/metro.json?v=${DATA_VERSION}`).then((r) => r.json()).then((m) => {
    const byName = new Map();
    for (const f of m.features) {
      const n = f.properties.name;
      if (!byName.has(n)) byName.set(n, { name: n, pts: [] });
      byName.get(n).pts.push(f.geometry.coordinates);
    }
    App.stations = [...byName.values()];
  }).catch(() => { /* без станций: шаг «Станции» будет пустой, остальное работает */ });

  document.getElementById('btnQuick').onclick = () => openOb('hub');
  document.getElementById('obClose').onclick = () => { App.wizard = null; closeOb(); refresh(); };
  document.getElementById('pickOk').onclick = pickConfirm;
  document.getElementById('pickCancel').onclick = () => { endPick(); openOb('anchors'); };
  document.getElementById('pickHere').onclick = () => getPosition()
    .then(({ ll }) => App.map.flyTo({ center: ll, zoom: 14, duration: 700 }))
    .catch(() => toast(GEO_FAIL));
  document.getElementById('pickSearch').oninput = (e) => pickSearch(e.target.value);
  document.getElementById('swYes').onclick = () => decide('yes');
  document.getElementById('swNo').onclick = () => decide('no');
  document.getElementById('swWant').onclick = () => decide('want');
  document.getElementById('swipeUndo').onclick = undoSwipe;
  document.getElementById('swipeDone').onclick = finishSwipe;
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('swipe').hidden) return;
    if (e.key === 'ArrowRight') decide('yes');
    if (e.key === 'ArrowLeft') decide('no');
    if (e.key === 'ArrowUp') decide('want');
  });
  document.getElementById('welcomeGo').onclick = () => { document.getElementById('welcome').hidden = true; startWizard(); };
  document.getElementById('welcomeSkip').onclick = () => {
    document.getElementById('welcome').hidden = true;
    saveJSON(ONBOARD_KEY, true);
  };

  document.getElementById('btnHelp').onclick = () => openStories(false);
  document.getElementById('welcomeHow').onclick = () => { document.getElementById('welcome').hidden = true; openStories(true); };

  // первый запуск: карта пустая и знакомство ещё не проходили —
  // сначала короткие истории (если ещё не смотрел), потом приветствие с быстрым стартом
  App.map.once('load', () => {
    drawAnchors();
    if (DEMO || loadJSON(ONBOARD_KEY, false) || App.open.size !== 0) return;
    if (loadJSON(STORIES_KEY, false)) document.getElementById('welcome').hidden = false;
    else openStories(true);
  });
}

/* Обучающие истории: шесть коротких экранов на весь экран — что это за карта,
 * как она устроена и что здесь делать. Листаются как сторис: касание справа —
 * дальше, слева — назад, палец держишь — пауза, сами идут дальше по полоскам сверху.
 *
 * Показываются при первом запуске перед приветствием, потом — по «?» рядом с «Москва».
 * Картинки нарисованы здесь же (SVG) цветами текущей темы — днём и ночью свои.
 */
'use strict';

const STORIES_KEY = 'gorod.stories';
const STORY_MS = 7000;

/* Общие куски картинок: «город» (земля и улицы), туман со штриховкой, свечение. */
const ART_DEFS = `<defs>
  <pattern id="stHatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
    <rect width="9" height="9" fill="var(--st-fog)"/><line x1="0" y1="0" x2="0" y2="9" stroke="var(--st-hatch)" stroke-width="1.2"/>
  </pattern>
  <filter id="stGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
</defs>`;
const CITY = `<rect width="300" height="300" fill="var(--st-land)"/>
  <g stroke="var(--st-street)" stroke-width="3" fill="none" stroke-linecap="round">
    <path d="M-10 70 C80 60 160 90 310 80"/><path d="M-10 170 C90 160 200 190 310 170"/>
    <path d="M-10 250 C100 240 190 262 310 245"/><path d="M60 -10 C70 100 50 200 75 310"/>
    <path d="M150 -10 C140 90 165 210 150 310"/><path d="M235 -10 C245 120 225 200 240 310"/>
  </g>
  <path d="M-10 120 C60 140 120 105 180 130 S260 150 310 125 L310 150 C250 175 200 150 175 158 S80 170 -10 148Z" fill="var(--st-water)"/>`;
// туман на всё, кроме дырки hole (путь по часовой — дыркой по правилу evenodd)
const FOG = (hole) => `<path fill-rule="evenodd" fill="url(#stHatch)" opacity=".93" d="M0 0H300V300H0Z ${hole}"/>`;
const LIT = (hole, tint = 0.14) => `<path d="${hole}" fill="none" stroke="var(--neon)" stroke-width="9" opacity=".45" filter="url(#stGlow)"/>
  <path d="${hole}" fill="var(--neon)" fill-opacity="${tint}" stroke="var(--neon)" stroke-width="2.5" stroke-linejoin="round"/>`;
const PILL = (x, y, text, w = text.length * 7.4 + 26) => `<g transform="translate(${x - w / 2} ${y})">
  <rect width="${w}" height="26" rx="9" fill="var(--glass)" stroke="var(--neon)" stroke-width="1.4"/>
  <text x="${w / 2}" y="17.5" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--text)">${text}</text></g>`;

const HOLE5 = 'M30 30 L95 25 L105 85 L40 95 Z';

const STORIES = [
  {
    title: 'Открывай город по-новому',
    text: 'Это твоя личная карта Москвы. Места, где ты ещё не был, пока закрыты. Побывал — локация открывается и загорается. Исследуй город и смотри, как карта оживает.',
    // настоящий центр: Кремль, изгиб Москвы-реки; открыты кусочки вокруг (story-art.js)
    art: () => {
      const a = STORY_CITY;
      const x = Math.min(Math.max(a.pill[0], 62), 238);
      return `${ART_DEFS}<rect width="300" height="300" fill="var(--st-land)"/>
        <path d="${a.parks}" fill="var(--st-park)"/><path d="${a.water}" fill="var(--st-water)"/>
        <g fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="${a.minor}" stroke="var(--st-street)" stroke-width="1" opacity=".75"/>
          <path d="${a.middle}" stroke="var(--st-street)" stroke-width="1.8"/>
          <path d="${a.major}" stroke="var(--st-street-major)" stroke-width="3.2"/></g>
        ${FOG(a.open)}${LIT(a.open, 0.03)}
        <text x="${a.kremlin[0]}" y="${a.kremlin[1]}" text-anchor="middle" font-size="12" font-weight="800" letter-spacing="2"
          fill="var(--text)" stroke="var(--st-land)" stroke-width="3" paint-order="stroke">КРЕМЛЬ</text>
        <text x="${a.river[0]}" y="${a.river[1]}" text-anchor="middle" font-size="12" font-style="italic" font-weight="600"
          fill="var(--st-water-text)" stroke="var(--st-land)" stroke-width="3" paint-order="stroke">Москва-река</text>
        ${PILL(x, a.pill[1], 'Был здесь ✓')}`;
    },
  },
  {
    title: 'Город разделён на секторы',
    text: 'Сектор — пара кварталов между улицами и реками. Секторы собраны в участки вокруг станций метро. Нажми на участок — увидишь, сколько в нём открыто.',
    art: () => {
      const cells = ['M20 20 L110 15 L120 95 L25 105 Z', 'M110 15 L200 25 L190 100 L120 95 Z', 'M200 25 L285 18 L280 110 L190 100 Z',
        'M25 105 L120 95 L125 190 L30 200 Z', 'M120 95 L190 100 L200 185 L125 190 Z', 'M190 100 L280 110 L285 195 L200 185 Z',
        'M30 200 L125 190 L120 285 L20 280 Z', 'M125 190 L200 185 L210 282 L120 285 Z', 'M200 185 L285 195 L282 285 L210 282 Z'];
      const lit = [1, 4, 5];
      return `${ART_DEFS}${CITY}<rect width="300" height="300" fill="url(#stHatch)" opacity=".93"/>
        ${cells.map((d, i) => `<path d="${d}" fill="${lit.includes(i) ? 'var(--neon)' : 'none'}" fill-opacity=".16" stroke="${lit.includes(i) ? 'var(--neon)' : 'var(--st-line)'}" stroke-width="${lit.includes(i) ? 2.5 : 1.5}" stroke-linejoin="round"/>`).join('')}
        <path d="${cells[4]}" fill="none" stroke="var(--text)" stroke-width="3" stroke-linejoin="round"/>
        ${PILL(160, 128, 'М Курская · 4/10')}`;
    },
  },
  {
    title: 'Как открывать',
    text: 'На прогулке жми «Я здесь» — откроется кусочек, где ты стоишь. А чтобы не начинать с нуля — кнопка с молнией: дом и работа, станции, знаменитые места, фото из галереи.',
    art: () => `${ART_DEFS}${CITY}${FOG('M110 70 L190 65 L200 140 L115 150 Z')}${LIT('M110 70 L190 65 L200 140 L115 150 Z')}
      <circle cx="155" cy="108" r="34" fill="none" stroke="var(--neon)" stroke-width="2" opacity=".5"/>
      <circle cx="155" cy="108" r="52" fill="none" stroke="var(--neon)" stroke-width="1.5" opacity=".25"/>
      <path transform="translate(141 78)" d="M14 0a14 14 0 0 0-14 14c0 10 14 26 14 26s14-16 14-26A14 14 0 0 0 14 0zm0 19a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" fill="var(--neon)"/>
      <g transform="translate(40 205)"><rect width="150" height="48" rx="24" fill="var(--neon)"/>
        <text x="75" y="31" text-anchor="middle" font-size="17" font-weight="800" fill="var(--on-neon)">Я здесь</text></g>
      <g transform="translate(212 205)"><circle cx="24" cy="24" r="24" fill="var(--neon)"/>
        <path transform="translate(12 12)" d="M13 2 4 14h6l-1 8 9-12h-6z" fill="var(--on-neon)"/></g>`,
  },
  {
    title: 'Интересные места',
    text: 'Фиолетовые точки — музеи, усадьбы, парки, смотровые. Был — поставь кружок-галочку в списке участка. Большие места вроде ВДНХ или Флакона открываются целиком.',
    art: () => `${ART_DEFS}${CITY}<rect width="300" height="300" fill="url(#stHatch)" opacity=".9"/>
      ${[[60, 50], [120, 35], [230, 60], [90, 100], [250, 120]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="var(--chip)" stroke="#fff" stroke-width="2"/>`).join('')}
      <circle cx="180" cy="90" r="16" fill="var(--neon)" opacity=".35" filter="url(#stGlow)"/>
      <circle cx="180" cy="90" r="9" fill="var(--neon)" stroke="#fff" stroke-width="2.5"/>
      <g transform="translate(30 150)"><rect width="240" height="128" rx="16" fill="var(--glass)" stroke="var(--line2)"/>
        <circle cx="30" cy="34" r="11" fill="none" stroke="var(--neon)" stroke-width="2"/><path d="M24 34l4 4 8-8" stroke="var(--neon)" stroke-width="2.5" fill="none"/>
        <text x="52" y="39" font-size="14" font-weight="700" fill="var(--text)">Флакон</text>
        <circle cx="30" cy="70" r="11" fill="none" stroke="var(--line2)" stroke-width="2"/>
        <text x="52" y="75" font-size="14" font-weight="700" fill="var(--text)">Музей Москвы</text>
        <circle cx="30" cy="106" r="11" fill="none" stroke="var(--line2)" stroke-width="2"/>
        <text x="52" y="111" font-size="14" font-weight="700" fill="var(--text)">Усадьба Кусково</text></g>`,
  },
  {
    title: 'Куда поехать',
    text: 'Карта видит дыры. Подскажет участок на выходные, где ты ни разу не был, ближайшие места и твой список «Хочу».',
    art: () => `${ART_DEFS}${CITY}${FOG(HOLE5)}${LIT(HOLE5)}
      <path d="M190 120 L265 112 L272 190 L200 200 Z" fill="none" stroke="var(--chip)" stroke-width="2.5" stroke-dasharray="7 5"/>
      <path d="M100 70 C150 70 175 95 195 128" fill="none" stroke="var(--text)" stroke-width="2" stroke-dasharray="4 5"/>
      <g transform="translate(30 210)"><rect width="240" height="70" rx="16" fill="var(--glass)" stroke="var(--line2)"/>
        <text x="18" y="28" font-size="11" font-weight="700" fill="var(--muted)" letter-spacing="1.5">НА ВЫХОДНЫЕ</text>
        <text x="18" y="52" font-size="16" font-weight="800" fill="var(--text)">У метро «Кузьминки»</text></g>`,
  },
  {
    title: 'Всё остаётся у тебя',
    text: 'Отметки хранятся только на этом устройстве и никуда не отправляются — у каждого своя карта. Днём карта бумажная, ночью тёмная: переключатель справа.',
    art: () => `${ART_DEFS}
      <g><rect width="150" height="300" fill="#f4ecda"/><rect width="150" height="300" fill="url(#stHatchDay)"/>
        <rect x="150" width="150" height="300" fill="#141b27"/></g>
      <defs><pattern id="stHatchDay" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <line x1="0" y1="0" x2="0" y2="9" stroke="rgba(120,96,60,.35)" stroke-width="1.2"/></pattern></defs>
      <circle cx="75" cy="70" r="20" fill="#f0b81c"/>
      <path transform="translate(205 50)" d="M40 30A20 20 0 0 1 13 3a20 20 0 1 0 27 27z" fill="#dfe6f0"/>
      <g transform="translate(105 110)"><rect width="90" height="160" rx="16" fill="var(--glass)" stroke="var(--text)" stroke-width="3"/>
        <rect x="35" y="10" width="20" height="4" rx="2" fill="var(--text)"/>
        <path transform="translate(27 55)" d="M18 0 4 6v12c0 9 6 16 14 18 8-2 14-9 14-18V6z" fill="var(--neon)"/>
        <path transform="translate(27 55)" d="M12 18l5 5 9-10" stroke="var(--on-neon)" stroke-width="3" fill="none"/></g>`,
  },
];

/* ============================ показ ============================ */

function buildStories() {
  const box = document.createElement('div');
  box.className = 'stories';
  box.id = 'stories';
  box.hidden = true;
  box.innerHTML = `<div class="st-bars">${STORIES.map(() => '<span><i></i></span>').join('')}</div>
    <button class="st-close" title="Закрыть">×</button>
    <div class="st-art"></div>
    <div class="st-text"><h2></h2><p></p></div>
    <div class="st-cta"></div>`;
  document.body.append(box);

  box.querySelector('.st-close').onclick = closeStories;
  // касание: слева — назад, справа — дальше; удержание — пауза
  let downAt = 0, held = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    downAt = Date.now();
    held = setTimeout(() => box.classList.add('paused'), 220);
  });
  box.addEventListener('pointerup', (e) => {
    if (e.target.closest('button') || !downAt) return;
    clearTimeout(held);
    const long = Date.now() - downAt > 220;
    downAt = 0;
    box.classList.remove('paused');
    if (long) return;
    if (e.clientX < window.innerWidth * 0.3) showStory(App.story - 1); else showStory(App.story + 1);
  });
  box.addEventListener('pointercancel', () => { clearTimeout(held); downAt = 0; box.classList.remove('paused'); });
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowRight') showStory(App.story + 1);
    if (e.key === 'ArrowLeft') showStory(App.story - 1);
    if (e.key === 'Escape') closeStories();
  });
  return box;
}

/* firstRun — показ при первом запуске: в конце кнопка ведёт в быстрый старт. */
function openStories(firstRun) {
  const box = document.getElementById('stories') || buildStories();
  App.storiesFirstRun = !!firstRun;
  hideCard();
  box.hidden = false;
  showStory(0);
}

function showStory(i) {
  const box = document.getElementById('stories');
  if (i < 0) i = 0;
  if (i >= STORIES.length) return;  // последний экран сам не закрывается — там кнопка
  App.story = i;
  const s = STORIES[i];
  box.querySelector('.st-art').innerHTML = `<svg viewBox="0 0 300 300" font-family="Manrope, system-ui, sans-serif">${s.art()}</svg>`;
  box.querySelector('h2').textContent = s.title;
  box.querySelector('.st-text p').textContent = s.text;
  // полоски: пройденные полные, текущая заполняется, дальше пустые
  box.querySelectorAll('.st-bars span').forEach((b, k) => {
    const bar = b.firstChild;
    bar.className = k < i ? 'done' : '';
    bar.onanimationend = null;
    if (k === i) {
      void bar.offsetWidth;  // перезапуск заполнения
      bar.className = 'run';
      bar.style.animationDuration = `${STORY_MS}ms`;
      bar.onanimationend = () => showStory(i + 1);
    }
  });
  const cta = box.querySelector('.st-cta');
  cta.replaceChildren();
  if (i === STORIES.length - 1) {
    const b = document.createElement('button');
    b.className = 'card-btn big';
    b.textContent = App.storiesFirstRun ? 'Отметить, где я уже был' : 'Понятно';
    b.onclick = () => {
      const first = App.storiesFirstRun;
      closeStories(true);
      if (first) startWizard();
    };
    cta.append(b);
  }
}

/* skipWelcome — сразу идём в быстрый старт; иначе при первом запуске покажем приветствие. */
function closeStories(skipWelcome) {
  const box = document.getElementById('stories');
  if (!box) return;
  box.hidden = true;
  box.querySelectorAll('.st-bars i').forEach((b) => { b.onanimationend = null; b.className = ''; });
  saveJSON(STORIES_KEY, true);
  if (App.storiesFirstRun && skipWelcome !== true && App.open.size === 0) document.getElementById('welcome').hidden = false;
  App.storiesFirstRun = false;
}

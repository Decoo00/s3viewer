// 다국어: ko(기본)·en·ja. 언어별 글자는 lang/<언어>.json에 따로 두고 필요할 때 불러옴
// - lang/<언어>.json = { ui: {키: 글자}, categories: {무기군 id: 이름}, weapons: {'<무기군>_<file>': 이름} }
//   무기·무기군 이름은 게임 데이터(Leanny/splat3 CommonMsg/Weapon) 기준
// - 화면 글자: index.html의 data-i18n="키"(글자) / data-i18n-aria="키"(aria-label)를 applyI18n()이 채움. JS에서 바꾸는 글자는 setText(el, 키)
// - 지금 언어에 없는 키는 한국어로 (ko.json은 늘 불러 둠). en.json도 늘 불러 둠: 저장 파일 이름은 언어와 상관없이 영어 무기 이름
// - 고른 언어는 localStorage에 기억. 없으면 브라우저 언어(navigator.languages)로: ko → ko, ja → ja, 그 외 en

export const LANGS = ['ko', 'en', 'ja'];
const STORAGE_KEY = 's3viewer-lang';

const packs = {}; // 언어 → 불러온 json
const loading = {};
function loadPack(code) {
    loading[code] ??= fetch(`lang/${code}.json`).then((res) => res.json()).then((data) => { packs[code] = data; });
    return loading[code];
}

function detect() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (LANGS.includes(saved)) return saved;
    } catch { /* 저장소를 못 쓰면 브라우저 언어로 */ }
    const first = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
    return first.startsWith('ko') ? 'ko' : first.startsWith('ja') ? 'ja' : 'en';
}

export let lang = detect();
document.documentElement.lang = lang;
await Promise.all([...new Set(['ko', 'en', lang])].map(loadPack));

const lookup = (code, group, key) => packs[code]?.[group]?.[key];

// {n} 같은 자리는 t(키, { n })로 채움
export function t(key, vars) {
    let text = lookup(lang, 'ui', key) ?? lookup('ko', 'ui', key) ?? key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
    return text;
}

// 무기군 이름 (weaponData의 id)
export const categoryName = (id) => lookup(lang, 'categories', id) ?? lookup('ko', 'categories', id) ?? id;
// 무기 이름 ('<무기군>_<file>'). englishWeaponName은 저장 파일 이름용
export const weaponName = (key) => lookup(lang, 'weapons', key) ?? lookup('ko', 'weapons', key) ?? key;
export const englishWeaponName = (key) => lookup('en', 'weapons', key);

// 상태에 따라 바뀌는 글자: 키를 data-i18n에 남겨서 언어를 바꿀 때 다시 채워짐
export function setText(el, key) {
    el.dataset.i18n = key;
    el.textContent = t(key);
}

export function applyI18n(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

const listeners = [];
export const onLangChange = (fn) => listeners.push(fn);

let langSeq = 0;
export async function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    const seq = ++langSeq;
    await loadPack(next);
    if (seq !== langSeq) return; // 받는 동안 다른 언어를 고름
    lang = next;
    document.documentElement.lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* 기억만 못 함 */ }
    applyI18n();
    for (const fn of listeners) fn(lang);
}

// 좌하단 언어 선택 (국기 버튼)
const FLAGS = { ko: 'lang/kr.png', en: 'lang/us.png', ja: 'lang/jp.png' };
const LANG_NAMES = { ko: '한국어', en: 'English', ja: '日本語' }; // 각 언어의 자기 이름이라 번역하지 않음
export function mountLangPicker(container) {
    for (const code of LANGS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lang-btn';
        btn.title = LANG_NAMES[code];
        btn.setAttribute('aria-label', LANG_NAMES[code]);
        const img = document.createElement('img');
        img.src = FLAGS[code];
        img.alt = '';
        btn.appendChild(img);
        btn.onclick = () => setLang(code);
        container.appendChild(btn);
    }
    const mark = () => { for (const [i, btn] of [...container.children].entries()) btn.classList.toggle('active', LANGS[i] === lang); };
    mark();
    onLangChange(mark);
}

applyI18n();

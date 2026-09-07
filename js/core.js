// 앱 코어: 상태 보관, 라우터, 내비, 모달/토스트
import * as Store from './store.js';
import * as P from './prices.js';
import * as Sync from './sync.js';

export const state = Store.load();
export function saveNow() {
  Store.save(state);
  Sync.schedule(); // Dropbox 연결 시 3초 뒤 동기화
}

// ---- 토스트 ----
export function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---- 모달 ----
export function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-back').addEventListener('click', e => {
    if (e.target.classList.contains('modal-back')) closeModal();
  });
  return root.querySelector('.modal');
}
export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

// 확인 모달 (Promise<boolean>)
export function confirmModal({ title, body, okLabel = '확인', danger = false }) {
  return new Promise(resolve => {
    const m = openModal(`
      <h2>${title}</h2>
      <div style="font-size:14px; white-space:pre-wrap;">${body}</div>
      <div class="btn-row" style="justify-content:flex-end; margin-top:16px;">
        <button class="btn" data-x="no">취소</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${okLabel}</button>
      </div>`);
    m.querySelector('[data-x=no]').onclick = () => { closeModal(); resolve(false); };
    m.querySelector('[data-x=ok]').onclick = () => { closeModal(); resolve(true); };
  });
}

// ---- 라우터 ----
const views = {}; // name -> render fn
export function registerView(name, fn) { views[name] = fn; }

// 단색 선 아이콘 (currentColor 상속) — 하단 탭·더보기 메뉴 공용
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const ICONS = {
  home: svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/>'),
  trades: svg('<path d="M16.7 3.8l3.5 3.5L7.5 20H4v-3.5L16.7 3.8z"/>'),
  watch: svg('<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3.2z"/>'),
  diary: svg('<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8.5h6M9 12.5h6"/>'),
  more: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  worlds: svg('<path d="M4 19c8 0 8-14 16-14M4 5c8 0 8 14 16 14"/>'),
  actions: svg('<path d="M12 4.5V19M7.5 19h9M4 7.5h16"/><path d="M6 7.5l-2.3 5.5a2.6 2.6 0 004.6 0L6 7.5zM18 7.5l-2.3 5.5a2.6 2.6 0 004.6 0L18 7.5z"/>'),
  quotes: svg('<path d="M12 6.5C10 5 7 5 4 5.8V19c3-.8 6-.8 8 .7 2-1.5 5-1.5 8-.7V5.8C17 5 14 5 12 6.5z"/><path d="M12 6.5V19.7"/>'),
  letters: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/>'),
  rules: svg('<path d="M4 20h16M6 16.5V10M10 16.5V10M14 16.5V10M18 16.5V10M3.5 10h17L12 3.8 3.5 10z"/>'),
  ai: svg('<path d="M11 4.5l1.4 4.1 4.1 1.4-4.1 1.4L11 15.5l-1.4-4.1-4.1-1.4 4.1-1.4L11 4.5z"/><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>'),
  cost: svg('<circle cx="12" cy="12" r="8.3"/><path d="M9.2 15.2c.6.8 1.6 1.3 2.8 1.3 1.7 0 2.8-.9 2.8-2.2 0-2.9-5.2-1.6-5.2-4.4 0-1.2 1-2.1 2.6-2.1 1.1 0 2 .5 2.6 1.2"/><path d="M12 6.6v10.8"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.7M12 18.5v2.7M2.8 12h2.7M18.5 12h2.7M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9"/>'),
  returns: svg('<path d="M4 4v16h16"/><path d="M8 16v-4M13 16v-8M18 16v-6"/>'),
  lock: svg('<rect x="4.8" y="10.5" width="14.4" height="9.7" rx="2"/><path d="M8.2 10.5V7.6a3.8 3.8 0 017.6 0v2.9"/>'),
  // 겹쳐 쌓인 장부 = 청산하고 다시 시작한 펀드 세대
  funds: svg('<rect x="3.5" y="8.5" width="12" height="12" rx="2"/><path d="M7.5 8.5V5.5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-3"/>'),
  // 점선 장부 = 실재하지 않는 가상 펀드
  virtual: svg('<rect x="4" y="4" width="16" height="16" rx="2.5" stroke-dasharray="3 2.6"/><path d="M8.5 14.5l3-3.2 2.2 2.2 3-3.6"/>'),
};

// 모바일 하단 탭. 순서는 상단바 메뉴와 같게 유지한다(일지가 관심보다 앞).
export const NAV = [
  { id: 'home', label: '홈', ico: ICONS.home },
  { id: 'trades', label: '기록', ico: ICONS.trades },
  { id: 'diary', label: '일지', ico: ICONS.diary },
  { id: 'watch', label: '관심', ico: ICONS.watch },
  { id: 'more', label: '더보기', ico: ICONS.more },
];
// 순서 = 왼쪽부터 표시. 넘치면 뒤쪽부터 '더보기'로 접히므로, 자주 쓰는 것을 앞에 둔다.
export const NAV_DESKTOP = [
  ['home', '홈'], ['trades', '기록'], ['diary', '일지'], ['returns', '수익'], ['cost', '비용'], ['worlds', '만약'],
  ['actions', '회상'], ['virtual', '가상'], ['watch', '관심'], ['quotes', '글귀'], ['letters', '서한'], ['ai', '복기'], ['funds', '2ⁿ'], ['settings', '설정'],
];

export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || 'home';
}

export function go(route) { location.hash = '#/' + route; }

export function render() {
  const route = currentRoute();
  // 파라미터 경로 지원: "symbol/AAPL" → 뷰 'symbol', 인자 'AAPL'
  const slash = route.indexOf('/');
  const name = slash < 0 ? route : route.slice(0, slash);
  const arg = slash < 0 ? '' : decodeURIComponent(route.slice(slash + 1));
  const fn = views[name] || views.home;
  const main = document.getElementById('view');
  main.innerHTML = fn(arg);
  // 뷰별 후처리(이벤트 바인딩)
  if (fn.bind_) fn.bind_(main, arg);
  renderNav(name);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}

// 사용자가 지금 쓰고 있는 글이 있는가 (화면·모달의 입력칸 중 내용이 든 것).
function hasUnsavedInput() {
  for (const root of [document.getElementById('view'), document.getElementById('modal-root')]) {
    if (!root) continue;
    for (const el of root.querySelectorAll('textarea, input')) {
      if (el.disabled || el.readOnly || el.type === 'hidden'
          || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') continue;
      if ((el.value || '').trim() !== '') return true;
    }
  }
  return false;
}

// 사용자가 요청하지 않았는데 저절로 부르는 렌더(동기화·시세 로드)는 이걸 쓴다.
// render()는 #view를 innerHTML로 통째로 갈아엎으므로, 쓰던 글이 그 자리에서 사라진다
// (실제로 홀딩 일지를 쓰다 다른 앱에 갔다 오니 글이 날아갔다 — 돌아올 때 도는 동기화가 범인).
// 화면을 새로 그리지 않아도 state는 이미 갱신돼 있으므로, 다음에 화면을 옮기면 반영된다.
export function renderIfIdle() {
  if (hasUnsavedInput()) return false;
  render();
  return true;
}

let lastRoute = 'home';   // 리사이즈로 데스크톱 메뉴를 다시 배치할 때 쓴다
function renderNav(route) {
  lastRoute = route;
  const bn = document.getElementById('bottom-nav');
  bn.innerHTML = NAV.map(n => {
    const active = route === n.id || (n.id === 'more' && !NAV.some(x => x.id === route));
    return `<a href="#/${n.id}" class="${active ? 'active' : ''}"><span class="ico">${n.ico}</span>${n.label}</a>`;
  }).join('');
  layoutDesktopNav(route);
  document.getElementById('fund-name').textContent = state.settings.fundName || 'PROJ210';
}

// 데스크톱 메뉴: 한 줄에 들어가는 만큼만 펴고, 넘치는 항목은 끝의 '더보기' 아래로 접는다.
// 앞으로 메뉴가 더 늘어도 상단바가 한 줄을 넘지 않게 하기 위한 것(우선순위+ 오버플로).
// 한 번 그린 뒤 실제 폭을 재서 접을 개수를 정하므로, 글꼴·창 너비가 무엇이든 스스로 맞춘다.
const navLink = (id, label, route) => `<a href="#/${id}" data-nav class="${route === id ? 'active' : ''}">${label}</a>`;
function layoutDesktopNav(route) {
  const dn = document.getElementById('desktop-nav');
  if (!dn || getComputedStyle(dn).display === 'none') return; // 모바일에선 하단 탭을 쓰므로 건너뛴다

  const inner = dn.closest('.topbar-inner');
  const gap = parseFloat(getComputedStyle(inner).columnGap || getComputedStyle(inner).gap) || 18;

  // 메뉴가 쓸 수 있는 폭: 메뉴를 비운 상태에서 '메뉴 시작점 ~ 갱신버튼 시작점' 거리를 잰다.
  // 이렇게 해야 정확하다 — 메뉴를 다 펼친 채로 옆 요소(펀드명·기준시간)를 재면, 상단바가
  // 넘쳐 flex-shrink로 그 요소들이 쭈그러들어 폭이 실제보다 작게 나오고, 여유를 과대평가한다.
  dn.innerHTML = '';
  const refresh = document.getElementById('price-refresh');
  const avail = refresh.getBoundingClientRect().left - dn.getBoundingClientRect().left - gap;

  // 1차: 전부 펼쳐 각 항목의 자연 폭을 잰다 (a는 flex:none이라 넘쳐도 안 쭈그러든다)
  dn.innerHTML = NAV_DESKTOP.map(([id, label]) => navLink(id, label, route)).join('')
    + `<div class="nav-more"><button type="button" class="nav-more-btn">더보기 ▾</button></div>`;
  const widths = [...dn.querySelectorAll('a[data-nav]')].map(a => a.offsetWidth);
  const moreW = dn.querySelector('.nav-more').offsetWidth;

  const navGap = parseFloat(getComputedStyle(dn).columnGap || getComputedStyle(dn).gap) || 2;
  const SAFE = 6; // 활성화로 살짝 굵어질 여유
  const totalAll = widths.reduce((s, w) => s + w, 0) + navGap * (widths.length - 1);

  let visible = NAV_DESKTOP.length;
  if (totalAll > avail) {
    let sum = 0, k = 0;
    for (let i = 0; i < widths.length; i++) {
      const add = widths[i] + (k > 0 ? navGap : 0);
      if (sum + add + navGap + moreW + SAFE <= avail) { sum += add; k++; } else break;
    }
    visible = k;
  }

  // 2차: 보이는 항목 + (넘치면) 더보기 버튼·드롭다운으로 다시 그린다
  const shown = NAV_DESKTOP.slice(0, visible);
  const hidden = NAV_DESKTOP.slice(visible);
  let html = shown.map(([id, label]) => navLink(id, label, route)).join('');
  if (hidden.length) {
    const overflowActive = hidden.some(([id]) => id === route);
    html += `<div class="nav-more${overflowActive ? ' active' : ''}">
      <button type="button" class="nav-more-btn" aria-haspopup="true" aria-expanded="false">더보기 ▾</button>
      <div class="nav-more-panel" hidden>
        ${hidden.map(([id, label]) => navLink(id, label, route)).join('')}
      </div>
    </div>`;
  }
  dn.innerHTML = html;

  const btn = dn.querySelector('.nav-more-btn');
  if (btn) {
    const panel = dn.querySelector('.nav-more-panel');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = panel.hasAttribute('hidden');
      if (open) { panel.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
      else { panel.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
    });
    // 항목을 고르면 라우팅되며 어차피 다시 그려지지만, 즉시 닫아 깜빡임을 없앤다
    panel.querySelectorAll('a').forEach(a => a.addEventListener('click', () => panel.setAttribute('hidden', '')));
  }
}

// 사용자가 버튼으로 요청하는 즉시 시세 갱신 (상단바·설정 공용)
let refreshing = false;
// 갱신은 워크플로가 도는 40초쯤 걸린다. 버튼에 글자가 없으므로 돌려서 진행 중임을 알린다.
function setRefreshingUI(on) {
  const btn = document.getElementById('price-refresh');
  if (!btn) return;
  btn.classList.toggle('spinning', on);
  btn.disabled = on;
}
// quiet: 사용자가 누른 게 아니라 앱이 스스로 부른 경우(오늘 종가가 아직 없을 때의 자가 치유).
// 클릭 핸들러로 불리면 opts가 이벤트 객체라 quiet는 자연히 false가 된다(market도 undefined).
// market: 받을 시장('kr'|'us'|'all'). 안 주면 비어 있는 시장을 보고 알아서 정한다.
export async function triggerRefresh(opts = {}) {
  const quiet = opts && opts.quiet === true;
  const market = (opts && opts.market) || P.marketToRefresh();
  if (refreshing) return;
  if (!state.settings.ghPat || !state.settings.ghRepo) { if (!quiet) toast('설정에서 시세 저장소를 먼저 연결하세요'); return; }
  refreshing = true;
  setRefreshingUI(true);
  // 한 시장만 받으면 50초 안팎, 전 종목이면 1분 반 안팎 (실측)
  toast(quiet ? '오늘 종가를 받아오는 중 — 완료되면 자동 반영됩니다'
              : '시세 갱신을 요청했습니다 — 20초 안팎 걸립니다', 4200);

  const before = P.updatedAt()?.getTime() || 0;
  const done = (msg, ms) => { refreshing = false; setRefreshingUI(false); toast(msg, ms); };

  try {
    await P.forceRefresh(state.settings, market);
    // 옛날엔 40초 뒤 한 번만 다시 읽어서, 아직 안 끝난 옛 데이터를 보고 "갱신했습니다"라고
    // 말했다 — 눌러도 그대로인 것처럼 보인 진짜 원인. 끝날 때까지 확인하고 실제로 바뀌었을
    // 때만 알린다.
    //
    // 수집을 병렬로 바꾼 뒤 서버가 한국 6초·미국 9초·전체 11초에 끝난다(러너 뜨는 시간
    // 10초 안팎이 더 붙는다). 그런데 첫 확인이 20초, 그 뒤 15초 간격이라 이미 끝난 걸
    // 한참 뒤에 알아채고 있었다 → 12초부터 5초 간격으로 본다.
    // meta.json 한 번 받는 게 전부라(지문이 같으면 종목 파일은 요청조차 안 한다) 자주 봐도 싸다.
    const deadline = Date.now() + 240000;   // 최대 4분
    const poll = async () => {
      await P.load(state.settings);
      if ((P.updatedAt()?.getTime() || 0) > before) {   // 저장소가 실제로 새로 쌓였다
        refreshPriceStatus();
        renderIfIdle();   // 그 사이 사용자가 뭔가 쓰고 있으면 화면을 갈아엎지 않는다
        done(quiet ? '오늘 종가가 반영됐습니다' : '시세를 갱신했습니다');
        return;
      }
      if (Date.now() < deadline) { setTimeout(poll, 5000); return; }
      refreshPriceStatus();
      renderIfIdle();
      // quiet(자가 치유)는 사용자가 부른 게 아니다 — 휴장일이면 서버가 몇 초 만에 건너뛰어
      // updatedAt이 안 바뀌므로 여기로 온다. 이때 경고를 띄우면 헛알림이 되니 조용히 끝낸다.
      if (quiet) { refreshing = false; setRefreshingUI(false); return; }
      done('아직 반영되지 않았습니다 — 잠시 뒤 앱을 다시 열어 확인하세요', 4200);
    };
    setTimeout(poll, 12000);
  } catch (e) {
    done('갱신 실패: ' + (e && e.message || e), 4200);
  }
}

// 시세는 종가 기준이라 마감 시각이 정해져 있다(한국 15:30, 미국 16:00 ET=서머타임이면 05:00 KST).
// 그래서 '수집한 시각'이 아니라 시장별 '종가 기준 시각'을 보여준다(prices.closeStamps).
export function refreshPriceStatus() {
  const el = document.getElementById('price-status');
  const cs = P.closeStamps();
  const lines = [];
  if (cs.kr) lines.push(`한국 ${cs.kr}`);
  if (cs.us) lines.push(`미국 ${cs.us}`);
  if (!lines.length) { el.textContent = '시세 없음'; return; }
  el.innerHTML = `시세 기준 시각(KST)<br>${lines.join('<br>')}`;
}

// 상단바의 시세 갱신 버튼 — 어느 화면에서든 항상 같은 자리에 있다.
export function initTopbar() {
  const btn = document.getElementById('price-refresh');
  if (btn) btn.addEventListener('click', triggerRefresh);

  // 창 너비가 바뀌면 데스크톱 메뉴의 접힘 개수를 다시 계산 (디바운스)
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => layoutDesktopNav(lastRoute), 120);
  });
  // 바깥을 누르면 더보기 드롭다운을 닫는다
  document.addEventListener('click', e => {
    if (e.target.closest('.nav-more')) return;
    const p = document.querySelector('.nav-more-panel:not([hidden])');
    if (p) { p.setAttribute('hidden', ''); p.parentElement.querySelector('.nav-more-btn')?.setAttribute('aria-expanded', 'false'); }
  });
}

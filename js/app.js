// 진입점
import * as P from './prices.js';
import * as Dbx from './dropbox.js';
import * as Sync from './sync.js';
import * as Store from './store.js';
import * as Lock from './lock.js';
import { state, render, renderIfIdle, refreshPriceStatus, initTopbar, toast, triggerRefresh } from './core.js';
import './views-main.js';
import './views-insight.js';
import './views-write.js';
import './views-funds.js';
import './views-virtual.js';

async function init() {
  // Dropbox OAuth 복귀 처리
  const justConnected = await Dbx.handleCallback().catch(() => false);

  // PIN 잠금: 설정돼 있으면 맞을 때까지 화면을 가림
  if (Lock.hasPin()) await Lock.showLock();

  Sync.init({
    state,
    persist: () => Store.save(state),
    // 동기화가 실제로 바꾼 게 있을 때만 불린다. 그때도 쓰던 글이 있으면 다시 그리지 않는다.
    onApplied: () => { renderIfIdle(); },
  });

  // 원격 데이터 먼저 병합(연결돼 있으면) → 시세 → 렌더
  if (Dbx.connected()) await Sync.syncNow();

  // 시세는 기기 캐시로 먼저 그린다. 저장소 확인은 화면을 띄운 뒤 뒤에서 한다 —
  // 어제와 같은 시세를 다시 받느라 앱이 열리기를 기다릴 이유가 없다.
  // 캐시가 없는 첫 실행에서만 받을 때까지 기다린다(빈 화면을 보여주는 것보다 낫다).
  // 첫 화면이 홈이면 보유 종목·환율만 먼저 읽어 띄운다. 홈은 그것만 있으면 그려지는데
  // 96개를 다 읽느라 기다렸다(실측 156ms). 나머지는 화면이 뜬 뒤 뒤에서 채운다.
  const homeFirst = !location.hash || location.hash === '#/' || location.hash === '#/home';
  let cached = homeFirst && await P.loadCached(state.settings, { only: homePriceKeys() });
  if (!cached) cached = await P.loadCached(state.settings);
  if (!cached) await P.load(state.settings);
  if (!P.isPartial()) afterPrices();
  initTopbar();
  render();
  window.addEventListener('hashchange', render);
  if (cached) {
    // 남은 종목을 마저 읽고(부분 로드였다면) → 저장소 확인.
    // 지문이 같으면 meta.json 한 번으로 끝난다(종목 파일은 아예 요청하지 않는다).
    const rest = P.isPartial() ? P.loadCached(state.settings).then(() => { afterPrices(); renderIfIdle(); })
                               : Promise.resolve();
    rest.then(() => P.load(state.settings)).then(() => {
      afterPrices();
      renderIfIdle();   // 그 사이 사용자가 뭔가 쓰고 있으면 화면을 갈아엎지 않는다
      selfHeal();
    }).catch(() => { /* 저장소가 안 되면 캐시로 계속 쓴다 */ });
  } else {
    selfHeal();
  }
  if (justConnected) toast('Dropbox에 연결됐습니다. 이제 기기 간 동기화됩니다.');

}

// 시세는 저장소 크론이 각 시장 마감 직후 미리 받아 둔다 — 앱은 읽기만 한다.
// 다만 GitHub 예약은 정시 보장이 없어 밀리는 날이 있다(실측 최대 3시간). 그런 날 앱을 열면
// '오늘 종가가 나와 있어야 하는데 없다'를 감지해 서버 갱신을 한 번 요청해 둔다.
// 기기·시장·날짜당 1회만(localStorage). 휴장일 오탐은 서버가 몇 초 만에 걸러내므로 무해.
//
// 반드시 저장소를 확인한 뒤에 부를 것 — 기기 캐시의 옛 meta.lastClose로 판단하면
// 저장소엔 이미 오늘 종가가 있는데도 워크플로를 헛돌린다.
function selfHeal() {
  try {
    const stale = P.staleClosedMarkets();
    if (stale.length && state.settings.ghPat && state.settings.ghRepo) {
      const K = 'onefund.autoFetch';
      let done = {};
      try { done = JSON.parse(localStorage.getItem(K) || '{}'); } catch { /* 손상 무시 */ }
      const need = stale.filter(s => done[s.mkt] !== s.day);
      if (need.length) {
        for (const s of need) done[s.mkt] = s.day;
        localStorage.setItem(K, JSON.stringify(done));
        // 비어 있는 시장이 하나면 그 시장만 받는다 — 한국 종가만 없는데 미국 종목까지
        // 받으면 기다리는 시간이 세 배가 된다.
        triggerRefresh({ quiet: true, market: need.length === 1 ? need[0].mkt : 'all' });
      }
    }
  } catch { /* 자가 치유는 실패해도 조용히 — 다음 크론이 어차피 받는다 */ }
}

// 홈을 그리는 데 꼭 필요한 시세 — 지금 보유 중인 종목과 환율뿐이다.
// (평가액·수익률은 보유분만, 넣은 돈/뺀 돈은 환율만 쓴다.)
function homePriceKeys() {
  const net = new Map();
  for (const t of state.trades) net.set(t.symbol, (net.get(t.symbol) || 0) + (t.side === 'buy' ? t.qty : -t.qty));
  const keys = ['KRW=X'];
  for (const [sym, q] of net) if (Math.abs(q) > 1e-9) keys.push(sym);
  return keys;
}

// 시세를 새로 받은 뒤 늘 함께 해야 하는 것들 (첫 로드·백그라운드 갱신 공용)
function afterPrices() {
  syncNames();
  // 시세가 생긴 심볼은 미등록 목록에서 자동 제거
  const pending = state.pendingSymbols.filter(s => !P.has(s));
  if (pending.length !== state.pendingSymbols.length) {
    state.pendingSymbols = pending;
    Store.save(state);
  }
  refreshPriceStatus();
}

// 저장된 데이터의 종목명을 시세의 자동 이름(한국=한글/미국=영문)으로 맞춘다.
// 시세에 등록된 종목만 갱신하며, 이름이 실제로 바뀐 경우만 updatedAt을 올려 동기화로 전파.
function syncNames() {
  let changed = false;
  const apply = (obj, symKey, nameKey) => {
    const info = P.info(obj[symKey]);
    if (info && obj[nameKey] !== info.name) { obj[nameKey] = info.name; obj.updatedAt = Date.now(); changed = true; }
  };
  for (const t of state.trades) apply(t, 'symbol', 'name');
  for (const w of state.watchlist || []) apply(w, 'symbol', 'name');
  for (const s of state.swaps || []) { apply(s, 'fromSymbol', 'fromName'); apply(s, 'toSymbol', 'toName'); }
  // 가상 펀드의 매수 건은 펀드 안에 들어 있다 — 이름이 바뀌면 건이 아니라 '펀드'의 시각을
  // 올려야 동기화가 전파한다(병합 단위가 펀드이므로).
  for (const v of state.virtuals || []) {
    let touched = false;
    for (const p of v.positions || []) {
      const info = P.info(p.symbol);
      if (info && p.name !== info.name) { p.name = info.name; touched = true; }
    }
    if (touched) { v.updatedAt = Date.now(); changed = true; }
  }
  if (changed) { Store.save(state); Sync.schedule(); }
}

init();

// 서비스워커는 셸을 '캐시 우선'으로 주므로, 새 버전을 심어 두지 않으면 기기가 옛 코드에
// 그대로 갇힌다. 실제로 '가상' 기능이 PC에서만 보이고 폰에서는 안 보이는 일이 있었다
// — 폰이 옛 캐시를 쓰고 있어서, 새로고침해도 같은 옛 파일이 나왔기 때문.
//
// 그래서 두 가지를 한다.
//  1) 열 때마다(그리고 30분마다) 새 버전이 있는지 확인한다.
//  2) 새 버전이 제어를 넘겨받으면 그 즉시 다시 읽어 새 코드로 갈아탄다.
//     (안 그러면 이미 떠 있는 화면은 옛 코드를 계속 쓰고, 사용자가 한 번 더 새로고침해야 한다.)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;   // 첫 설치 때는 새로고침하지 않는다
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

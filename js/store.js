// 상태 저장/불러오기 (localStorage) + 예시 데이터
import { uid, todayStr, addMonthsStr } from './util.js';

const KEY = 'onefund.v1';

export const EMOTIONS = ['확신', '차분', '설렘', '조급(놓칠까 봐)', '불안', '지루함', '복구 심리'];
export const SELL_REASON_TYPES = ['계획대로', '생각이 바뀌어서', '불안·공포', '더 좋은 곳에 쓰려고', '현금이 필요해서', '기타'];

export function defaultState() {
  return {
    version: 1,
    // settings는 통째로 동기화됨 — 바꿀 때 반드시 updatedAt 갱신
    // cashLog: 직접 입력한 현금 잔액 이력 [{date, KRW, USD}] — 비어 있으면 현금 0(주식만 합산)
    settings: { fundName: 'PROJ210', inception: null, ghRepo: '', ghPat: '', cashLog: [], updatedAt: 0 },
    trades: [],      // 매매 기록
    diary: [],       // 홀딩 일지
    principles: [],  // 투자 헌법
    letters: [],     // 주주 서한
    quotes: [],      // 글귀 서랍 (책·자료에서 모은 문장)
    watchlist: [],   // 관심 종목 (안 산 판단의 기록)
    swaps: [],       // 교체 시뮬레이션 (보유 A → 관심 B 가정)
    loans: [],       // 투자용 대출(마이너스통장 등) 잔액 스냅샷 — 이자 비용 추적
    // 환전 내역(선택). 안 넣으면 앱이 매수 시점 시장 환율로 알아서 환전했다고 본다.
    // 넣으면 그 기록이 우선한다 — 실제 적용 환율과 수수료가 반영돼 원금이 정확해진다.
    // [{id, date, from:'KRW'|'USD', amount(보낸 금액, from 통화), rate(원/달러), fee(from 통화), note}]
    exchanges: [],
    // 현금 입출금. 펀드 밖으로 뺀 돈·새로 넣은 돈을 **사용자가 확정해서** 남기는 기록.
    // 이게 없으면 앱은 현금 잔액 입력값과 장부의 차이를 보고 오갔다고 '추정'할 수밖에 없는데,
    // 그 추정이 유령 유출을 만든 적이 있다. 이제 자본이 오간 판단은 이 기록만 한다.
    // [{id, date, kind:'in'|'out', cur:'KRW'|'USD', amount, note}]
    cashMoves: [],
    // 배당·이자 등 매매가 아닌 수입. 자본이 아니라 **수익**이므로 원금(넣은 돈)에 넣지 않는다.
    // 계좌에 현금으로 들어오므로 장부의 현금은 늘려 준다 — 이게 없으면 그 돈으로 산 주식이
    // '밖에서 새로 들어온 돈'으로 잘못 잡혀 원금이 부풀었다.
    // [{id, date, cur:'KRW'|'USD', amount, kind:'배당'|'이자'|'기타', symbol, name, note}]
    incomes: [],
    archives: [],    // 청산한 펀드 세대 (2ⁿ) — 아래 closeFund 참고
    // 가상 펀드: 실제로 사지 않은 종목을 "그때 샀다면" 굴려 보는 장부. 여러 개 만들 수 있다.
    // [{id, name, note, positions:[{id, symbol, name, date, price, qty}], createdAt, updatedAt}]
    // 매수만 있고 매도는 없다 — "그때 사서 지금까지 들고 있었다면"이 이 기능의 질문이므로.
    // positions를 펀드 안에 품는 이유: 동기화 병합이 id 단위라 펀드 하나가 통째로 오간다.
    // 두 기기에서 같은 펀드를 동시에 고치면 늦게 저장한 쪽이 이긴다(archives와 같은 방식).
    virtuals: [],
    deleted: {},     // tombstone: {id: 삭제시각} — 동기화 시 부활 방지
    pendingSymbols: [], // 시세 파일이 아직 없는 심볼 (기기 로컬, 동기화 안 함)
  };
}

// ---- 펀드 세대(2ⁿ): 청산과 복원 ------------------------------------------------
//
// 청산 시 보관하고 비우는 기록. 글귀 서랍(quotes)은 펀드가 아니라 책에서 온 것이라 남긴다.
// 설정(저장소·PIN·예금 가정 금리)도 앱 설정이지 펀드 기록이 아니므로 남는다.
export const FUND_COLLS = ['trades', 'diary', 'principles', 'letters', 'watchlist', 'swaps', 'loans', 'exchanges', 'cashMoves', 'incomes'];

// 지금 펀드를 청산해 archives에 넣고 장부를 비운다.
// summary는 engine.fundSummary가 청산 시점에 계산한 성적표 — 열람할 때 다시 계산하지 않는다.
export function closeFund(state, { name, from, to, note, summary, newName, newInception }) {
  const now = Date.now();
  const snapshot = {};
  for (const c of FUND_COLLS) snapshot[c] = JSON.parse(JSON.stringify(state[c] || []));
  snapshot.cashLog = JSON.parse(JSON.stringify(state.settings.cashLog || []));
  snapshot.depositRate = state.settings.depositRate ?? 3;
  snapshot.inception = state.settings.inception || null;  // 복원할 때 이 펀드의 시작일을 되돌리려고

  const ar = {
    id: uid(),
    gen: (state.archives || []).length + 1,
    name, from, to, note: note || '',
    closedAt: now, summary, snapshot,
    createdAt: now, updatedAt: now,
  };
  state.archives = [...(state.archives || []), ar];

  // 비우기 — 반드시 tombstone을 남긴다. 안 그러면 다른 기기의 Dropbox 사본이 "여긴 아직
  // 있는데?" 하며 방금 청산한 기록을 통째로 되살린다(병합은 id 단위 updatedAt 비교라
  // '로컬에서 사라졌다'를 알 방법이 tombstone밖에 없다).
  state.deleted = state.deleted || {};
  for (const c of FUND_COLLS) {
    for (const it of state[c] || []) state.deleted[it.id] = now;
    state[c] = [];
  }
  state.settings.fundName = newName || name;
  state.settings.inception = newInception || to;
  state.settings.cashLog = [];
  state.settings.updatedAt = now;
  return ar;
}

// 청산 되돌리기. 잘못 눌렀을 때를 위한 것이라, 새 펀드에 아직 아무 기록도 없을 때만 부른다.
// 되살리는 항목은 updatedAt을 지금으로 올린다 — 그래야 청산 때 찍은 tombstone(원격에도
// 퍼졌다)을 이기고 다른 기기에서도 되살아난다.
export function restoreFund(state, id) {
  const ar = (state.archives || []).find(a => a.id === id);
  if (!ar) return false;
  const now = Date.now();
  for (const c of FUND_COLLS) {
    state[c] = (ar.snapshot[c] || []).map(it => ({ ...it, updatedAt: now }));
    for (const it of state[c]) delete state.deleted?.[it.id];
  }
  state.settings.fundName = ar.name;
  state.settings.cashLog = JSON.parse(JSON.stringify(ar.snapshot.cashLog || []));
  state.settings.inception = ar.snapshot.inception || null;
  state.settings.updatedAt = now;
  state.archives = state.archives.filter(a => a.id !== id);
  state.deleted = state.deleted || {};
  state.deleted[id] = now;   // 보관본 자체도 tombstone — 다른 기기에서 부활하지 않게
  return true;
}

// 현금 잔액 입력 한 줄 기록 (같은 기준일이면 덮어쓰기). 홈·설정 양쪽이 공용으로 쓴다.
// settings는 통째로 동기화되므로 updatedAt 갱신 필수([[memo-updatedat-invariant]]).
export function setCash(state, date, krw, usd) {
  const log = (state.settings.cashLog || []).filter(x => x.date !== date);
  log.push({ date, KRW: krw, USD: usd });
  log.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  state.settings.cashLog = log;
  state.settings.updatedAt = Date.now();
}

// 삭제는 반드시 이 함수로 — tombstone을 남겨 다른 기기에서 부활하지 않게 한다
export function removeItem(state, coll, id) {
  state[coll] = state[coll].filter(x => x.id !== id);
  state.deleted = state.deleted || {};
  state.deleted[id] = Date.now();
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const st = Object.assign(defaultState(), s);
    migrate(st);
    return st;
  } catch {
    return defaultState();
  }
}

// 구버전 데이터 이전. 대출은 "잔액 변동 스냅샷(한 계좌)" → "계좌별 독립 대출"로 바뀜.
// 옛 기록은 각각 별개 계좌로 보고 date를 시작일(startDate)로, 상환일(endDate)은 비움(보유 중).
function migrate(state) {
  for (const l of state.loans || []) {
    if (l.startDate === undefined && l.date !== undefined) {
      l.startDate = l.date;
      l.name = l.name || l.kind || '대출';
      if (l.endDate === undefined) l.endDate = null;
      delete l.date;
      l.updatedAt = Date.now(); // 이전본이 동기화에서 옛 기록을 이기도록 갱신
    }
  }
  // 매수 기록에서 폐기된 필드(확신도·계획 보유기간) 제거
  for (const t of state.trades || []) {
    if (t.confidence !== undefined || t.planMonths !== undefined) {
      delete t.confidence; delete t.planMonths;
      t.updatedAt = Date.now();
    }
    if (t.sample) delete t.sample; // 예시 표시도 정리
  }
  // 현금 잔액: 단일 값(manualCash) → 날짜별 입력 이력(cashLog)으로 이전.
  // 언제 넣은 값인지 알 수 없으므로 오늘 입력한 것으로 본다(그 전 구간은 현금 0 = 주식만 합산).
  if (state.settings.manualCash) {
    const mc = state.settings.manualCash;
    if (!(state.settings.cashLog || []).length && (mc.KRW != null || mc.USD != null)) {
      state.settings.cashLog = [{ date: todayStr(), KRW: mc.KRW || 0, USD: mc.USD || 0 }];
    }
    delete state.settings.manualCash;
    state.settings.updatedAt = Date.now();
  }
  if (!state.settings.cashLog) state.settings.cashLog = [];

  // 앱을 열 때 시세 갱신을 요청하던 로직이 쓰던 키 — 그 기능이 없어졌으니 정리
  try { localStorage.removeItem('onefund.lastPriceTrigger'); } catch { /* 무시 */ }

  // 기기별로 저장하던 PIN을 동기화되는 settings로 이전
  try {
    const legacyPin = localStorage.getItem('onefund.pinHash');
    if (legacyPin) {
      if (!state.settings.pinHash) {
        state.settings.pinHash = legacyPin;
        state.settings.updatedAt = Date.now();
      }
      save(state);                              // 옛 키를 지우기 전에 반드시 영속화
      localStorage.removeItem('onefund.pinHash');
    }
  } catch { /* localStorage 접근 불가 무시 */ }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function exportJson(state) {
  return JSON.stringify(state, null, 2);
}

// 가져오기: 병합이 아니라 통째 교체(단순함 우선). 호출부에서 확인창 필수.
export function importJson(text) {
  const s = JSON.parse(text);
  if (!s || !Array.isArray(s.trades)) throw new Error('형식이 다릅니다');
  return Object.assign(defaultState(), s);
}


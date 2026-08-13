// 시세 모듈: 시세 JSON 로드 + 조회 헬퍼
// 출처 1) 비공개 GitHub 저장소(설정에 개인 토큰 등록 시) — 배포판 기본
// 출처 2) 같은 폴더의 data/ (로컬 개발용)
// closes: [ [YYYY-MM-DD, 종가, 수정종가(배당·분할 반영)] ... ] 날짜 오름차순

const map = new Map(); // symbol -> {name, currency, closes, dates[]}
let meta = null;
let source = null; // 'github' | 'local' | null

function safeName(symbol) {
  return symbol.replace(/[^A-Za-z0-9.\-]/g, '_');
}

// ---- GitHub 비공개 저장소 접근 ----
function ghReady(cfg) { return !!(cfg && cfg.ghPat && cfg.ghRepo); }

// cache:'no-cache' = '캐시를 쓰지 마라'가 아니라 '쓰기 전에 반드시 서버에 확인하라'는 뜻.
// 내용이 그대로면 304(본문 없음)라 공짜에 가깝고, 바뀌었으면 200으로 새 내용이 온다.
// 87개 파일을 매번 통째로 받지 않으면서도 최신을 보장하므로 no-store보다 이쪽이 맞다.
async function ghGet(cfg, path, raw = true) {
  const r = await fetch(`https://api.github.com/repos/${cfg.ghRepo}/contents/${path}`, {
    headers: {
      'Authorization': 'Bearer ' + cfg.ghPat,
      'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    },
    cache: 'no-cache',
  });
  if (!r.ok) throw new Error('gh ' + r.status + ' ' + path);
  return r.json();
}

function ingest(sym, d) {
  d.dates = d.closes.map(r => r[0]);
  map.set(sym, d);
}

export async function load(cfg = null) {
  // 1) 비공개 저장소
  if (ghReady(cfg)) {
    try {
      meta = await ghGet(cfg, 'data/meta.json');
      await Promise.all((meta.symbols || []).map(async sym => {
        try {
          const f = meta.files?.[sym] || safeName(sym) + '.json';
          ingest(sym, await ghGet(cfg, 'data/prices/' + f));
        } catch { /* 개별 실패 무시 */ }
      }));
      if (map.size) { source = 'github'; return source; }
    } catch { /* 로컬로 폴백 */ }
  }
  // 2) 로컬 data/
  try {
    meta = await (await fetch('data/meta.json', { cache: 'no-cache' })).json();
    await Promise.all((meta.symbols || []).map(async sym => {
      try {
        const f = meta.files?.[sym] || safeName(sym) + '.json';
        const d = await (await fetch('data/prices/' + f, { cache: 'no-cache' })).json();
        ingest(sym, d);
      } catch { /* 개별 실패 무시 */ }
    }));
    if (map.size) { source = 'local'; return source; }
  } catch { meta = null; }
  return null;
}

export const loadedFrom = () => source;

// GitHub 연결 확인 (설정 화면용)
export async function ghTest(cfg) {
  if (!ghReady(cfg)) return { ok: false, msg: '저장소와 토큰을 입력하세요' };
  try {
    const m = await ghGet(cfg, 'data/meta.json');
    return { ok: true, msg: `연결됨 — 종목 ${ (m.symbols || []).length }개` };
  } catch (e) {
    return { ok: false, msg: '연결 실패 (' + e.message + ')' };
  }
}

// 시세 갱신 워크플로 즉시 실행 요청 (실패해도 다음 정기 갱신에 포함되므로 무시)
// market: 'kr'|'us'면 그 시장 종목만 받는다 — 한국 종가만 없는데 미국 종목까지 받으면
// 기다리는 시간이 세 배가 된다(실측: 전체 88종목 71초 vs 한국 27종목 36초).
async function dispatchRefresh(cfg, market = 'all') {
  await fetch(`https://api.github.com/repos/${cfg.ghRepo}/actions/workflows/prices.yml/dispatches`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.ghPat, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { market } }),
  });
}

// 새 종목을 비공개 저장소 tickers.json에 추가하고 시세 갱신 워크플로 실행
export async function registerTicker(cfg, symbol) {
  if (!ghReady(cfg)) throw new Error('GitHub 설정 없음');
  const cur = await ghGet(cfg, 'data/tickers.json', false); // {content(base64), sha}
  const text = new TextDecoder().decode(Uint8Array.from(atob(cur.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
  const j = JSON.parse(text);
  j.symbols = j.symbols || [];
  if (!j.symbols.includes(symbol)) {
    j.symbols.push(symbol);
    const body = JSON.stringify(j, null, 2);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
    const put = await fetch(`https://api.github.com/repos/${cfg.ghRepo}/contents/data/tickers.json`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + cfg.ghPat, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `티커 추가: ${symbol}`, content: b64, sha: cur.sha }),
    });
    if (!put.ok) throw new Error('tickers.json 갱신 실패 ' + put.status);
  }
  try { await dispatchRefresh(cfg); } catch { /* cron이 처리 */ }
}

// 시세 갱신은 앱이 아니라 저장소의 크론이 한다 — 한국·미국이 각각 마감한 직후 하루 한 번씩,
// 휴장일은 건너뛰고(시장 판정·휴장일 캘린더는 PROJ210-data의 scripts/fetch_prices.py에 있다).
// 앱을 열 때 갱신을 요청하던 로직은 제거했다: 실시간 시세가 필요하지 않은데 열 때마다
// Actions를 돌려 한도를 갉아먹었고, 기기별 쓰로틀이라 PC·폰을 같이 열면 중복 실행됐다.
// 사용자가 지금 당장 받고 싶으면 상단바의 갱신 버튼(forceRefresh)을 누르면 된다.
export async function forceRefresh(cfg, market = 'all') {
  if (!ghReady(cfg)) throw new Error('시세 저장소가 설정되지 않았습니다');
  await dispatchRefresh(cfg, market);
}

// 지금 요청한다면 어느 시장을 받아야 하나 — 'kr'|'us'|'all'.
// 한쪽 시장 종가만 비어 있으면 그 시장만 받는다(그만큼 빨리 끝난다).
// 양쪽 다 비었거나 아무 데도 안 비었으면(사용자가 그냥 눌러 본 경우) 전체를 받는다.
export function marketToRefresh() {
  const stale = staleClosedMarkets();
  return stale.length === 1 ? stale[0].mkt : 'all';
}

export const has = sym => map.has(sym);
export const symbols = () => [...map.keys()];
export const updatedAt = () => meta?.updatedAt ? new Date(meta.updatedAt * 1000) : null;

// 시장 구분: 한국(.KS/.KQ) vs 미국(그 외). 지수(^)·환율(KRW=X)은 호출 전에 걸러 쓴다.
function marketOf(sym) { return /\.(KS|KQ)$/.test(sym) ? 'kr' : 'us'; }

const CLOSE_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// 시세(종가) 기준 시각 — 수집 시각(meta.updatedAt)이 아니라 '종가가 찍히는 정해진 시각'.
// 종가는 시장별로 마감 시각이 고정돼 있으므로 봉 날짜 + 고정 마감시각으로 계산한다.
//   - 한국: 그 거래일 15:30 KST
//   - 미국: 그 거래일 16:00 ET → 파일의 gmtoffset로 서머타임 판별해 KST로 (05:00/06:00 다음날)
// 반환: { kr:'YYYY-MM-DD HH:MM', us:'…' } — 해당 시장 종목이 없으면 그 키는 없다.
export function closeStamps() {
  const latest = {}; // 'kr'|'us' -> {date, gmtoffset}
  for (const [sym, d] of map) {
    if (sym === 'KRW=X' || sym.startsWith('^')) continue; // 환율·지수는 마감시각이 달라 제외
    if (!d.closes?.length) continue;
    const date = d.closes[d.closes.length - 1][0];
    const mk = marketOf(sym);
    if (!latest[mk] || date > latest[mk].date) latest[mk] = { date, gmtoffset: d.gmtoffset };
  }
  const out = {};
  if (latest.kr) out.kr = `${latest.kr.date} 15:30`; // 한국 종가는 15:30 KST (거래일 = KST 날짜)
  if (latest.us) {
    // 미국 16:00 ET를 UTC로: 'date 16:00'을 UTC로 읽은 뒤 gmtoffset만큼 되돌린다
    const off = latest.us.gmtoffset ?? -14400; // 미상이면 서머타임(-4h) 가정
    const utcMs = Date.parse(`${latest.us.date}T16:00:00Z`) - off * 1000;
    out.us = CLOSE_FMT.format(new Date(utcMs)).replace('T', ' ');
  }
  return out;
}

export function info(sym) {
  const d = map.get(sym);
  return d ? { name: d.name, currency: d.currency } : null;
}

// 시세가 멈춘 종목(거래정지·상장폐지)이면 멈춘 날짜, 정상이면 null.
// 멈춘 종가를 '현재가'로 쓴 수익률은 사실이 아니므로 화면에서 표시해 경고한다.
export function frozenSince(sym) {
  return map.get(sym)?.frozenSince || null;
}

// ---- 자가 치유: '오늘 마감 종가가 나와 있어야 하는데 없는' 시장 찾기 ------------------
// 서버 크론이 밀렸을 때, 앱이 열린 김에 서버 갱신을 한 번 요청하기 위한 판정.
// 휴장일 캘린더는 서버 스크립트만 안다 → 여기선 요일·시각만 본다. 휴장일엔 오탐이 나지만
// 워크플로가 '휴장'으로 몇 초 만에 끝나므로 비용이 없다.
const MKT_TZ = { kr: 'Asia/Seoul', us: 'America/New_York' };
const MKT_AFTER = { kr: 15 * 60 + 40, us: 16 * 60 + 10 }; // 마감 +10분 (그 시장 현지 시각, 분)

// 그 시간대의 현재 날짜·시각·요일. Intl이 서머타임을 알아서 처리한다(미국 16:00 마감 판정용).
function nowIn(tz, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday,
  };
}

// now·lastClose를 주입할 수 있게 한 것은 시험용 — 실제 호출은 인자 없이 한다.
export function staleClosedMarkets({ now = new Date(), lastClose = meta?.lastClose || {} } = {}) {
  const out = [];
  for (const mkt of ['kr', 'us']) {
    const n = nowIn(MKT_TZ[mkt], now);
    if (n.weekday === 'Sat' || n.weekday === 'Sun') continue;
    if (n.minutes < MKT_AFTER[mkt]) continue;   // 아직 그 시장 마감 전
    if (lastClose[mkt] === n.date) continue;    // 오늘 종가는 이미 받아 뒀다
    out.push({ mkt, day: n.date });
  }
  return out;
}

// dates에서 target 이하의 마지막 인덱스 (이진 탐색)
function idxOn(d, target) {
  const a = d.dates;
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function rowOn(sym, date) {
  const d = map.get(sym);
  if (!d) return null;
  const i = idxOn(d, date);
  return i < 0 ? null : d.closes[i];
}

export function closeOn(sym, date) { const r = rowOn(sym, date); return r ? r[1] : null; }
export function adjOn(sym, date) { const r = rowOn(sym, date); return r ? r[2] : null; }

// 마지막 시세의 거래소 현지 시각 'HH:MM'(24시간). 시세 시각이 마지막 봉의 날짜와 다르면
// (야후가 그날 봉을 빠뜨려 옛 봉을 들고 있는 경우) 시간을 붙이면 거짓이 되므로 null.
// 날짜(closes[0])도 거래소 현지 기준이라 시간도 같은 기준으로 맞춘다 — 미국 종목은 16:00 ET.
function quoteHM(d, lastDate) {
  if (!d.quoteTime) return null;
  const s = new Date((d.quoteTime + (d.gmtoffset || 0)) * 1000).toISOString();
  return s.slice(0, 10) === lastDate ? s.slice(11, 16) : null;
}

export function last(sym) {
  const d = map.get(sym);
  if (!d || !d.closes.length) return null;
  const r = d.closes[d.closes.length - 1];
  return { date: r[0], close: r[1], adj: r[2], time: quoteHM(d, r[0]) };
}

// "2026-07-16 15:30" (시각을 모르면 날짜만) — 거래소 현지 기준
export function lastStamp(sym) {
  const l = last(sym);
  return l ? l.date + (l.time ? ' ' + l.time : '') : null;
}
export function firstDate(sym) {
  const d = map.get(sym);
  return d?.closes.length ? d.closes[0][0] : null;
}

// 최근 months개월(달력 기준)의 수정종가 (보유 종목 표의 추세 스파크라인용). 기본 1년.
// 개수(예전 120봉)가 아니라 날짜로 자른다 — "최근 1년"이 사용자에게 더 명확하다.
// 마지막 봉 날짜를 기준으로 하므로 거래정지·상장폐지 종목도 마지막 1년치가 나온다.
// 수정종가를 쓰는 이유: 액면분할·병합이 있으면 원종가는 그 지점에서 뚝 끊겨 가짜 급락처럼 보인다.
export function recentAdj(sym, months = 12) {
  const d = map.get(sym);
  if (!d || !d.closes.length) return [];
  const last = d.closes[d.closes.length - 1][0];              // 'YYYY-MM-DD'
  const [y, m, day] = last.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - months, day));
  const from = dt.toISOString().slice(0, 10);
  return d.closes.filter(r => r[0] >= from).map(r => r[2]).filter(v => v != null && isFinite(v));
}

// from 이후의 (날짜, 종가) 계열 — 종목 상세의 주가 차트용.
// 실제 종가(수정 전)를 쓴다: 툴팁의 '당시 주가'와 내가 기록한 매매가가 맞아떨어져야 하므로.
// 대신 그 구간에 액면분할이 있으면 선이 뚝 끊긴다 → split 플래그로 알려 화면에서 안내한다.
export function seriesFrom(sym, from = null) {
  const d = map.get(sym);
  if (!d || !d.closes.length) return { labels: [], values: [], split: false };
  const rows = d.closes.filter(r => (!from || r[0] >= from) && r[1] != null && isFinite(r[1]));
  // 원종가/수정종가 비율이 구간 안에서 크게 달라지면 분할·병합이 있었다는 뜻
  let split = false;
  if (rows.length > 1) {
    const ratio = r => (r[2] && r[1]) ? r[2] / r[1] : null;
    const a = ratio(rows[0]), b = ratio(rows[rows.length - 1]);
    if (a && b && Math.abs(Math.log(b / a)) > Math.log(1.5)) split = true;
  }
  return { labels: rows.map(r => r[0]), values: rows.map(r => r[1]), split };
}

// 배당·분할 반영 성장배수. to 생략 시 최신까지.
export function growth(sym, from, to = null) {
  const a = adjOn(sym, from);
  const b = to ? adjOn(sym, to) : last(sym)?.adj;
  if (!a || !b) return null;
  return b / a;
}

// 원/달러 환율 (해당일 이하 마지막)
export function fxOn(date = null) {
  const r = date ? rowOn('KRW=X', date) : (last('KRW=X') && [null, last('KRW=X').close]);
  return r ? r[1] : null;
}

export function toKRW(amount, currency, date = null) {
  if (amount == null) return null;
  if (currency === 'USD') {
    const fx = fxOn(date);
    return fx ? amount * fx : null;
  }
  return amount;
}

// 한국 종목 코드인가 — 6자리 숫자(005930), 또는 숫자로 시작하는 6자리 영숫자(0167A0).
// 후자는 KRX가 새로 쓰는 형식(ETF·신주 등)이라 숫자만 보면 놓친다. 실제로 0167A0을
// 그대로 야후에 보내 404가 났고, 시세가 없어 평가가 통째로 계산되지 않았다.
export const KR_CODE = /^\d{4}[0-9A-Z]{2}$/;

// KR 코드 → 실제 심볼 추정 (.KS / .KQ). 시세 파일이 있으면 그걸 우선.
//
// 주의: 미등록 코드는 .KS로 찍는데 이게 늘 맞지는 않는다. 야후는 코스닥 종목의 .KS
// 형태에도 응답하지만 최근 며칠짜리 껍데기 계열을 준다(099190.KS는 7봉). 이름은 정상으로
// 나와 겉보기엔 멀쩡하고, 과거 매수일의 시세만 없어 평가가 조용히 비는 함정이 있다.
// 그래서 첫 봉(firstDate)이 매수일보다 뒤면 화면에서 따로 알린다(engine.virtualRows의 noHistory).
export function resolveSymbol(input) {
  const s = input.trim().toUpperCase();
  if (!s) return null;
  if (map.has(s)) return s;
  if (KR_CODE.test(s)) {
    if (map.has(s + '.KS')) return s + '.KS';
    if (map.has(s + '.KQ')) return s + '.KQ';
    return s + '.KS'; // 미등록이면 일단 코스피로 추정
  }
  return s;
}

// 이 입력이 "어느 시장인지" 사용자에게 물어야 하는가.
// 겉모습만으로는 코스피와 코스닥을 가릴 수 없다. 추정으로 .KS를 붙였다가 코스닥 종목을
// 코스피로 찍으면, 야후가 404 대신 최근 며칠짜리 껍데기를 주기 때문에 이름은 멀쩡하게
// 나오면서 과거 시세만 조용히 비어 평가가 통째로 어긋난다 — 실제로 겪은 함정이라
// 이제는 추정하지 않고 묻는다.
export function needsMarket(input) {
  const s = (input || '').trim().toUpperCase();
  if (!s) return false;
  if (/\.(KS|KQ)$/.test(s)) return false;                     // 이미 시장이 붙어 있다
  if (map.has(s) || map.has(s + '.KS') || map.has(s + '.KQ')) return false; // 이미 아는 종목
  return true;
}

// 사용자가 고른 시장을 붙여 최종 심볼을 만든다. market: 'KS' | 'KQ' | 'US' | ''(미선택)
export function applyMarket(input, market) {
  const s = (input || '').trim().toUpperCase();
  if (!s) return null;
  const bare = s.replace(/\.(KS|KQ)$/, '');
  if (market === 'KS' || market === 'KQ') return bare + '.' + market;
  if (market === 'US') return bare;
  return resolveSymbol(s);
}

export function currencyOf(sym) {
  const d = map.get(sym);
  if (d) return d.currency;
  return /\.(KS|KQ)$/.test(sym) ? 'KRW' : 'USD';
}

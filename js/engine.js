// 계산 엔진: 포트폴리오, 평행우주, 개입 점수, 헌법 검사, 서한/AI 데이터 팩
//
// 회계 가정(단순함을 위해 고정, UI에 명시):
//  - 평가액 = 그 시점 보유 주식 + 그 시점 현금. 현금은 사용자가 직접 입력한 값만 쓴다
//    (settings.cashLog). 매도 대금을 앱이 현금으로 추정하지 않는다 — 실제 계좌 잔액은
//    입출금·환전·이자 때문에 앱이 알 수 없고, 추정치를 자산에 얹으면 거짓말이 된다.
//  - 보유분 평가는 수정종가(배당·분할·병합 반영) 성장배수 × 매수원가. 즉 배당 재투자 가정.
//  - 달러 자산은 해당일 환율로 원화 환산.

import * as P from './prices.js';
import { addMonthsStr, addDaysStr, todayStr, daysBetween, quarterRange, prevQuarter, quarterOf, fmtMoney, fmtPct } from './util.js';

export function sortedTrades(state) {
  return [...state.trades].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt - b.createdAt));
}

function unitCost(buy) {
  return (buy.price * buy.qty + (buy.fee || 0)) / buy.qty;
}

// 그 거래에 '실제로 적용된' 환율로 원화 환산. t.fx는 증권사 체결 환율(스프레드 포함)이며
// 임포트 때 주문내역의 원화·달러 금액에서 역산해 넣는다. 없으면 시장 환율로 대체한다.
// 시장 중간환율로 환산하면 증권사 실현손익과 몇 %씩 어긋난다(스프레드가 빠지므로).
export function tradeKRW(t, amount) {
  const cur = P.currencyOf(t.symbol);
  if (cur !== 'KRW' && t.fx) return amount * t.fx;
  return P.toKRW(amount, cur, t.date) || 0;
}

// 매매 재생: upto 날짜까지의 보유분과 실현 손익
//
// 원가는 **이동평균법**으로 매긴다 — 증권사(토스)와 같은 방식이다.
// 살 때마다 평균 단가를 다시 내고, **팔아도 평균 단가는 그대로**다.
// 선입선출로 하면 싼 것부터 없어져 판 뒤에 평균 단가가 뛴다(VIAV가 $32.99 → $39.07로
// 보였던 이유). 같은 주식을 몇 주 남겼느냐에 따라 '내 매입가'가 달라지는 건 사용자가
// 계좌에서 보는 숫자와 어긋난다.
//
// 다만 lot(언제 산 것인가)은 선입선출로 계속 추적한다. 평가액을 '매수일 대비 수정종가
// 성장배수'로 내기 때문에 날짜가 필요하고(배당·액면분할 반영), 매수 다리의 환율 환산도
// 그 날짜로 하기 때문이다. 원가만 이동평균으로 바꾸고, 날짜 정보는 그대로 쓴다.
export function replay(trades, upto = null) {
  const open = [];       // {t, qtyLeft} — 날짜·환율용 (원가는 아래 avg가 정한다)
  const realized = [];   // {sell, parts, costSum, costFifo, proceeds, pnl, ret, holdDays}
  const avg = new Map(); // 심볼 -> {qty, cost} 이동평균 상태 (cost = 평균단가 × 수량)

  for (const t of trades) {
    if (upto && t.date > upto) break;
    const a = avg.get(t.symbol) || { qty: 0, cost: 0 };
    if (t.side === 'buy') {
      open.push({ t, qtyLeft: t.qty });
      a.qty += t.qty;
      a.cost += t.price * t.qty + (t.fee || 0);   // 수수료는 매입 원가에 포함
      avg.set(t.symbol, a);
    } else {
      const unitAvg = a.qty > 0 ? a.cost / a.qty : 0;
      let need = t.qty, costFifo = 0, wDays = 0;
      const parts = [];
      for (const lot of open) {
        if (lot.t.symbol !== t.symbol || lot.qtyLeft <= 0) continue;
        const take = Math.min(need, lot.qtyLeft);
        lot.qtyLeft -= take; need -= take;
        costFifo += unitCost(lot.t) * take;
        wDays += daysBetween(lot.t.date, t.date) * take;
        parts.push({ buy: lot.t, qty: take });
        if (need <= 0) break;
      }
      const matched = t.qty - need;
      const costSum = unitAvg * matched;          // 이동평균 원가
      const proceeds = t.price * t.qty - (t.fee || 0);
      // 판 만큼 수량만 줄인다 — 평균 단가는 그대로(이동평균법의 핵심)
      a.qty = Math.max(0, a.qty - t.qty);
      a.cost = unitAvg * a.qty;
      if (a.qty <= 0.000001) { a.qty = 0; a.cost = 0; }   // 전량 매도 → 다음 매수부터 새로
      avg.set(t.symbol, a);
      realized.push({
        sell: t, parts, costSum, costFifo, proceeds,
        pnl: proceeds - costSum,
        ret: costSum > 0 ? (proceeds - costSum) / costSum : null,
        holdDays: matched > 0 ? wDays / matched : null,
        oversold: need > 0.000001,
      });
    }
  }
  return { open: open.filter(l => l.qtyLeft > 0.000001), realized, avg };
}

// 지금 이 종목의 이동평균 매입 단가 (없으면 null)
export function avgUnitCost(state, symbol, date = null) {
  const { avg } = replay(sortedTrades(state), date);
  const a = avg.get(symbol);
  return a && a.qty > 0 ? a.cost / a.qty : null;
}

export function heldQty(state, symbol, date) {
  const { open } = replay(sortedTrades(state), date);
  return open.filter(l => l.t.symbol === symbol).reduce((s, l) => s + l.qtyLeft, 0);
}

// lot의 특정일 평가액(자기 통화). 시세 없으면 원가 유지.
function lotValue(lot, date) {
  const sym = lot.t.symbol;
  const d = date || todayStr();               // closeOn은 null 날짜를 모른다 — 반드시 채워서 넘긴다
  const cost = unitCost(lot.t) * lot.qtyLeft;
  const now = P.closeOn(sym, d);              // 평가 시점 종가
  const then = P.closeOn(sym, lot.t.date);    // 매수일 종가
  const g = P.growth(sym, lot.t.date, d);     // 배당·분할 반영 성장배수

  // 기본은 **보유 수량 × 현재가** — 증권사가 보여 주는 값이고, 체결가가 그날 종가와 다른
  // 보통의 경우에 정확하다. 원가 × 성장배수로 계산하면 그 차이만큼 어긋난다
  // (VIAV를 $39.74에 샀는데 그날 종가는 $40.70이라 평가액이 1% 낮게 나왔다).
  let value = now != null ? lot.qtyLeft * now : cost;
  let hasPrice = now != null;

  // 다만 액면분할이 있었으면 기록된 수량이 옛 기준이라 그대로 곱하면 틀린다. 야후는 과거
  // 종가를 분할 기준으로 소급 조정하므로, 내 체결가가 그날 종가와 '배수'만큼 벌어져 있으면
  // 분할로 보고 성장배수 방식으로 되돌린다 — 그쪽은 수량 변화를 자동으로 흡수한다.
  // (체결가와 종가의 평범한 차이는 몇 %라 1.5배 문턱에 걸리지 않는다.)
  if (g != null && then > 0 && lot.t.price > 0) {
    const ratio = lot.t.price / then;
    if (ratio > 1.5 || ratio < 1 / 1.5) { value = cost * g; hasPrice = true; }
  }

  // 매입액의 원화 환산은 '살 때 실제 적용된 환율'로 (평가액은 그 시점 시장 환율).
  return { cur: P.currencyOf(sym), cost, costKRW: tradeKRW(lot.t, cost), value, hasPrice };
}

// ---- 자금 원장: 밖에서 새로 들여온(내간) 돈만 골라낸다 --------------------------
//
// pool = 앱이 설명할 수 있는 현금 = 매도 대금 중 아직 재매수에 안 쓴 것. 계좌의 실제 현금
// 잔액이 아니다(사용자가 뺐을 수도, 더 넣었을 수도 있으니). 자산으로 쓰지 말 것.
//
// 규칙:
//  - 매수: 같은 통화의 pool로 먼저 충당 → 나머지가 새 돈. 팔고 다시 사는 게 원금을 안 부풀린다.
//  - 매도: 대금이 pool에 쌓인다.
//  - 현금 입력: **사용자가 선언한 잔액이 진실이다.** 장부(pool)와 다르면 그 차액이 밖에서
//    들어온(나간) 돈이므로 원금에 더한다(뺀다). 그리고 pool을 선언값으로 맞춘다.
//    이걸 안 하면 입금해 두고 아직 안 산 돈이 원금엔 안 잡힌 채 평가액에만 더해져 수익률이
//    부풀려진다(1000만 입금해 500만만 사고 500만을 현금으로 넣으면 +100%로 나왔다).
//    pool을 맞춰 두므로, 그 현금으로 나중에 사는 것도 새 돈으로 잘못 세지 않는다.
//
// 현금 입력은 그날 장 마감 기준으로 본다 → 같은 날 매매를 다 처리한 뒤에 반영한다.
export function capitalLedger(state, upto = null) {
  const trades = sortedTrades(state);
  const pool = { KRW: 0, USD: 0 };
  const netCap = { KRW: 0, USD: 0 };
  // 밖에서 들어온(나간) 돈 [{date, cur, amt, amtKRW, src}] — 평행우주가 쓴다.
  // src: 'trade'=매수에 새로 든 돈 / 'cash'=현금 입력이 장부와 달라 생긴 조정.
  // 'cash'가 붙은 건은 한 번에 크게 튀어 그래프에서 이유 없는 절벽처럼 보이므로 화면에서 설명한다.
  // 총량 흐름 — 순액(netCap)만으로는 "실제 얼마 넣고 얼마 뺐나"를 알 수 없다.
  // 출금하면 netCap이 줄어 수익률의 분모가 작아지고, 그러면 실력과 무관하게 수익률이
  // 부풀려진다(달러가 +108%로 나온 이유). 그래서 들어온 돈과 나간 돈을 따로 센다.
  //   ext*  = 펀드 밖에서 오간 진짜 자본
  //   xfer* = 통화 사이 이동(환전). 그 통화 기준으론 들어오고 나간 돈이지만,
  //           합산 기준으론 펀드 안에서 옮긴 것이라 자본이 아니다.
  const flow = { KRW: { extIn: 0, extOut: 0, xferIn: 0, xferOut: 0 },
                 USD: { extIn: 0, extOut: 0, xferIn: 0, xferOut: 0 } };
  const events = [];
  const entries = cashLog(state).filter(e => !upto || e.date <= upto);
  const fxs = exchangeLog(state).filter(x => !upto || x.date <= upto);
  const moves = cashMoveLog(state).filter(m => !upto || m.date <= upto);
  const incs = incomeLog(state).filter(r => !upto || r.date <= upto);

  const push = (date, cur, amt, src) => {
    if (Math.abs(amt) > 1e-9) events.push({ date, cur, amt, amtKRW: P.toKRW(amt, cur, date) || 0, src });
  };

  // 사용자가 적어 둔 환전 한 건을 반영한다.
  //
  // 환전은 새 돈이 아니라 **통화 사이의 이동**이므로 나간 통화의 원금을 줄이고 들어온 통화의
  // 원금을 늘린다(아래 매수 시 자동 환전과 같은 원칙). 다른 점은 두 가지다.
  // 다른 점은 환율이 시장 중간값이 아니라 **실제 적용 환율**이라는 것(스프레드 포함).
  //
  // '보낸 금액'은 증권사 화면에 찍힌 그대로 — **수수료가 이미 포함된 금액**이다. 그래서
  // 따로 빼지 않는다. 수수료(x.fee)는 "얼마를 냈는가"를 남겨 두는 참고용 기록일 뿐
  // 계산에 쓰지 않는다 — 적용 환율에 이미 녹아 있어 또 빼면 두 번 빼는 셈이 된다.
  const applyExchange = (x) => {
    const from = x.from === 'USD' ? 'USD' : 'KRW';
    const to = from === 'KRW' ? 'USD' : 'KRW';
    const rate = Number(x.rate) || 0;
    if (!(rate > 0)) return;
    const sent = Math.max(0, Number(x.amount) || 0);
    const net = sent;
    const got = from === 'KRW' ? net / rate : net * rate;

    // 장부에 그 돈이 없으면 밖에서 새로 들여와 환전한 것이다 → 그만큼은 새 외부 자금
    const avail = Math.max(0, pool[from]);
    const fromPool = Math.min(avail, sent);
    const ext = sent - fromPool;
    if (ext > 1e-9) { netCap[from] += ext; flow[from].extIn += ext; push(x.date, from, ext, 'trade'); }

    pool[from] = avail - fromPool;
    pool[to] += got;
    netCap[from] -= net;
    netCap[to] += got;
    flow[from].xferOut += net;
    flow[to].xferIn += got;
  };
  // 첫 현금 입력은 '자본 이동'이 아니라 '기준 맞추기'다.
  //
  // 그전까지 앱은 실제 잔액을 모른 채 매도 대금만 쌓아 추측한다(pool). 처음으로 실제 잔액을
  // 알려 준 날, 그 추측과의 차이를 '그날 돈이 오갔다'로 기록하면 그건 사실이 아니다 —
  // 그날 움직인 게 아니라 그날 비로소 진실을 알게 된 것이고, 차이는 그 이전 아무 때나 생긴
  // 것이기 때문이다. 그래서 첫 입력은 장부만 실제 값에 맞추고 자본에는 손대지 않는다.
  //
  // 실제로 이 처리가 없을 때, 펀드에서 제외한 종목(FPS·SIMO)에 쓴 돈이 전부 첫 입력일 하루에
  // 뭉쳐 '순유출 610만원'이라는 없는 사건으로 나타났다. 그 종목들의 매매 기록은 지웠는데
  // 그 돈만 유령처럼 남은 셈이라 — 들어온 기록 없이 나간 기록만 있는 비대칭이었다.
  //
  // 그리고 **모든** 현금 입력을 그렇게 다룬다. 잔액이 장부보다 적다고 해서 그게 인출인지,
  // 기록하지 않은 수수료·배당·세금 때문인지 앱은 알 수 없다. 추정으로 자본을 움직이면
  // 없는 사건이 만들어진다. 그래서 현금 입력은 '장부를 실제 값에 맞추는 일'만 하고,
  // 자본이 오갔다는 판단은 사용자가 남긴 입출금 기록(cashMoves)만 한다.
  const applyCashEntry = (e) => {
    for (const cur of ['KRW', 'USD']) pool[cur] = e[cur] || 0;
  };

  // 배당·이자는 **자본이 아니라 수익**이다. 장부의 현금만 늘리고 netCap·flow에는 손대지 않는다.
  // 그래야 원금(넣은 돈)이 부풀지 않으면서, 그 돈으로 산 주식이 '밖에서 들어온 돈'으로
  // 잘못 잡히지도 않는다. 수익률에는 평가액을 통해 저절로 반영된다.
  const applyIncome = (r) => {
    const cur = r.cur === 'USD' ? 'USD' : 'KRW';
    pool[cur] += Math.max(0, Number(r.amount) || 0);
  };

  // 사용자가 확정한 입출금. 이것만이 현금 쪽 자본 이동의 근거다.
  //
  // capital === false 이면 **계좌를 거쳐 갔을 뿐 내 자본이 아닌 돈**이다(남의 돈을 잠시
  // 맡아 굴리는 경우). 계좌에 실제로 있었으므로 장부의 현금은 늘리되, 원금·출금에는
  // 넣지 않는다. 이게 없으면 그 돈으로 결제된 내 매수가 '밖에서 새로 들어온 돈'으로
  // 잡혀 원금이 부풀었다 — 2026-08-05 매수 $293이 실제로 그랬다.
  const applyMove = (mv) => {
    const cur = mv.cur === 'USD' ? 'USD' : 'KRW';
    const amt = Math.max(0, Number(mv.amount) || 0);
    if (amt <= 0) return;
    const signed = mv.kind === 'out' ? -amt : amt;
    pool[cur] += signed;
    if (mv.capital === false) return;          // 남의 돈 — 자본으로 세지 않는다
    netCap[cur] += signed;
    if (signed > 0) flow[cur].extIn += amt; else flow[cur].extOut += amt;
    push(mv.date, cur, signed, 'cash');
  };

  const applyTrade = (t) => {
    const cur = P.currencyOf(t.symbol);
    if (t.side === 'buy') {
      const cost = t.price * t.qty + (t.fee || 0);
      const fromPool = Math.min(Math.max(0, pool[cur]), cost);
      pool[cur] -= fromPool;
      let short = cost - fromPool;

      // 같은 통화로 모자라면 다른 통화 장부에서 그날 환율로 끌어다 쓴다.
      // 증권사(통합증거금)가 실제로 하는 일이다 — 한국 주식을 판 원화로 미국 주식을 산다.
      // 이걸 모르면 앱은 그 매수를 '밖에서 새로 들어온 돈'으로 세고, 쓰인 원화는 장부에
      // 계속 남아 있다가 현금을 입력하는 날 '나간 돈'으로 둔갑한다(같은 돈을 두 번 잘못 셈).
      //
      // 환전은 새 돈이 아니라 **슬리브 사이의 이동**이다. 그래서 외부 자금 사건(push)을
      // 만들지 않고, 나간 통화의 원금을 줄이고 들어온 통화의 원금을 늘린다. 그래야 각 통화의
      // 원금이 '그 통화에 실제로 잠긴 돈'과 맞아 수익률이 통화별로 정직해진다.
      if (short > 1e-9) {
        const other = cur === 'KRW' ? 'USD' : 'KRW';
        const fx = P.fxOn(t.date);   // 원/달러
        if (fx > 0 && pool[other] > 1e-9) {
          const needOther = cur === 'USD' ? short * fx : short / fx;
          const useOther = Math.min(pool[other], needOther);
          const gotCur = cur === 'USD' ? useOther / fx : useOther * fx;
          pool[other] -= useOther;
          short = Math.max(0, short - gotCur);
          netCap[other] -= useOther;
          netCap[cur] += gotCur;
          flow[other].xferOut += useOther;
          flow[cur].xferIn += gotCur;
        }
      }

      netCap[cur] += short;
      if (short > 1e-9) flow[cur].extIn += short;
      push(t.date, cur, short, 'trade');
    } else {
      pool[cur] += t.price * t.qty - (t.fee || 0);
    }
  };

  // 네 갈래(매매·환전·입출금·현금 입력)를 **한 줄로 세워 날짜 순으로** 처리한다.
  //
  // 종전에는 매매를 기준으로 돌면서 나머지를 그때그때 따라잡는 방식이었는데, 매매가 없는
  // 날이 여러 개 이어지면 순서가 뒤엉켰다. 실제로 7/30 현금 입력(달러 0)이 같은 날 환전보다
  // 먼저 적용돼, 환전할 때 장부에 달러가 없다고 보고 $25,253을 '밖에서 새로 들어온 돈'으로
  // 세었다 — 원금이 그만큼 부풀어 달러 수익률이 -18%로 찍혔다.
  //
  // 같은 날짜 안에서는 실제 돈이 움직이는 순서를 따른다:
  //   입금 → 매도 → 환전 → 매수 → 출금 → 현금 잔액 입력
  //
  // 돈이 생기는 일(입금·매도)을 먼저, 돈을 쓰는 일(매수·출금)을 나중에 둔다. 그래야
  // "그날 판 돈으로 환전해서 샀다"는 실제 순서가 재현된다. 매도를 환전 뒤에 두었더니
  // 2026-05-12에 원화를 판 돈이 아직 없다고 보고 162만원을 '밖에서 새로 들어온 돈'으로
  // 세었다. 현금 입력이 맨 마지막인 이유는 그것이 '하루가 끝난 뒤의 잔액'이기 때문이다.
  const ORD = { in: 0, income: 0, sell: 1, fx: 2, buy: 3, out: 4, entry: 5 };
  const stream = [
    ...moves.map(m => ({ date: m.date, ord: m.kind === 'out' ? ORD.out : ORD.in, run: () => applyMove(m) })),
    ...incs.map(r => ({ date: r.date, ord: ORD.income, run: () => applyIncome(r) })),
    ...fxs.map(x => ({ date: x.date, ord: ORD.fx, run: () => applyExchange(x) })),
    ...trades.filter(t => !upto || t.date <= upto)
      .map(t => ({ date: t.date, ord: t.side === 'buy' ? ORD.buy : ORD.sell, run: () => applyTrade(t) })),
    ...entries.map(e => ({ date: e.date, ord: ORD.entry, run: () => applyCashEntry(e) })),
  ];
  // 정렬은 안정적이므로 같은 날 같은 종류(특히 매매)는 원래 순서를 지킨다
  stream.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord);
  for (const s of stream) s.run();

  events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { pool, netCap, events, flow };
}

// ---- 현금: 사용자가 직접 입력한 잔액 -------------------------------------------
// settings.cashLog = [{date, KRW, USD}] — 입력할 때마다 한 줄씩 쌓인다.
// 특정 시점의 현금 = 그 날짜 이하 마지막 입력값. 첫 입력 전에는 현금 0(= 주식만 합산).
export function cashLog(state) {
  return [...(state.settings?.cashLog || [])].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// ---- 환전 내역 (선택 입력) ------------------------------------------------------
// 안 넣으면 앱이 매수 시점 시장 환율로 알아서 환전했다고 본다(기본 동작).
// 넣으면 그 기록이 우선한다 — 실제 적용 환율(스프레드 포함)과 수수료가 반영된다.
export function exchangeLog(state) {
  return [...(state.exchanges || [])].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// ---- 현금 입출금 (사용자가 확정하는 기록) ---------------------------------------
export function cashMoveLog(state) {
  return [...(state.cashMoves || [])].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// ---- 배당·이자 (매매가 아닌 수입) -----------------------------------------------
// 자본이 아니라 **수익**이다. 그래서 원금(넣은 돈)에는 넣지 않고 장부의 현금만 늘린다.
// 그 돈으로 주식을 사면 평가액에 남으므로 수익률에는 저절로 반영된다.
export function incomeLog(state) {
  return [...(state.incomes || [])].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// 통화별 합계 + 종류별 내역 (화면 표시용)
export function incomeTotals(state, upto = null) {
  const rows = incomeLog(state).filter(r => !upto || r.date <= upto);
  const sum = { KRW: 0, USD: 0 };
  const byKind = {};
  for (const r of rows) {
    const cur = r.cur === 'USD' ? 'USD' : 'KRW';
    const amt = Number(r.amount) || 0;
    sum[cur] += amt;
    const k = r.kind || '기타';
    byKind[k] = byKind[k] || { KRW: 0, USD: 0, n: 0 };
    byKind[k][cur] += amt; byKind[k].n++;
  }
  const totalKRW = sum.KRW + (P.toKRW(sum.USD, 'USD') || 0);
  return { rows, sum, byKind, totalKRW, count: rows.length };
}

// 마지막 현금 입력 시점에 '앱 장부'와 '입력한 실제 잔액'이 얼마나 벌어졌나.
// 앱은 이 차이를 자본 이동으로 넘겨짚지 않는다 — 대신 화면에서 보여 주고, 그게 인출이면
// 출금 기록을 남기라고 안내한다. (수수료·배당·세금 누락일 수도 있어 앱이 판단할 수 없다.)
export function cashGap(state) {
  const entries = cashLog(state);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  // 그 날짜까지의 장부를 다시 세되, 마지막 입력 자체는 빼고 본다
  const upto = { ...state, settings: { ...state.settings, cashLog: entries.slice(0, -1) } };
  const { pool } = capitalLedger(upto, last.date);
  const gap = {};
  let any = false;
  for (const cur of ['KRW', 'USD']) {
    const d = (last[cur] || 0) - pool[cur];
    gap[cur] = d;
    if (Math.abs(d) > (cur === 'KRW' ? 1000 : 1)) any = true;
  }
  return any ? { date: last.date, ...gap } : null;
}

// 환전 한 건의 계산 결과 (화면 표시·미리보기 공용)
// '보낸 금액'은 증권사 화면에 찍힌 그대로 — **수수료가 이미 포함된 금액**이다.
// 그래서 받는 금액은 보낸 금액을 그대로 환율로 나눈(곱한) 값이고, 수수료는 빼지 않는다.
// (수수료는 적용 환율에 스프레드로 녹아 있다. 여기서 또 빼면 두 번 빼는 셈이 된다.)
// fee는 "얼마를 수수료로 냈는가"를 남겨 두는 참고용 기록일 뿐 계산에 쓰지 않는다.
export function exchangeCalc({ from, amount, rate, fee }) {
  const f = from === 'USD' ? 'USD' : 'KRW';
  const to = f === 'KRW' ? 'USD' : 'KRW';
  const r = Number(rate) || 0;
  const sent = Math.max(0, Number(amount) || 0);
  const feeAmt = Math.max(0, Number(fee) || 0);
  const got = r > 0 ? (f === 'KRW' ? sent / r : sent * r) : null;
  return { from: f, to, sent, fee: feeAmt, net: sent, rate: r, got };
}

// 그 시점에 적용 중인 입력 한 줄 (없으면 null). 값이 언제 넣은 것인지 표시할 때도 쓴다.
export function cashEntryOn(state, date) {
  let cur = null;
  for (const e of cashLog(state)) {
    if (e.date > date) break;
    cur = e;
  }
  return cur;
}

export function cashOn(state, date) {
  const e = cashEntryOn(state, date);
  return { KRW: e?.KRW || 0, USD: e?.USD || 0 };
}

// 현금을 직접 입력하기 시작한 날 (이 날부터 현금이 평가액에 포함된다). 미입력이면 null.
export function cashSince(state) {
  return cashLog(state)[0]?.date || null;
}

// ---- 포트폴리오 ------------------------------------------------------------
export function portfolio(state, date = null) {
  const d = date || todayStr();
  const trades = sortedTrades(state);
  const { open, realized, avg } = replay(trades, d);

  const bySym = new Map();
  for (const lot of open) {
    const v = lotValue(lot, d);
    const sym = lot.t.symbol;
    if (!bySym.has(sym)) bySym.set(sym, { symbol: sym, name: lot.t.name || sym, cur: v.cur, qty: 0, cost: 0, costKRW: 0, value: 0, firstBuy: lot.t.date, hasPrice: v.hasPrice });
    const r = bySym.get(sym);
    r.qty += lot.qtyLeft; r.cost += v.cost; r.costKRW += v.costKRW; r.value += v.value;
    if (lot.t.date < r.firstBuy) r.firstBuy = lot.t.date;
    r.hasPrice = r.hasPrice && v.hasPrice;
  }

  // 원가만 이동평균으로 바꿔 끼운다(증권사와 같은 기준).
  //
  // **평가액은 건드리지 않는다.** 평가액은 지금 시장에서 매겨지는 값이라 원가를 어떻게
  // 매기든 달라지지 않는다 (lot 원가 × 성장배수 ≈ 보유 수량 × 현재가). 여기에 원가 비율을
  // 곱했다가 VIAV 수익률이 실제로는 플러스인데 -3.39%로 나온 적이 있다.
  //
  // 원화 원가만 같은 비율로 옮긴다 — 그래야 '매수일 환율 가중'을 유지한 채 금액이 맞는다.
  for (const r of bySym.values()) {
    const a = avg.get(r.symbol);
    if (!a || !(a.qty > 0) || !(r.cost > 0)) continue;
    const mvCost = (a.cost / a.qty) * r.qty;     // 이동평균 단가 × 보유 수량
    r.costKRW *= mvCost / r.cost;
    r.cost = mvCost;
    r.avgPrice = a.cost / a.qty;                 // 화면에 그대로 보여 줄 평균 단가
  }

  const rows = [...bySym.values()].map(r => ({
    ...r,
    avgPrice: r.avgPrice ?? (r.qty > 0 ? r.cost / r.qty : null),
    valueKRW: P.toKRW(r.value, r.cur, d),
    ret: r.cost > 0 ? r.value / r.cost - 1 : null,
    lastClose: P.closeOn(r.symbol, d),
  }));
  const investedKRW = rows.reduce((s, r) => s + (r.valueKRW || 0), 0);
  const costTotalKRW = rows.reduce((s, r) => s + (r.costKRW || 0), 0);
  rows.forEach(r => {
    r.weight = investedKRW > 0 ? (r.valueKRW || 0) / investedKRW : 0;          // 평가 비중
    r.costWeight = costTotalKRW > 0 ? (r.costKRW || 0) / costTotalKRW : 0;      // 매입 비중
  });
  rows.sort((a, b) => (b.valueKRW || 0) - (a.valueKRW || 0));

  // 통화별 순 투입 원금 = 밖에서 들여온 순 자본 (환산하지 않고 통화 그대로 집계).
  // 현금을 입력했으면 그 선언값으로 장부를 맞추므로, 아직 투자 안 한 입금분도 원금에 잡힌다.
  const { netCap, flow } = capitalLedger(state, d);

  // 보유 종목 평가액(통화별, 현지 통화)
  const hold = { KRW: 0, USD: 0 };
  for (const r of rows) hold[r.cur] = (hold[r.cur] || 0) + r.value;

  // 현금: 사용자가 직접 입력한 그 시점 잔액 (첫 입력 전이면 0 = 주식만 합산)
  const cashEntry = cashEntryOn(state, d);
  const cash = { KRW: cashEntry?.KRW || 0, USD: cashEntry?.USD || 0 };
  const since = cashSince(state);
  const cashTracked = !!cashEntry;

  const fx = P.fxOn(d);
  // 통화별 슬리브(보유 주식 + 현금) 수익률 — 환율 개입 없이 통화 내부에서만 계산.
  //
  // 수익률은 **실제로 들어가고 나온 돈** 기준이다:
  //     수익   = 지금 자산 + 그동안 뺀 돈 − 그동안 넣은 돈
  //     수익률 = 수익 ÷ (넣은 돈 − 뺀 돈)          ← 순투입
  //
  // 분모가 '넣은 돈 총액'이던 시절에는, 같은 돈이 계좌를 들락거리면 그때마다 분모만
  // 불어나 수익률이 실제보다 낮게 찍혔다. 증권사 이체 내역을 전부 넣어 보니 4년간
  // 총입금 2.70억·총출금 1.57억인데 순투입은 1.13억이었다 — 같은 날 나갔다 들어온
  // 왕복만 8,527만원이다. 그 왕복은 자본을 더 넣은 게 아니므로 분모에서 뺀다.
  //
  // 순투입이 0 이하면(원금을 다 뺀 뒤 남은 이익으로만 굴리는 상태) 비율이 무의미하므로
  // 수익률을 내지 않는다 — 분모가 0에 가까울수록 % 가 폭발하기 때문이다.
  const sleeves = {};
  for (const cur of ['KRW', 'USD']) {
    const value = (hold[cur] || 0) + cash[cur];
    const f = flow[cur];
    const contributed = f.extIn + f.xferIn;    // 그 통화로 들어온 돈 (환전해 온 것 포함)
    const withdrawn = f.extOut + f.xferOut;    // 그 통화에서 나간 돈
    const net = contributed - withdrawn;       // 순투입 — 수익률의 분모
    const profit = value + withdrawn - contributed;
    sleeves[cur] = {
      cost: netCap[cur],                       // 지금 잠겨 있는 순 자본 (원금 표시용)
      contributed, withdrawn, net, value, profit,
      ret: net > 1e-6 ? profit / net : null,
      has: contributed > 0 || value > 1e-6,
    };
  }

  const cashKRW = cash.KRW + (P.toKRW(cash.USD, 'USD', d) || 0);
  const totalKRW = investedKRW + cashKRW;
  // 합산 원가(현재 환율 환산) → 합산 수익률은 환율 손익을 제외한 순수 자산 성과
  // (환전 시점 환율을 추적하지 않으므로 실제 환차익은 계산 불가 → 원가·평가를 같은 현재 환율로 환산)
  const costKRWnow = netCap.KRW + (P.toKRW(netCap.USD, 'USD', d) || 0);

  // 합산은 **펀드 밖에서** 오간 돈만 센다. 환전(xfer)은 펀드 안에서 통화만 바꾼 것이라
  // 합산 관점에서는 자본이 오간 게 아니다 — 넣으면 같은 돈을 두 번 세게 된다.
  const contributedKRW = flow.KRW.extIn + (P.toKRW(flow.USD.extIn, 'USD', d) || 0);
  const withdrawnKRW = flow.KRW.extOut + (P.toKRW(flow.USD.extOut, 'USD', d) || 0);
  const netKRW = contributedKRW - withdrawnKRW;     // 순투입 — 합산 수익률의 분모
  const profitKRW = totalKRW + withdrawnKRW - contributedKRW;

  return {
    date: d, rows, cash, cashKRW, investedKRW, totalKRW, fx, sleeves,
    // 화면의 '원금'은 수익률의 분모와 같아야 한다 — 넣은 돈(총액). 순 자본은 netDeposit*.
    depositKRW: sleeves.KRW.contributed, depositUSD: sleeves.USD.contributed,
    netDepositKRW: netCap.KRW, netDepositUSD: netCap.USD,
    holdKRW: hold.KRW || 0, holdUSD: hold.USD || 0, cashUSD: cash.USD,
    cashTracked,                    // 그 시점에 적용 중인 현금 입력이 있는가 (없으면 현금 0으로 계산 중)
    cashSince: since,               // 처음 입력한 날 (이 날부터 현금이 평가액에 포함)
    cashAsOf: cashEntry?.date || null, // 지금 쓰이는 값을 넣은 날 (표시용 — cashSince와 다를 수 있다)
    deposits: contributedKRW,       // 지금까지 펀드에 넣은 돈 (총액)
    netIn: netKRW,                  // 순투입 (넣은 돈 − 뺀 돈) — 수익률의 분모
    netDeposits: costKRWnow,        // 지금 잠겨 있는 순 자본
    withdrawn: withdrawnKRW,        // 지금까지 뺀 돈
    profit: profitKRW,              // 자산 + 뺀 돈 − 넣은 돈
    ret: netKRW > 0 ? profitKRW / netKRW : null,
    realized,
  };
}

// ---- 평행우주 ---------------------------------------------------------------
// upto: 그날까지만 계산 (펀드 청산 요약이 청산일 시점 값을 얼릴 때 쓴다). 없으면 오늘까지.
// endOnly: 마지막 한 점만 계산한다. 홈은 "코스피만 샀다면" 숫자 네 개만 쓰는데
// 곡선 전체(약 250지점 × 전 매매 재생)를 그리느라 화면이 늦게 떴다(실측 353ms → 2ms).
// 곡선이 필요한 건 '만약' 탭뿐이므로 그때만 격자를 만든다. 각 지점은 서로 독립적으로
// 계산되므로(그 날짜 기준 재생) 끝점만 뽑아도 값은 같다.
export function worlds(state, upto = null, { endOnly = false } = {}) {
  const end = upto || todayStr();
  const trades = sortedTrades(state).filter(t => t.date <= end);
  const buys = trades.filter(t => t.side === 'buy');
  if (!buys.length) return null;
  const start = buys[0].date;

  let dates;
  if (endOnly) {
    dates = [end];
  } else {
    // 날짜 그리드: 시작~오늘, 약 200~300개 지점 + 거래일
    const span = Math.max(1, daysBetween(start, end));
    const step = Math.max(2, Math.round(span / 220));
    const set = new Set([start, end]);
    for (let i = step; i < span; i += step) set.add(addDaysStr(start, i));
    for (const t of trades) set.add(t.date);
    // 현금 입력일도 격자에 넣는다 — 그날 자본이 한 번에 조정되므로 계단이 정확한 날짜에 찍히게.
    for (const e of cashLog(state)) if (e.date >= start && e.date <= end) set.add(e.date);
    dates = [...set].sort();
  }

  // 모든 세계는 "밖에서 새로 들여온 돈"만 굴린다 — 실제의 나와 조건을 맞춰야 비교가 공정하다.
  // 홈의 투입 원금과 같은 원장을 쓰므로 두 화면의 기준이 어긋나지 않는다.
  const contribs = capitalLedger(state, end).events;

  // 지수 세계의 매입 단위 미리 계산
  // 지수(코스피·S&P)는 원종가로 가격수익만 본다. KO(코카콜라)는 실제로 살 수 있는 배당주라
  // 배당까지 받고 재투자한 값이 "그 주식만 샀다면"의 정직한 답이므로 수정종가로 총수익을 본다.
  const kUnits = [], sUnits = [], koUnits = [];
  for (const c of contribs) {
    const k = P.closeOn('^KS11', c.date);
    if (k) kUnits.push({ date: c.date, units: c.amtKRW / k });
    const fx = P.fxOn(c.date);
    const amtUSD = c.cur === 'USD' ? c.amt : (fx ? c.amtKRW / fx : 0);
    const s = P.closeOn('^GSPC', c.date);
    if (s) sUnits.push({ date: c.date, units: amtUSD / s });
    const ko = P.adjOn('KO', c.date);
    if (ko) koUnits.push({ date: c.date, units: amtUSD / ko });
  }

  // 현금 입력이 장부와 달라 자본이 한 번에 조정된 지점 — 그래프에서 절벽처럼 보이므로 설명용으로 넘긴다.
  // (곡선을 안 그리는 endOnly에서는 쓰이지 않으므로 만들지 않는다.)
  const cashAdj = [];
  if (!endOnly) {
    const byDate = new Map();
    for (const c of contribs) if (c.src === 'cash') byDate.set(c.date, (byDate.get(c.date) || 0) + c.amtKRW);
    for (const [date, amtKRW] of byDate) if (Math.abs(amtKRW) >= 1) cashAdj.push({ date, amtKRW });
    cashAdj.sort((a, b) => a.date < b.date ? -1 : 1);
  }

  const rate = (state.settings?.depositRate ?? 3) / 100; // 정기예금 가정 금리(연, 복리)
  const out = { dates, deposits: [], actual: [], kospi: [], sp500: [], coke: [], bank: [], rate: rate * 100, cashAdj };
  for (const d of dates) {
    // 투입 원금 + 예금 세계(같은 날 같은 금액을 연 rate% 복리로)
    let dep = 0, bank = 0;
    for (const c of contribs) {
      if (c.date > d) break;
      dep += c.amtKRW;
      bank += c.amtKRW * Math.pow(1 + rate, daysBetween(c.date, d) / 365);
    }
    out.deposits.push(dep);
    out.bank.push(bank);

    // 실제의 나 = 보유 종목 평가액 + 그 시점 현금(직접 입력한 값, 미입력 구간은 0)
    const { open } = replay(trades, d);
    let v = 0;
    for (const lot of open) {
      const lv = lotValue(lot, d);
      v += P.toKRW(lv.value, lv.cur, d) || 0;
    }
    const c = cashOn(state, d);
    v += (c.KRW || 0) + (P.toKRW(c.USD, 'USD', d) || 0);
    out.actual.push(v);

    // 지수만 산 나
    let kv = 0;
    const kIdx = P.closeOn('^KS11', d);
    if (kIdx) for (const u of kUnits) { if (u.date <= d) kv += u.units * kIdx; }
    out.kospi.push(kv);
    let sv = 0;
    const sIdx = P.closeOn('^GSPC', d);
    const fx = P.fxOn(d);
    if (sIdx && fx) for (const u of sUnits) { if (u.date <= d) sv += u.units * sIdx * fx; }
    out.sp500.push(sv);
    let kov = 0;
    const koAdj = P.adjOn('KO', d);
    if (koAdj && fx) for (const u of koUnits) { if (u.date <= d) kov += u.units * koAdj * fx; }
    out.coke.push(kov);
  }
  return out;
}

// ---- 개입 점수 ---------------------------------------------------------------
// 매도 채점: "판 뒤 그 주식이 어떻게 됐나" (수정종가 기준)
// 잘한 매도인지 아닌지는 판정하지 않는다 — 판 돈을 어디에 썼는지·왜 팔았는지를 모르는 채로
// "지금 오르면 이른 매도"라고 부르는 건 채점이 아니라 뒷북이다. 변화만 보여주고 판단은 사용자 몫.
export const SELL_HORIZONS = [1, 3, 6, 12];

export function sellScores(state) {
  const trades = sortedTrades(state);
  const { realized } = replay(trades);
  const today = todayStr();
  const rows = realized.map(r => {
    const sym = r.sell.symbol;
    const horizon = {};
    for (const m of SELL_HORIZONS) {
      const d = addMonthsStr(r.sell.date, m);
      horizon['m' + m] = d <= today ? P.growth(sym, r.sell.date, d) : null;
    }
    horizon.now = P.growth(sym, r.sell.date);
    return {
      r, sym, name: r.sell.name || sym, horizon,
      year: r.sell.date.slice(0, 4),
      // 거래정지·상장폐지로 시세가 멈춘 종목: '현재까지'가 사실은 그 날짜까지다
      frozenSince: P.frozenSince(sym),
    };
  });
  const scored = rows.filter(x => x.horizon.now != null);
  const avgNow = scored.length ? scored.reduce((s, x) => s + (x.horizon.now - 1), 0) / scored.length : null;
  return { rows, agg: { count: scored.length, avgMissed: avgNow } };
}

// 물타기 감지 + 채점: 보유 중 평단보다 싸게 추가 매수 → 이후 성과 vs 지수
export function avgDownBuys(state) {
  const trades = sortedTrades(state);
  const rows = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.side !== 'buy') continue;
    const { open } = replay(trades.slice(0, i), t.date);
    const lots = open.filter(l => l.t.symbol === t.symbol);
    const qty = lots.reduce((s, l) => s + l.qtyLeft, 0);
    if (qty <= 0) continue;
    const avg = lots.reduce((s, l) => s + unitCost(l.t) * l.qtyLeft, 0) / qty;
    if (t.price >= avg) continue;
    const bench = P.currencyOf(t.symbol) === 'KRW' ? '^KS11' : '^GSPC';
    const g = P.growth(t.symbol, t.date);
    const gb = P.growth(bench, t.date);
    rows.push({ t, avgBefore: avg, growth: g, benchGrowth: gb, delta: (g != null && gb != null) ? g - gb : null });
  }
  const scored = rows.filter(x => x.delta != null);
  const avgDelta = scored.length ? scored.reduce((s, x) => s + x.delta, 0) / scored.length : null;
  return { rows, agg: { count: rows.length, avgDelta } };
}

// ---- 투자 헌법 ---------------------------------------------------------------
export const PRINCIPLE_KINDS = {
  max_weight: { label: '한 종목 최대 비중(%)', hasParam: true, auto: true },
  min_hold_days: { label: '최소 보유 일수', hasParam: true, auto: true },
  no_avg_down: { label: '물타기 금지', hasParam: false, auto: true },
  manual: { label: '수동(매수 전 스스로 점검)', hasParam: false, auto: false },
};

// 전체 위반 목록 (자동 조항만)
export function violations(state) {
  const trades = sortedTrades(state);
  const out = [];
  const active = state.principles.filter(p => p.active);
  for (const p of active) {
    if (p.kind === 'max_weight') {
      for (const t of trades) {
        if (t.side !== 'buy') continue;
        const { open } = replay(trades, t.date);
        // 빈 포트폴리오에서의 첫 매수는 비중 100%가 불가피하므로 제외
        const others = new Set(open.filter(l => l.t.symbol !== t.symbol).map(l => l.t.symbol));
        if (!others.size) continue;
        let total = 0, mine = 0;
        for (const lot of open) {
          const lv = lotValue(lot, t.date);
          const krw = P.toKRW(lv.value, lv.cur, t.date) || 0;
          total += krw;
          if (lot.t.symbol === t.symbol) mine += krw;
        }
        if (total > 0 && mine / total > p.param / 100 + 0.005) {
          out.push({ p, trade: t, detail: `매수 후 비중 ${(mine / total * 100).toFixed(1)}% (한도 ${p.param}%)` });
        }
      }
    } else if (p.kind === 'min_hold_days') {
      const { realized } = replay(trades);
      for (const r of realized) {
        const minD = Math.min(...r.parts.map(x => daysBetween(x.buy.date, r.sell.date)));
        if (isFinite(minD) && minD < p.param) {
          out.push({ p, trade: r.sell, detail: `보유 ${minD}일 만에 매도 (최소 ${p.param}일)` });
        }
      }
    } else if (p.kind === 'no_avg_down') {
      for (const x of avgDownBuys(state).rows) {
        out.push({ p, trade: x.t, detail: `평단 ${Math.round(x.avgBefore).toLocaleString()} 아래에서 추가 매수` });
      }
    }
  }
  return out;
}

// 조항별 성적: 위반이 얽힌 실현 매매 vs 아닌 것의 평균 수익률
export function principleStats(state) {
  const vio = violations(state);
  const { realized } = replay(sortedTrades(state));
  const stats = new Map();
  for (const p of state.principles.filter(p => p.active && PRINCIPLE_KINDS[p.kind]?.auto)) {
    const violIds = new Set(vio.filter(v => v.p.id === p.id).map(v => v.trade.id));
    const v = [], ok = [];
    for (const r of realized) {
      if (r.ret == null) continue;
      const ids = [r.sell.id, ...r.parts.map(x => x.buy.id)];
      (ids.some(id => violIds.has(id)) ? v : ok).push(r.ret);
    }
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    stats.set(p.id, { violCount: violIds.size, violAvgRet: avg(v), okAvgRet: avg(ok), violN: v.length, okN: ok.length });
  }
  return stats;
}

// 저장 전 검사: 이 매매를 추가하면 자동 조항 위반이 생기는가
export function checkDraft(state, draft) {
  const clone = { ...state, trades: [...state.trades, { ...draft, id: draft.id || '__draft__' }] };
  const before = new Set(violations(state).map(v => v.p.id + '|' + v.trade.id + '|' + v.detail));
  return violations(clone).filter(v => (v.trade.id === (draft.id || '__draft__')) || !before.has(v.p.id + '|' + v.trade.id + '|' + v.detail));
}

// ---- 홀딩 일지 ---------------------------------------------------------------
export function diaryRows(state) {
  const today = todayStr();
  return [...state.diary].sort((a, b) => b.date < a.date ? -1 : 1).map(e => {
    const p0 = P.closeOn(e.symbol, e.date) ?? e.priceAtEntry ?? null;
    const gNow = P.growth(e.symbol, e.date);
    const d3 = addMonthsStr(e.date, 3);
    const g3 = d3 <= today ? P.growth(e.symbol, e.date, d3) : null;
    let verdict = null;
    if (gNow != null) {
      const chg = gNow - 1;
      if (e.urge === 'sell') {
        verdict = chg > 0.03 ? { cls: 'up', text: `참은 뒤 ${fmtPct(chg)} — 그때의 불안은 소음이었다` }
          : chg < -0.03 ? { cls: 'down', text: `이후 ${fmtPct(chg)} — 그때의 불안은 신호였다` }
          : { cls: 'flat', text: `이후 ${fmtPct(chg)} — 큰 차이 없음` };
      } else {
        verdict = chg > 0.03 ? { cls: 'up', text: `그때 샀다면 ${fmtPct(chg)}` }
          : chg < -0.03 ? { cls: 'down', text: `안 사길 잘했다 (${fmtPct(chg)})` }
          : { cls: 'flat', text: `이후 ${fmtPct(chg)} — 큰 차이 없음` };
      }
    }
    return { e, p0, gNow, g3, verdict };
  });
}

// ---- 관심 종목 ---------------------------------------------------------------
export function benchOf(symbol) {
  return P.currencyOf(symbol) === 'KRW' ? '^KS11' : '^GSPC';
}

// 각 관심 종목: 등록일에 샀다면 지금 몇 %인가 + 같은 기간 지수 + 실제 매수/기다림
export function watchRows(state) {
  const trades = sortedTrades(state);
  return [...(state.watchlist || [])].sort((a, b) => b.date < a.date ? -1 : 1).map(w => {
    const p0 = P.closeOn(w.symbol, w.date);
    const last = P.last(w.symbol);
    const gNow = P.growth(w.symbol, w.date);
    const gBench = P.growth(benchOf(w.symbol), w.date);
    const buy = trades.find(t => t.side === 'buy' && t.symbol === w.symbol && t.date >= w.date);
    const waitG = buy ? P.growth(w.symbol, w.date, buy.date) : null;
    const gSinceArchive = w.archived && w.archivedAt ? P.growth(w.symbol, w.archivedAt) : null;
    return {
      w, p0, last, gNow, gBench,
      alpha: (gNow != null && gBench != null) ? gNow - gBench : null,
      buy, waitG, gSinceArchive,
    };
  });
}

// 안목 집계: 관심 등록 종목들의 등록 후 평균 성과 vs 지수
export function watchAgg(state) {
  const rows = watchRows(state).filter(r => r.gNow != null && r.gBench != null);
  if (!rows.length) return null;
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    count: rows.length,
    avgG: avg(rows.map(r => r.gNow - 1)),
    avgBench: avg(rows.map(r => r.gBench - 1)),
    avgAlpha: avg(rows.map(r => r.alpha)),
  };
}

// 교체 시뮬: date에 fromSymbol fromQty주를 팔아 toSymbol을 샀다면 (같은 금액, 환율 반영)
export function swapRows(state) {
  return [...(state.swaps || [])].sort((a, b) => b.date < a.date ? -1 : 1).map(s => {
    const curA = P.currencyOf(s.fromSymbol), curB = P.currencyOf(s.toSymbol);
    const pa = P.closeOn(s.fromSymbol, s.date), pb = P.closeOn(s.toSymbol, s.date);
    const gA = P.growth(s.fromSymbol, s.date), gB = P.growth(s.toSymbol, s.date);
    const amtKRW = pa != null ? P.toKRW(pa * s.fromQty, curA, s.date) : null;
    const pbKRW = pb != null ? P.toKRW(pb, curB, s.date) : null;
    const qtyB = (amtKRW != null && pbKRW) ? amtKRW / pbKRW : null;
    const keptKRW = (pa != null && gA != null) ? P.toKRW(pa * s.fromQty * gA, curA) : null;
    const swapKRW = (qtyB != null && pb != null && gB != null) ? P.toKRW(qtyB * pb * gB, curB) : null;
    return {
      s, amtKRW, qtyB, keptKRW, swapKRW, gA, gB,
      delta: (keptKRW != null && swapKRW != null) ? swapKRW - keptKRW : null,
    };
  });
}

// ---- 가상 펀드 -----------------------------------------------------------------
// 실제로는 사지 않은 종목을 "그날 그 값에 그만큼 샀다면 지금 얼마인가"로 굴려 보는 장부.
//
// 매수·매도·수수료·현금을 실제 펀드와 **같은 방식**으로 다룬다. 그래서 계산도 같은 엔진을
// 쓴다 — FIFO 재생(replay)으로 보유분과 실현손익을 내고, 보유분 평가는 lotValue로 한다.
// (별도 계산기를 새로 짜면 두 곳이 서로 어긋나기 시작한다.)
//
// 평가는 매수일 대비 수정종가 성장배수를 원가에 곱한다 — 배당·액면분할이 반영되고,
// 홈의 보유 종목과 같은 잣대로 읽힌다. (현재가 × 수량으로 하면 분할 종목에서 값이 어긋난다.)
//
// 원화 환산: 매입액은 산 날의 환율, 평가액은 지금 환율. 그래서 원화 손익에 환차손익이 포함된다.
//
// v.positions는 이제 매매 기록이다 — {id, side, symbol, name, date, price, qty, fee}.
// side가 없는 옛 기록은 매수로 본다(이 기능이 처음엔 매수만 받았으므로).
export function virtualTrades(v) {
  return [...(v?.positions || [])]
    .map(p => ({ ...p, side: p.side || 'buy', fee: p.fee || 0 }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));
}

// 그 시점에 그 종목을 몇 주 들고 있나 (매도 폼에서 수량 한도로 쓴다)
export function virtualHeldQty(v, symbol, date = null) {
  const { open } = replay(virtualTrades(v), date);
  return open.filter(l => l.t.symbol === symbol).reduce((s, l) => s + l.qtyLeft, 0);
}

export function virtualRows(v) {
  const trades = virtualTrades(v);
  const { open, realized, avg } = replay(trades);

  // 보유분을 종목별로 합친다 — 나눠 산 것도 결국 한 종목의 보유분이므로.
  // 매수 건마다 성장배수가 다르므로(산 날이 다르니) 평가는 lot별로 계산해 더하고,
  // 평균 단가는 그 합계에서 역산한다(가중평균) — 단순 평균은 수량이 다를 때 거짓이 된다.
  const bySym = new Map();
  for (const lot of open) {
    const t = lot.t;
    const lv = lotValue(lot, null);
    const first = P.firstDate(t.symbol);
    if (!bySym.has(t.symbol)) {
      bySym.set(t.symbol, {
        // 시세에 등록된 이름을 먼저 쓴다 — 넣을 당시엔 시세가 없어 종목코드가 이름으로
        // 저장된 건들이 있는데, 그대로 보여 주면 무슨 종목인지 알 수 없다.
        symbol: t.symbol, name: P.info(t.symbol)?.name || t.name || t.symbol,
        cur: lv.cur, lots: [],
        lastClose: P.last(t.symbol)?.close ?? null,
        frozenSince: P.frozenSince(t.symbol),   // 거래정지·상장폐지면 '지금'이 사실 그날이다
      });
    }
    bySym.get(t.symbol).lots.push({
      t, qty: lot.qtyLeft, cost: lv.cost, costKRW: lv.costKRW,
      value: lv.hasPrice ? lv.value : null,
      hasPrice: lv.hasPrice,
      // 평가가 안 되는 이유는 둘이고 할 일이 다르다: 시세 파일이 아직 없으면 기다리면 되고,
      // 시세는 있는데 첫 봉이 매수일보다 뒤면 종목코드가 틀렸을 가능성이 크다.
      noHistory: !lv.hasPrice && !!first && first > t.date,
      holdDays: daysBetween(t.date, todayStr()),
    });
  }

  const rows = [...bySym.values()].map(r => {
    r.lots.sort((a, b) => a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : 0);
    // 집계는 시세가 있는 것만 — 시세 없는 건을 원가로 세면 "손익 0인 자산"이 껴서 총액이 거짓이 된다.
    const priced = r.lots.filter(l => l.hasPrice);
    const qty = priced.reduce((s, l) => s + l.qty, 0);
    const lotCost = priced.reduce((s, l) => s + l.cost, 0);
    const value = priced.reduce((s, l) => s + l.value, 0);   // 시장 가치 — 원가 기준과 무관
    let costKRW = priced.reduce((s, l) => s + l.costKRW, 0);
    // 원가만 이동평균으로 (실제 펀드와 같은 기준). 평가액은 건드리지 않는다 — 위 portfolio 주석 참고.
    const a = avg.get(r.symbol);
    const unitAvg = a && a.qty > 0 ? a.cost / a.qty : null;
    let cost = lotCost;
    if (unitAvg != null && lotCost > 0) {
      cost = unitAvg * qty;
      costKRW *= cost / lotCost;
    }
    return {
      ...r,
      qty, cost, value, costKRW,
      avgPrice: unitAvg ?? (qty > 0 ? cost / qty : null),   // 이동평균 매입단가(수수료 포함)
      valueKRW: priced.length ? (P.toKRW(value, r.cur) || 0) : null,
      ret: cost > 0 ? value / cost - 1 : null,
      buys: r.lots.length,
      pendingLots: r.lots.length - priced.length,
      badLots: r.lots.filter(l => l.noHistory).length,
      hasPrice: priced.length > 0,
      holdDays: priced.length ? Math.max(...priced.map(l => l.holdDays)) : null,
    };
  });
  rows.sort((a, b) => (b.valueKRW ?? 0) - (a.valueKRW ?? 0));

  const costKRW = rows.reduce((s, r) => s + r.costKRW, 0);
  const valueKRW = rows.reduce((s, r) => s + (r.valueKRW || 0), 0);
  for (const r of rows) r.weight = valueKRW > 0 && r.valueKRW ? r.valueKRW / valueKRW : 0;

  // 실현손익 — 실제 펀드와 같은 방식(매수 다리는 산 날 환율, 매도 다리는 판 날 환율)
  const realizedTotalKRW = realized.reduce((s, r) => s + realizedKRW(r), 0);

  // ---- 투입 원금과 결산 --------------------------------------------------------
  // 매매만으로 계산한 '밖에서 든 돈' — 매도 대금을 먼저 쓰고 모자란 만큼이 새 돈이다.
  // (실제 펀드 capitalLedger와 같은 규칙. 여기선 통화를 원화 하나로 합쳐 단순하게 본다.)
  let pool = 0, needed = 0, netBuyKRW = 0;
  for (const t of trades) {
    const cur = P.currencyOf(t.symbol);
    if (t.side === 'buy') {
      const c = P.toKRW(t.price * t.qty + (t.fee || 0), cur, t.date) || 0;
      const use = Math.min(Math.max(0, pool), c);
      pool -= use; needed += c - use; netBuyKRW += c;
    } else {
      const pr = P.toKRW(t.price * t.qty - (t.fee || 0), cur, t.date) || 0;
      pool += pr; netBuyKRW -= pr;
    }
  }

  // 설정 금액(seed)을 넣었으면 그게 투입 원금이다. 안 넣었으면 위에서 계산한 값을 쓴다.
  const seed = Math.max(0, Number(v?.seed) || 0);
  const investedKRW = seed > 0 ? seed : needed;

  // 현금: 사용자가 직접 넣었으면 그 값. 안 넣었고 설정 금액이 있으면 남은 돈을 계산해 준다
  // — 설정 금액 1,050만원으로 800만원어치를 샀으면 250만원은 현금으로 남아 있어야 하고,
  // 그걸 0으로 두면 총자산이 모자라 '손해'처럼 보인다.
  const manualCash = !!v?.cash;
  const cash = manualCash
    ? { KRW: v.cash.KRW || 0, USD: v.cash.USD || 0 }
    : { KRW: seed > 0 ? Math.max(0, seed - netBuyKRW) : 0, USD: 0 };
  const cashKRW = (cash.KRW || 0) + (P.toKRW(cash.USD, 'USD') || 0);

  const totalKRW = valueKRW + cashKRW;         // 총자산 = 보유 평가액 + 현금
  return {
    rows, trades, realized,
    costKRW, valueKRW,
    profitKRW: valueKRW - costKRW,               // 보유분 평가손익
    ret: costKRW > 0 ? valueKRW / costKRW - 1 : null,
    realizedKRW: realizedTotalKRW,               // 판 것들의 확정 손익
    cash, cashKRW, manualCash,
    totalKRW,
    // 결산 — 넣은 돈 대비 지금 얼마인가 (실제 펀드와 같은 기준)
    seed, investedKRW, autoInvested: needed,
    netProfitKRW: investedKRW > 0 ? totalKRW - investedKRW : null,
    netRet: investedKRW > 0 ? totalKRW / investedKRW - 1 : null,
    pending: rows.reduce((s, r) => s + r.pendingLots, 0),
    bad: rows.reduce((s, r) => s + r.badLots, 0),
    oversold: realized.filter(r => r.oversold).length,   // 가진 것보다 많이 판 기록
  };
}

// 가상 펀드 목록 — 총자산 큰 순
export function virtualFunds(state) {
  return [...(state.virtuals || [])]
    .map(v => ({ v, sum: virtualRows(v) }))
    .sort((a, b) => b.sum.totalKRW - a.sum.totalKRW);
}

// ---- 투자 비용: 대출 이자 (계좌별 독립) ----------------------------------------
// loans: 대출 계좌 목록
//   {name, balance(최초 금액), rate(연%), startDate, endDate(null=보유중), note,
//    repayments:[{id, date, amount, note}]}   ← 중도 상환 기록
//
// 이자는 잔액×연율×일수/365. 중도 상환이 있으면 그 날짜로 구간을 끊어, 갚은 뒤로는 줄어든
// 잔액에만 이자가 붙는다. 이게 없으면 일부를 갚아도 최초 금액에 계속 이자가 붙어 비용이
// 과대 계상된다(예전에는 계좌를 지우고 새로 만드는 수밖에 없어 이력이 끊겼다).
function loanSchedule(l, today) {
  const startBal = Math.max(0, Number(l.balance) || 0);
  const rate = (Number(l.rate) || 0) / 100;
  // 상환 완료일이 적혀 있으면 그날까지만 이자를 센다
  const endCap = (l.endDate && l.endDate < today) ? l.endDate : today;
  const reps = [...(l.repayments || [])]
    .filter(r => r.date >= l.startDate)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  let bal = startBal, cursor = l.startDate, interest = 0, paidOffDate = null;
  const segs = [];
  const addSeg = (to) => {
    const days = Math.max(0, daysBetween(cursor, to));
    if (days > 0 || segs.length === 0) {
      interest += bal * rate * days / 365;
      segs.push({ from: cursor, to, balance: bal, days });
    }
    cursor = to;
  };
  for (const r of reps) {
    const at = r.date > endCap ? endCap : r.date;
    addSeg(at);
    bal = Math.max(0, bal - (Number(r.amount) || 0));
    if (bal <= 0.5 && !paidOffDate) paidOffDate = at;
    if (at >= endCap) break;
  }
  if (cursor < endCap) addSeg(endCap);

  return {
    interest, balanceNow: bal, segs, paidOffDate,
    repaid: reps.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    days: Math.max(0, daysBetween(l.startDate, paidOffDate || endCap)),
  };
}

// asOf: 그 시점 기준으로 계산 (청산 요약이 청산일 기준 이자를 얼릴 때 쓴다). 없으면 오늘.
export function loanStatus(state, asOf = null) {
  const loans = state.loans || [];
  if (!loans.length) return null;
  const today = asOf || todayStr();

  const accounts = loans.map(l => {
    const sch = loanSchedule(l, today);
    // 다 갚았으면(잔액 0) 상환 완료일을 따로 안 적었어도 끝난 것으로 본다
    const closedByDate = !!l.endDate && l.endDate <= today;
    const open = !closedByDate && sch.balanceNow > 0.5;
    const end = closedByDate ? l.endDate : (sch.paidOffDate || today);
    return {
      ...l, open, end,
      principal: l.balance,          // 최초 대출 금액
      balance: sch.balanceNow,       // 지금 남은 잔액 (중도 상환 반영)
      repaid: sch.repaid,
      repayCount: (l.repayments || []).length,
      days: sch.days,
      segments: sch.segs,
      interest: sch.interest,
      monthly: open ? sch.balanceNow * (l.rate / 100) / 12 : 0,
      daily: open ? sch.balanceNow * (l.rate / 100) / 365 : 0,
    };
  }).sort((a, b) => a.startDate < b.startDate ? -1 : 1);

  const openAccts = accounts.filter(a => a.open);
  const balance = openAccts.reduce((s, a) => s + a.balance, 0);
  const monthly = openAccts.reduce((s, a) => s + a.monthly, 0);
  const daily = openAccts.reduce((s, a) => s + a.daily, 0);
  const cumulative = accounts.reduce((s, a) => s + a.interest, 0);
  const wRate = balance > 0 ? openAccts.reduce((s, a) => s + a.balance * a.rate, 0) / balance : 0; // 잔액가중 평균금리

  // 이자 비용을 반영한 실질 손익 + 레버리지가 값을 하는지(펀드 연환산 수익률 vs 평균 대출 금리)
  const pf = portfolio(state, today);
  const trades = sortedTrades(state).filter(t => t.date <= today);
  const firstDay = trades.length ? trades[0].date : accounts[0].startDate;
  const fundDays = Math.max(1, daysBetween(firstDay, today));
  const annualized = (pf.ret != null && pf.deposits > 0)
    ? Math.pow(1 + pf.ret, 365 / fundDays) - 1 : null;

  const start = accounts.reduce((m, a) => a.startDate < m ? a.startDate : m, accounts[0].startDate);
  return {
    accounts, openAccts, balance, monthly, daily, cumulative, wRate, start, today,
    profit: pf.profit, netProfit: pf.profit - cumulative,
    fundRet: pf.ret, annualized,
    beatsHurdle: annualized != null ? annualized > wRate / 100 : null,
  };
}

// ---- 기간(주/월/연) 수익률 ------------------------------------------------------
// 평가액 = 그 시점 보유 주식 + 그 시점 현금(직접 입력분, 첫 입력 전은 0).
// 원화 기준(달러 자산은 각 시점 환율로 환산 → 환율 변동 포함).
//
// 기중에 들어오고 나간 돈(자금 흐름):
//  - 매수 +원가, 매도 −대금. 매도 대금은 앱이 추적하지 않으므로 계좌 밖으로 나간 것으로 본다.
//    그 돈이 실제로 계좌에 남아 있었다면, 현금을 입력하는 순간 다시 들어온 것으로 잡힌다.
//    어느 쪽이든 손익으로는 잡히지 않는다 — 돈을 옮긴 것은 번 것이 아니므로.
//  - 현금 입력값의 변동 ±차액 (첫 입력 = 그동안 안 세던 현금을 자산으로 인식한 것).
function flowEvents(state) {
  const ev = [];
  for (const t of sortedTrades(state)) {
    const amt = t.side === 'buy'
      ? t.price * t.qty + (t.fee || 0)
      : -(t.price * t.qty - (t.fee || 0));
    ev.push({ date: t.date, amtKRW: tradeKRW(t, amt) });
  }
  let prev = { KRW: 0, USD: 0 };
  for (const e of cashLog(state)) {
    const dKRW = ((e.KRW || 0) - prev.KRW) + (P.toKRW((e.USD || 0) - prev.USD, 'USD', e.date) || 0);
    if (Math.abs(dKRW) > 1e-9) ev.push({ date: e.date, amtKRW: dKRW });
    prev = { KRW: e.KRW || 0, USD: e.USD || 0 };
  }
  return ev.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// 시간가중 수익률(TWR) 계산기.
//
// 돈이 들어오고 나간 날마다 구간을 끊어 각 구간의 수익률을 따로 재고 곱한다. 이러면 "언제
// 얼마를 넣었나"가 수익률에서 완전히 빠진다 — 기말에 원금을 왕창 넣은 기간이라고 해서
// 그 돈의 손익이 작았던 기초 잔액에 나뉘어 수익률이 폭발하지 않는다(기저효과 제거).
// 순손익(번 돈) 자체는 따로 그대로 보여주므로, 둘을 같이 보면 된다.
function twrCalculator(state) {
  const flowByDate = new Map();
  for (const ev of flowEvents(state)) flowByDate.set(ev.date, (flowByDate.get(ev.date) || 0) + ev.amtKRW);
  const flowDates = [...flowByDate.keys()].sort();
  const cache = new Map(); // 같은 날짜 평가액을 여러 번 계산하지 않도록
  const valueOn = d => {
    if (!cache.has(d)) cache.set(d, portfolio(state, d).totalKRW);
    return cache.get(d);
  };
  const flowsIn = (from, to) =>
    flowDates.reduce((s, d) => (d > from && d <= to) ? s + flowByDate.get(d) : s, 0);

  // from(그 시점 평가액 fromVal)부터 to까지의 시간가중 수익률. 굴린 돈이 없던 기간은 null.
  const ret = (from, fromVal, to) => {
    let factor = 1, vPrev = fromVal, any = false;
    for (const d of flowDates) {
      if (d <= from) continue;
      if (d > to) break;
      const v = valueOn(d);
      // 그날 들어온(나간) 돈은 아직 일한 적이 없으므로 그 구간 수익에서 뺀다
      if (vPrev > 1) { factor *= (v - flowByDate.get(d)) / vPrev; any = true; }
      vPrev = v;
    }
    if (vPrev > 1) { factor *= valueOn(to) / vPrev; any = true; }
    return any ? factor - 1 : null;
  };
  return { valueOn, flowsIn, ret };
}

const pad2 = n => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(y, m, 0).getDate(); // m: 1-based

// 기간 내 매도로 '확정된' 손익(원화, 매도일 환율). 증권사 '실현수익/판매수익'과 대조하는 용도.
//
// 주의: 이건 순손익(gain)의 일부가 아니다. 2024년에 사서 2025년에 팔았다면 그 이익 전부가
// 2025년 실현손익으로 잡히지만, 2025년 순손익에는 2025년에 오른 만큼만 들어간다(2024년분은
// 이미 2024년 평가손익으로 셌으므로). 그래서 두 숫자는 더해지지도, 같아지지도 않는다.
// 또 수수료·제세금·배당금·환차손익은 앱이 추적하지 않으므로 증권사 수치와 몇 %는 어긋난다.
// 원화 실현손익 = 매도대금(매도 환율) − 취득원가(각 매수 환율).
// 달러 손익을 매도일 환율로만 환산하면 '환차손익'(산 뒤 환율이 움직인 몫)이 통째로 빠져
// 증권사 원화 실현수익과 어긋난다. 매수일 환율로 원가를 환산해야 그 몫이 들어온다.
function realizedKRW(r) {
  // 매수 다리는 '그때 실제 적용된 환율'로 환산해야 환차손익이 살아난다. 그 환율은 lot마다
  // 다르므로 선입선출 lot으로 환산한 뒤, 원가 기준의 차이(이동평균 ÷ 선입선출)만큼 비례
  // 조정한다. 원가 방식은 이동평균이지만 '어느 날 산 돈인가'는 lot이 알고 있기 때문이다.
  let costKRW = 0;
  for (const p of r.parts) costKRW += tradeKRW(p.buy, unitCost(p.buy) * p.qty);
  if (r.costFifo > 0) costKRW *= r.costSum / r.costFifo;
  return tradeKRW(r.sell, r.proceeds) - costKRW;
}

function realizedByDate(state) {
  const { realized } = replay(sortedTrades(state));
  return realized.map(r => ({ date: r.sell.date, krw: realizedKRW(r) }));
}

// 기간(from 제외 ~ to 포함) 안에 확정된 매도 한 건씩. 수익 화면에서 기간을 눌렀을 때 쓴다.
export function realizedDetail(state, from, to) {
  const { realized } = replay(sortedTrades(state));
  return realized
    .filter(r => r.sell.date > from && r.sell.date <= to)
    .map(r => ({
      date: r.sell.date,
      symbol: r.sell.symbol,
      name: r.sell.name || r.sell.symbol,
      cur: P.currencyOf(r.sell.symbol),
      qty: r.sell.qty,
      proceeds: r.proceeds,
      cost: r.costSum,
      pnl: r.pnl,          // 자기 통화 손익
      ret: r.ret,
      holdDays: r.holdDays,
      krw: realizedKRW(r), // 원화 실현손익(환차 포함)
      reasonType: r.sell.sellReasonType || '',
    }))
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0); // 최신 먼저
}

export function periodReturns(state, unit = 'month') {
  const trades = sortedTrades(state);
  if (!trades.length) return [];
  const today = todayStr();
  const first = trades[0].date;
  const calc = twrCalculator(state);
  const realList = realizedByDate(state);

  // 기간 말 날짜 목록(ends)과 라벨 함수
  const ends = [];
  let labelOf;
  if (unit === 'year') {
    const cy = Number(today.slice(0, 4));
    for (let y = Number(first.slice(0, 4)); y <= cy; y++) ends.push(y < cy ? `${y}-12-31` : today);
    labelOf = (s, e) => `${e.slice(0, 4)}년`;
  } else if (unit === 'week') {
    const sundayOf = ds => { const [Y, M, D] = ds.split('-').map(Number); const dt = new Date(Y, M - 1, D); dt.setDate(dt.getDate() + (7 - dt.getDay()) % 7); return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; };
    let e = sundayOf(first);
    while (e < today) { ends.push(e); e = addDaysStr(e, 7); }
    ends.push(today);
    labelOf = (s, e) => `${addDaysStr(s, 1).slice(5).replace('-', '.')}~${e.slice(5).replace('-', '.')}`;
  } else {
    let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
    const cy = Number(today.slice(0, 4)), cm = Number(today.slice(5, 7));
    while (y < cy || (y === cy && m <= cm)) {
      ends.push((y === cy && m === cm) ? today : `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`);
      if (++m > 12) { m = 1; y++; }
    }
    labelOf = (s, e) => e.slice(0, 7).replace('-', '.');
  }

  let prevEnd = addDaysStr(first, -1); // 첫 거래 전날 = 평가액 0
  let prevVal = 0;
  const rows = [];
  for (const end of ends) {
    const endVal = calc.valueOn(end);
    const contrib = calc.flowsIn(prevEnd, end);  // 기중 들어온(+)·나간(−) 돈
    const change = endVal - prevVal;             // 평가액 증감(그 돈 포함)
    const gain = change - contrib;               // 순손익(그 돈 제외) = 실현 + 미실현 평가변동
    // 기간 내 매도로 확정된 손익 (증권사 실현수익과 대조용 — 순손익과는 별개 지표)
    const realized = realList.reduce((s, x) => (x.date > prevEnd && x.date <= end) ? s + x.krw : s, 0);
    rows.push({
      label: labelOf(prevEnd, end), start: prevEnd, end, isCurrent: end === today,
      startVal: prevVal, endVal, contrib, change, gain, realized,
      ret: calc.ret(prevEnd, prevVal, end),
    });
    prevEnd = end; prevVal = endVal;
  }
  return rows.reverse(); // 최신 먼저
}

// ---- 주주 서한 데이터 팩 -------------------------------------------------------
export function letterPack(state, period) {
  const today = todayStr();
  let [start, end] = quarterRange(period);
  if (end > today) end = today;
  const prevEnd = addDaysStr(start, -1);
  const p0 = portfolio(state, prevEnd);
  const p1 = portfolio(state, end);
  const trades = sortedTrades(state).filter(t => t.date >= start && t.date <= end);
  // 기간 수익률과 같은 방식(시간가중)으로 분기 수익률을 낸다
  const calc = twrCalculator(state);
  const flows = calc.flowsIn(prevEnd, end);
  const ret = calc.ret(prevEnd, p0.totalKRW, end);
  const bench = {
    kospi: P.growth('^KS11', start, end),
    sp500: P.growth('^GSPC', start, end),
  };
  const vio = violations(state).filter(v => v.trade.date >= start && v.trade.date <= end);
  const diary = state.diary.filter(e => e.date >= start && e.date <= end);
  const prev = state.letters.filter(l => l.period === prevQuarter(period))[0] || null;
  return { period, start, end, p0, p1, flows, ret, bench, trades, vio, diary, prev };
}

// ---- AI 복기 데이터 팩 --------------------------------------------------------
export function aiPack(state) {
  const pf = portfolio(state);
  const w = worlds(state);
  const ss = sellScores(state);
  const ad = avgDownBuys(state);
  const vio = violations(state);
  const L = [];
  const pct = v => v == null ? '?' : (v * 100).toFixed(1) + '%';
  L.push('# 나의 매매 기록 전체 (복기용 데이터 팩)');
  L.push('');
  L.push(`생성일: ${todayStr()}  / 기준통화: KRW (달러 자산은 해당일 환율 환산)`);
  L.push('');
  L.push('## 펀드 현황');
  const depStr = [pf.depositKRW > 0 ? fmtMoney(pf.depositKRW) : null, pf.depositUSD > 0 ? fmtMoney(pf.depositUSD, 'USD') : null].filter(Boolean).join(' + ') || fmtMoney(0);
  const retStr = [pf.sleeves.KRW.has ? `원화 ${pct(pf.sleeves.KRW.ret)}` : null, pf.sleeves.USD.has ? `달러 ${pct(pf.sleeves.USD.ret)}` : null].filter(Boolean).join(', ');
  L.push(`- 투입 원금: ${depStr} (통화별 분리) / 현재 가치: ${fmtMoney(pf.totalKRW)} (현재 환율 환산 합계)`);
  L.push(`- 수익률: ${retStr}${pf.sleeves.KRW.has && pf.sleeves.USD.has ? ` / 합산 ${pct(pf.ret)}(환율 영향 제외)` : ''}`);
  L.push(`- 현금: ${pf.cashTracked ? `${fmtMoney(pf.cash.KRW)} + ${fmtMoney(pf.cash.USD, 'USD')} (${pf.cashSince}부터 직접 입력, 위 현재 가치에 포함)` : '직접 입력한 적 없음 → 위 수치는 보유 주식만 합산한 것'}`);
  if (w) {
    const last = w.dates.length - 1;
    L.push(`- 만약(같은 돈을 다르게 굴렸을 때의 현재 가치): 실제 ${fmtMoney(w.actual[last])} / 코스피만 샀다면 ${fmtMoney(w.kospi[last])} / S&P500만 샀다면 ${fmtMoney(w.sp500[last])} / 코카콜라만 샀다면 ${fmtMoney(w.coke[last])} / 예금(연 ${w.rate}%)만 했다면 ${fmtMoney(w.bank[last])}`);
  }
  L.push('');
  L.push('## 보유 종목');
  for (const r of pf.rows) L.push(`- ${r.name}(${r.symbol}): ${r.qty}주, 원가 ${fmtMoney(r.cost, r.cur)}, 평가 ${fmtMoney(r.value, r.cur)} (${pct(r.ret)}), 비중 ${(r.weight * 100).toFixed(1)}%`);
  if (!pf.rows.length) L.push('- (없음)');
  L.push('');
  L.push('## 전체 매매 기록 (시간순)');
  for (const t of sortedTrades(state)) {
    L.push(`### ${t.date} ${t.side === 'buy' ? '매수' : '매도'} — ${t.name || t.symbol} (${t.symbol}) ${t.qty}주 @ ${fmtMoney(t.price, P.currencyOf(t.symbol))}`);
    if (t.side === 'buy') {
      L.push(`- 매수 이유: ${t.reason || '(기록 없음)'}`);
      if (t.confidence != null) L.push(`- 확신도: ${t.confidence}%  / 계획 보유기간: ${t.planMonths ?? '?'}개월`);
      if (t.sellPlan) L.push(`- 미리 정한 매도 조건: ${t.sellPlan}`);
    } else {
      L.push(`- 매도 이유(${t.sellReasonType || '분류 없음'}): ${t.reason || '(기록 없음)'}`);
    }
    if (t.emotions?.length) L.push(`- 그때의 감정: ${t.emotions.join(', ')}`);
  }
  L.push('');
  L.push('## 실현된 매매의 결과');
  const { realized } = replay(sortedTrades(state));
  for (const r of realized) {
    L.push(`- ${r.sell.date} ${r.sell.name || r.sell.symbol} 매도: 수익률 ${pct(r.ret)}, 평균 보유 ${r.holdDays ? Math.round(r.holdDays) + '일' : '?'}`);
  }
  if (ss.agg.count) L.push(`- 매도 ${ss.agg.count}건, 판 뒤 그 주식의 현재까지 변화 평균: ${pct(ss.agg.avgMissed)} (해석은 하지 않음 — 판 돈을 어디에 썼는지는 아래 기록에서 판단할 것)`);
  if (ad.agg.count) L.push(`- 물타기 ${ad.agg.count}회, 지수 대비 평균 ${pct(ad.agg.avgDelta)}P`);
  L.push('');
  L.push('## 흔들렸던 순간들 (홀딩 일지)');
  for (const e of state.diary) L.push(`- ${e.date} ${e.symbol} [${e.urge === 'sell' ? '팔고 싶었다' : '더 사고 싶었다'}] ${e.note}`);
  if (!state.diary.length) L.push('- (없음)');
  L.push('');
  L.push('## 안 산 판단 (관심 종목)');
  for (const r of watchRows(state)) {
    const status = r.buy ? `이후 ${r.buy.date} 실제 매수` : r.w.archived ? '관심 접음' : '계속 관망 중';
    L.push(`- ${r.w.date} 등록 ${r.w.name || r.w.symbol}: 등록 후 ${pct(r.gNow != null ? r.gNow - 1 : null)} (같은 기간 지수 ${pct(r.gBench != null ? r.gBench - 1 : null)}) — ${status}`);
    if (r.w.thesis) L.push(`  논지: ${r.w.thesis}`);
    if (r.w.trigger) L.push(`  매수 조건: ${r.w.trigger}`);
  }
  if (!(state.watchlist || []).length) L.push('- (없음)');
  L.push('');
  L.push('## 교체 고민의 기록 (하지 않은 스왑)');
  for (const x of swapRows(state)) {
    L.push(`- ${x.s.date} ${x.s.fromName || x.s.fromSymbol} ${x.s.fromQty}주 → ${x.s.toName || x.s.toSymbol}: 그대로 ${fmtMoney(x.keptKRW)}, 바꿨다면 ${fmtMoney(x.swapKRW)} (차이 ${fmtMoney(x.delta)})${x.s.note ? ' — ' + x.s.note : ''}`);
  }
  if (!(state.swaps || []).length) L.push('- (없음)');
  L.push('');
  const ln = loanStatus(state);
  if (ln) {
    L.push('## 투자 비용 (대출 이자)');
    L.push(`- 대출 계좌 ${ln.openAccts.length}개, 총 잔액 ${fmtMoney(ln.balance)} (평균 금리 연 ${ln.wRate.toFixed(2)}%), 이번 달 이자 약 ${fmtMoney(ln.monthly)}`);
    for (const a of ln.accounts) L.push(`  · ${a.name} ${fmtMoney(a.balance)} 연 ${a.rate}% (${a.startDate}~${a.open ? '보유 중' : a.endDate}) 누적이자 ${fmtMoney(a.interest)}`);
    L.push(`- ${ln.start} 이후 누적 이자 약 ${fmtMoney(ln.cumulative)} → 이자 차감 후 실질 손익 ${fmtMoney(ln.netProfit)} (명목 ${fmtMoney(ln.profit)})`);
    if (ln.annualized != null) L.push(`- 펀드 연환산 수익률 약 ${pct(ln.annualized)} vs 평균 대출 금리 ${ln.wRate.toFixed(2)}% → 레버리지가 ${ln.beatsHurdle ? '값을 하는 중' : '비용을 못 넘고 있음'}`);
    L.push('');
  }
  L.push('## 나의 투자 헌법과 위반');
  for (const p of state.principles.filter(p => p.active)) L.push(`- ${p.text}`);
  for (const v of vio) L.push(`  - 위반: ${v.trade.date} ${v.trade.name || v.trade.symbol} — ${v.detail}`);
  L.push('');
  L.push('## 과거에 나 자신에게 쓴 주주 서한');
  for (const l of [...state.letters].sort((a, b) => a.period < b.period ? -1 : 1)) {
    L.push(`### ${l.period}`);
    L.push(l.body);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('위는 한 개인투자자의 실제 매매 기록 전체입니다. 당신은 이 사람의 복기 파트너입니다. 아래를 지켜 주세요.');
  L.push('1. 칭찬으로 시작하지 말 것. 기록에서 반복되는 패턴(특히 본인이 못 보고 있을 행동 습관)을 구체적 근거와 함께 지적할 것.');
  L.push('2. 매수 이유의 "글"과 실제 "행동"이 어긋난 지점을 찾을 것 (예: 장기 보유를 말하면서 단기에 파는 것, 살 때는 사업 이야기·팔 때는 가격 이야기만 하는 것).');
  L.push('3. 감정 태그와 성과의 관계, 확신도와 실제 결과의 관계를 짚을 것.');
  L.push('4. 마지막에, 다음 분기에 지킬 행동 규칙을 딱 2개만 제안할 것. 추상적 조언 금지.');
  L.push('5. 종목 추천이나 시장 전망은 하지 말 것. 이 대화의 주제는 시장이 아니라 이 사람의 행동이다.');
  return L.join('\n');
}

// ---- 펀드 세대(2ⁿ) ------------------------------------------------------------
//
// 지금 굴리는 펀드를 청산하고 새 펀드를 시작할 수 있다. 청산하면 그 펀드의 기록은
// archives에 통째로 보관되고 장부는 빈 채로 다시 시작한다.

// 이 펀드가 시작한 날. 청산 후 새로 시작한 펀드는 settings.inception이 그 날이고,
// 첫 펀드는 그런 게 없으니 첫 매매일이 시작이다. 둘 다 있으면 이른 쪽.
export function fundStart(state) {
  const first = sortedTrades(state)[0]?.date || null;
  const inc = state.settings?.inception || null;
  if (inc && first) return inc < first ? inc : first;
  return inc || first;
}

// 청산 시점의 성적표를 통째로 계산한다.
//
// **이 값은 청산 순간에 딱 한 번 계산해 저장해 두고, 열람할 때는 다시 계산하지 않는다.**
// 청산한 펀드의 성적은 그 뒤로 시세가 어떻게 움직이든 변하면 안 되기 때문이다. 다시 계산하면
// 볼 때마다 숫자가 달라져 "그때 내가 얼마로 끝냈나"라는 기록 자체가 성립하지 않는다.
export function fundSummary(state, closeDate) {
  const d = closeDate;
  const trades = sortedTrades(state).filter(t => t.date <= d);
  const pf = portfolio(state, d);
  const { realized } = replay(trades, d);
  const w = worlds(state, d);
  const li = w ? w.dates.length - 1 : -1;

  // 전 기간 시간가중 수익률 — 첫 거래 전날(평가액 0)부터 청산일까지
  const first = trades[0]?.date || null;
  const twr = first ? twrCalculator(state).ret(addDaysStr(first, -1), 0, d) : null;

  // 종목별 실현 손익 — 이 펀드가 실제로 무엇을 했는지가 여기 남는다
  const bySym = new Map();
  for (const r of realized) {
    const sym = r.sell.symbol;
    if (!bySym.has(sym)) {
      bySym.set(sym, { symbol: sym, name: r.sell.name || sym, cur: P.currencyOf(sym), pnl: 0, cost: 0, count: 0 });
    }
    const x = bySym.get(sym);
    x.pnl += r.pnl; x.cost += r.costSum; x.count++;
  }
  const realizedBySym = [...bySym.values()]
    .map(x => ({ ...x, ret: x.cost > 0 ? x.pnl / x.cost : null, pnlKRW: P.toKRW(x.pnl, x.cur, d) || 0 }))
    .sort((a, b) => b.pnlKRW - a.pnlKRW);

  const ln = loanStatus(state, d);
  return {
    closeDate: d,
    // 평가
    totalKRW: pf.totalKRW, investedKRW: pf.investedKRW, cashKRW: pf.cashKRW,
    depositKRW: pf.depositKRW, depositUSD: pf.depositUSD,
    cash: pf.cash, holdKRW: pf.holdKRW, holdUSD: pf.holdUSD,
    fx: pf.fx, sleeves: pf.sleeves, deposits: pf.deposits, profit: pf.profit, ret: pf.ret, twr,
    cashTracked: pf.cashTracked, cashSince: pf.cashSince,
    // 청산 시점에 남아 있던 보유 종목 (전량 매도했다면 빈 배열)
    rows: pf.rows.map(r => ({
      symbol: r.symbol, name: r.name, cur: r.cur, qty: r.qty,
      cost: r.cost, value: r.value, valueKRW: r.valueKRW, ret: r.ret, weight: r.weight, firstBuy: r.firstBuy,
    })),
    realizedBySym,
    realizedPnlKRW: realized.reduce((s, r) => s + (P.toKRW(r.pnl, P.currencyOf(r.sell.symbol), r.sell.date) || 0), 0),
    counts: {
      trades: trades.length,
      buys: trades.filter(t => t.side === 'buy').length,
      sells: trades.filter(t => t.side === 'sell').length,
      symbols: new Set(trades.map(t => t.symbol)).size,
      diary: (state.diary || []).length,
      letters: (state.letters || []).length,
      watch: (state.watchlist || []).length,
      swaps: (state.swaps || []).length,
    },
    worlds: w ? { actual: w.actual[li], kospi: w.kospi[li], sp500: w.sp500[li], coke: w.coke[li], bank: w.bank[li], rate: w.rate } : null,
    loan: ln ? { cumulative: ln.cumulative, balance: ln.balance, accounts: ln.accounts.length, netProfit: ln.netProfit } : null,
  };
}

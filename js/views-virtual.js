// 화면: 가상 펀드 — 실제로 사지 않은 종목을 "그때 샀다면 지금 얼마인가"로 굴려 본다.
//
// 실제 펀드(홈·기록)와 철저히 분리돼 있다. 여기에 넣은 종목은 매매 기록·수익률·2ⁿ 어디에도
// 섞이지 않는다. 다만 시세는 같은 저장소를 쓰므로, 여기서 처음 등장한 종목은 tickers.json에
// 등록 요청을 보낸다(ensureTicker) — 안 그러면 평가할 시세가 영영 없다.
import { state, saveNow, toast, openModal, closeModal, confirmModal, registerView, render } from './core.js';
import * as E from './engine.js';
import * as P from './prices.js';
import { uid, todayStr, esc, fmtMoney, fmtSigned, fmtPct, fmtQty, pctClass, bindKrArrowStep, bindThousands, numOf } from './util.js';

// 펼쳐 놓은 펀드 id (화면을 다시 그려도 유지). null이면 모두 접힘.
let openFundId = null;

// 펀드는 반드시 '지금' id로 다시 찾아 쓴다. 객체를 붙들고 있으면 안 된다 —
// Dropbox 동기화가 state.virtuals 배열을 통째로 새 객체로 갈아끼우기 때문이다
// (sync.syncNow: state[c] = merged[c]). 모달을 띄워 놓고 입력하는 사이에 동기화가 돌면
// 붙들고 있던 객체는 상태에서 떨어져 나간 고아가 되고, 거기에 넣은 매수 기록은 저장돼도
// 화면에서 사라진다. 실제로 그렇게 기록이 사라지는 문제가 있었다.
const findFund = id => (state.virtuals || []).find(v => v.id === id) || null;

// 시세가 없는 종목이면 데이터 저장소에 등록을 요청한다. 관심 종목(views-insight)과 같은 방식.
function ensureTicker(symbol) {
  if (P.has(symbol)) return;
  if (!state.pendingSymbols.includes(symbol)) state.pendingSymbols.push(symbol);
  if (state.settings.ghPat && state.settings.ghRepo) {
    P.registerTicker(state.settings, symbol)
      .then(() => toast(`${symbol} 시세 등록 요청 완료 — 몇 분 뒤 자동 반영됩니다`, 3600))
      .catch(() => toast('시세 등록 요청 실패 — 설정에서 다시 시도하세요', 3600));
  } else {
    toast('시세 미등록 종목입니다. 설정에서 시세 저장소를 연결하세요.', 3200);
  }
}

// 종목 입력칸의 추천 목록 — 이미 시세가 있는 종목(지수·환율 제외)
function symbolDatalist(id) {
  const opts = P.symbols().filter(s => !s.startsWith('^') && s !== 'KRW=X')
    .map(s => `<option value="${esc(s)}">${esc(P.info(s)?.name || '')}</option>`).join('');
  return `<datalist id="${id}">${opts}</datalist>`;
}

// ---------- 펀드 만들기 / 이름 바꾸기 ----------
function openFundModal(fund = null) {
  const fundId = fund?.id || null;   // 객체가 아니라 id를 들고 있는다 (위 findFund 주석 참고)
  const m = openModal(`
    <h2>${fund ? '가상 펀드 수정' : '새 가상 펀드'}</h2>
    <form id="vf-form">
      <label class="fld">펀드 이름
        <input name="name" required maxlength="40" placeholder="예: 안 산 반도체" value="${esc(fund?.name || '')}">
      </label>
      <label class="fld" style="margin-top:10px;">투입 원금 — 설정 금액 (선택)
        <input name="seed" type="text" inputmode="decimal" autocomplete="off" value="${fund?.seed ?? ''}" placeholder="예: 10,500,000">
      </label>
      <p class="hint" style="margin:4px 0 0;">이 펀드에 굴린다고 가정할 원화 금액입니다. 넣으면 <b>결산</b>(넣은 돈 대비 지금 얼마인가)이 계산되고,
      아직 안 산 돈은 현금으로 자동 계산됩니다. 비워 두면 매매에 실제로 든 돈을 투입 원금으로 봅니다.</p>
      <label class="fld" style="margin-top:10px;">메모 (왜 이 가정을 만드는가)
        <textarea name="note" placeholder="예: 2023년에 사려다 만 종목들. 그때 샀으면 어땠을까.">${esc(fund?.note || '')}</textarea>
      </label>
      <div class="btn-row" style="justify-content:flex-end; margin-top:16px;">
        <button class="btn" type="button" data-x="cancel">취소</button>
        <button class="btn primary" type="submit">${fund ? '저장' : '만들기'}</button>
      </div>
    </form>`);
  m.querySelector('[data-x=cancel]').addEventListener('click', closeModal);
  bindThousands(m.querySelector('#vf-form').seed);
  m.querySelector('#vf-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) { toast('이름을 입력하세요'); return; }
    if (fundId) {
      const cur = findFund(fundId);
      if (!cur) { closeModal(); render(); toast('그 사이 펀드가 사라졌습니다'); return; }
      cur.name = name;
      cur.note = f.note.value.trim();
      cur.seed = numOf(f.seed) || 0;
      cur.updatedAt = Date.now();   // 동기화가 이 변경을 이기도록 — 필수
    } else {
      const nf = {
        id: uid(), name, note: f.note.value.trim(), seed: numOf(f.seed) || 0, positions: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      state.virtuals = [...(state.virtuals || []), nf];
      openFundId = nf.id;   // 만들자마자 펼쳐서 바로 종목을 넣을 수 있게
    }
    saveNow(); closeModal(); render();
    toast(fundId ? '저장했습니다' : '가상 펀드를 만들었습니다. 종목을 넣어 보세요.');
  });
}

// ---------- 종목 추가 ----------
function openPositionModal(fund) {
  const fundId = fund.id;   // 객체가 아니라 id를 들고 있는다 (위 findFund 주석 참고)
  const today = todayStr();
  const m = openModal(`
    <h2>가상 매수 — ${esc(fund.name)}</h2>
    <form id="vp-form">
      <div class="form-grid">
        <label class="fld">종목
          <input name="symbol" list="vp-symlist" placeholder="티커 (예: 005930 또는 AAPL)" required autocomplete="off">
          ${symbolDatalist('vp-symlist')}
        </label>
        <label class="fld full" id="vp-mkt-row" hidden>어느 시장의 종목입니까 <span class="muted small">— 처음 넣는 종목이라 확인이 필요합니다</span>
          <select name="market">
            <option value="">고르세요</option>
            <option value="KS">한국 · 코스피</option>
            <option value="KQ">한국 · 코스닥</option>
            <option value="US">미국</option>
          </select>
        </label>
        <label class="fld">매수일
          <input type="date" name="date" max="${today}" value="${today}" required>
        </label>
        <label class="fld">매수가 (종목 통화 그대로)
          <input name="price" type="number" step="any" min="0" required placeholder="한국 원, 미국 달러">
        </label>
        <label class="fld">수량
          <input name="qty" type="number" step="any" min="0" required>
        </label>
        <label class="fld">수수료·제세금 (선택)
          <input name="fee" type="number" step="any" min="0" placeholder="0">
        </label>
      </div>
      <p class="hint" style="margin:8px 0 0;">매수가를 비워 두지 말고 그날 실제로 살 수 있었던 값을 넣으세요.
      그날 종가와 크게 다르면 저장 뒤에 알려 드립니다. 수수료는 매입 원가에 더해집니다.</p>
      <div class="btn-row" style="justify-content:flex-end; margin-top:16px;">
        <button class="btn" type="button" data-x="cancel">취소</button>
        <button class="btn primary" type="submit">넣기</button>
      </div>
    </form>`);
  m.querySelector('[data-x=cancel]').addEventListener('click', closeModal);

  // 종목·날짜를 채우면 그날 종가를 안내해 오타를 줄인다
  const f = m.querySelector('#vp-form');
  const mktRow = m.querySelector('#vp-mkt-row');

  // 처음 보는 종목이면 시장을 묻는다 — 코스닥을 코스피로 찍어 시세가 조용히 비는 것을 막는다
  const syncMarketRow = () => {
    const raw = f.symbol.value.trim().toUpperCase();
    const need = P.needsMarket(raw);
    mktRow.hidden = !need;
    if (!need) { f.market.value = ''; return; }
    if (!P.KR_CODE.test(raw)) f.market.value = 'US';
    else if (f.market.value === 'US') f.market.value = '';
  };
  const formSymbol = () => mktRow.hidden
    ? P.resolveSymbol(f.symbol.value)
    : P.applyMarket(f.symbol.value, f.market.value);

  const hintClose = () => {
    syncMarketRow();
    const sym = formSymbol();
    const c = sym && f.date.value ? P.closeOn(sym, f.date.value) : null;
    if (c != null && !f.price.value) f.price.placeholder = `그날 종가 ${c}`;
  };
  f.symbol.addEventListener('change', hintClose);
  f.symbol.addEventListener('input', syncMarketRow);
  f.market.addEventListener('change', hintClose);
  f.date.addEventListener('change', hintClose);
  // 가격칸 방향키 — 한국 종목이면 호가 단위로, 그 외(달러 등)는 기본(±1) 동작.
  bindKrArrowStep(f.price, () => {
    const sym = formSymbol();
    return sym ? P.currencyOf(sym) : null;
  });

  f.addEventListener('submit', e => {
    e.preventDefault();
    syncMarketRow();
    if (!mktRow.hidden && !f.market.value) {
      toast('처음 넣는 종목입니다. 어느 시장인지 골라 주세요', 3600);
      f.market.focus();
      return;
    }
    const symbol = formSymbol();
    if (!symbol) { toast('종목을 입력하세요'); return; }
    const price = parseFloat(f.price.value);
    const qty = parseFloat(f.qty.value);
    if (!(price > 0) || !(qty > 0)) { toast('매수가와 수량은 0보다 커야 합니다'); return; }

    // 입력하는 동안 동기화가 배열을 갈아끼웠을 수 있으므로 지금 다시 찾는다
    const cur = findFund(fundId);
    if (!cur) { closeModal(); render(); toast('그 사이 펀드가 사라졌습니다'); return; }
    cur.positions = [...(cur.positions || []), {
      id: uid(), side: 'buy', symbol, name: P.info(symbol)?.name || symbol,
      date: f.date.value, price, qty, fee: parseFloat(f.fee.value) || 0,
      createdAt: Date.now(),
    }];
    cur.updatedAt = Date.now();   // positions가 펀드 안에 있으므로 펀드의 시각을 올려야 동기화된다
    ensureTicker(symbol);
    saveNow(); closeModal(); render();

    // 입력값이 그날 종가와 크게 다르면 알려 준다 (막지는 않는다 — 장중가로 샀을 수도 있으니)
    const c = P.closeOn(symbol, f.date.value);
    if (c != null && Math.abs(price / c - 1) > 0.2) {
      toast(`넣었습니다. 참고: 그날 종가는 ${fmtMoney(c, P.currencyOf(symbol))}였습니다.`, 4200);
    } else {
      toast('넣었습니다');
    }
  });
}

// ---------- 가상 매도 ----------
// 보유하지 않은 종목·수량은 팔 수 없게 막는다. FIFO로 원가를 매기므로(replay), 가진 것보다
// 많이 팔면 원가 없는 매도가 생겨 실현손익이 부풀려진다.
function openSellModal(fund) {
  const fundId = fund.id;
  const today = todayStr();
  const sum = E.virtualRows(fund);
  if (!sum.rows.length) { toast('팔 수 있는 보유 종목이 없습니다'); return; }

  const opts = sum.rows.map(r =>
    `<option value="${esc(r.symbol)}" data-qty="${r.qty}" data-cur="${r.cur}">${esc(r.name)} — 보유 ${fmtQty(r.qty)}주</option>`).join('');

  const m = openModal(`
    <h2>가상 매도 — ${esc(fund.name)}</h2>
    <form id="vs-form">
      <div class="form-grid">
        <label class="fld">종목
          <select name="symbol" required>${opts}</select>
        </label>
        <label class="fld">매도일
          <input type="date" name="date" max="${today}" value="${today}" required>
        </label>
        <label class="fld">매도가 (종목 통화 그대로)
          <input name="price" type="number" step="any" min="0" required>
        </label>
        <label class="fld">수량 <span class="muted small" data-heldhint></span>
          <input name="qty" type="number" step="any" min="0" required>
        </label>
        <label class="fld">수수료·제세금 (선택)
          <input name="fee" type="number" step="any" min="0" placeholder="0">
        </label>
      </div>
      <p class="hint" style="margin:8px 0 0;">수수료·세금은 매도 대금에서 빼고 실현손익을 계산합니다.
      원가는 먼저 산 것부터(선입선출) 매깁니다 — 실제 펀드와 같은 방식.</p>
      <div class="btn-row" style="justify-content:flex-end; margin-top:16px;">
        <button class="btn" type="button" data-x="cancel">취소</button>
        <button class="btn primary" type="submit">팔기</button>
      </div>
    </form>`);
  m.querySelector('[data-x=cancel]').addEventListener('click', closeModal);

  const f = m.querySelector('#vs-form');
  const hint = m.querySelector('[data-heldhint]');
  // 고른 종목·날짜 기준으로 그날 보유 수량과 종가를 안내한다
  const refresh = () => {
    const fd = findFund(fundId);
    if (!fd) return;
    const sym = f.symbol.value;
    const held = E.virtualHeldQty(fd, sym, f.date.value);
    hint.textContent = `— 그날 보유 ${fmtQty(held)}주`;
    f.qty.max = held;
    const c = P.closeOn(sym, f.date.value);
    if (c != null && !f.price.value) f.price.placeholder = `그날 종가 ${c}`;
  };
  f.symbol.addEventListener('change', refresh);
  f.date.addEventListener('change', refresh);
  refresh();
  bindKrArrowStep(f.price, () => P.currencyOf(f.symbol.value));

  f.addEventListener('submit', e => {
    e.preventDefault();
    const symbol = f.symbol.value;
    const price = parseFloat(f.price.value);
    const qty = parseFloat(f.qty.value);
    if (!(price > 0) || !(qty > 0)) { toast('매도가와 수량은 0보다 커야 합니다'); return; }

    const cur = findFund(fundId);   // 동기화가 배열을 갈아끼웠을 수 있으므로 지금 다시 찾는다
    if (!cur) { closeModal(); render(); toast('그 사이 펀드가 사라졌습니다'); return; }

    const held = E.virtualHeldQty(cur, symbol, f.date.value);
    if (qty > held + 1e-9) {
      toast(`${f.date.value} 기준 보유 ${fmtQty(held)}주뿐입니다`, 3600);
      return;
    }
    cur.positions = [...(cur.positions || []), {
      id: uid(), side: 'sell', symbol, name: P.info(symbol)?.name || symbol,
      date: f.date.value, price, qty, fee: parseFloat(f.fee.value) || 0,
      createdAt: Date.now(),
    }];
    cur.updatedAt = Date.now();
    saveNow(); closeModal(); render(); toast('팔았습니다');
  });
}

// ---------- 현금 입력 ----------
// 매매에서 자동으로 만들지 않고 사용자가 직접 넣는다. 실제 펀드에서 장부가 추측한 현금과
// 실제 잔액이 어긋나 '유령 유출'이 생겼던 문제를 여기서 되풀이하지 않으려는 것.
function openCashModal(fund) {
  const fundId = fund.id;
  const c = fund.cash || {};
  const m = openModal(`
    <h2>현금 — ${esc(fund.name)}</h2>
    <form id="vc-form">
      <div class="form-grid">
        <label class="fld">원화
          <input name="krw" type="number" step="any" value="${c.KRW || 0}">
        </label>
        <label class="fld">달러
          <input name="usd" type="number" step="any" value="${c.USD || 0}">
        </label>
      </div>
      <p class="hint" style="margin:8px 0 0;">이 펀드가 지금 들고 있는 현금입니다. 총자산(보유 평가액 + 현금)에 더해집니다.
      매매를 넣어도 자동으로 바뀌지 않으니, 바뀌었으면 직접 고쳐 주세요.</p>
      <div class="btn-row" style="justify-content:flex-end; margin-top:16px;">
        <button class="btn" type="button" data-x="cancel">취소</button>
        <button class="btn primary" type="submit">저장</button>
      </div>
    </form>`);
  m.querySelector('[data-x=cancel]').addEventListener('click', closeModal);
  m.querySelector('#vc-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const cur = findFund(fundId);
    if (!cur) { closeModal(); render(); toast('그 사이 펀드가 사라졌습니다'); return; }
    cur.cash = { KRW: parseFloat(f.krw.value) || 0, USD: parseFloat(f.usd.value) || 0 };
    cur.updatedAt = Date.now();
    saveNow(); closeModal(); render(); toast('저장했습니다');
  });
}

// ---------- 펀드 한 개의 상세 ----------
function fundDetail(v, sum) {
  if (!sum.trades.length) {
    return `<div class="empty">아직 기록이 없습니다 — "가상 매수"를 눌러 시작하세요</div>`;
  }

  // 보유 종목 (합산). 다 판 종목은 여기서 빠지고 아래 거래 내역·실현손익에만 남는다.
  const holdBody = sum.rows.map(r => `
    <tr>
      <td>
        <b>${esc(r.name)}</b>
        <br><span class="muted small">${esc(r.symbol)}${r.buys > 1 ? ` · ${r.buys}건 합산` : ''}${r.qty > 0 ? ` · ${fmtQty(r.qty)}주 · 평균 ${fmtMoney(r.avgPrice, r.cur)}` : ''}</span>
        ${r.frozenSince ? `<br><span class="muted small" title="거래정지·상장폐지로 시세가 멈췄습니다">${r.frozenSince} 시세 정지</span>` : ''}
        ${r.badLots ? `<br><span class="down small">매수일 시세 없음 ${r.badLots}건 — 종목코드 확인</span>` : ''}
      </td>
      <td class="num">${r.hasPrice
        ? `${fmtMoney(r.cost, r.cur)}<br><span class="muted small">${fmtMoney(r.costKRW)}</span>`
        : '<span class="muted">–</span>'}</td>
      <td class="num">${r.hasPrice
        ? `${fmtMoney(r.value, r.cur)}<br><span class="muted small">${fmtMoney(r.valueKRW)}</span>`
        : '<span class="muted">시세 대기 중</span>'}</td>
      <td class="num ${pctClass(r.ret)}"><b>${fmtPct(r.ret)}</b>${r.holdDays != null ? `<br><span class="muted small">최장 ${Math.round(r.holdDays / 30.44)}개월</span>` : ''}</td>
    </tr>`).join('');

  // 실현손익 — 판 건별로. 원가는 선입선출(replay)이 매긴다.
  const soldBody = sum.realized.slice().reverse().map(r => {
    const cur = P.currencyOf(r.sell.symbol);
    return `
    <tr>
      <td><b>${esc(P.info(r.sell.symbol)?.name || r.sell.name || r.sell.symbol)}</b>
        <br><span class="muted small">${r.sell.date} · ${fmtQty(r.sell.qty)}주 @ ${fmtMoney(r.sell.price, cur)}${r.sell.fee ? ` · 비용 ${fmtMoney(r.sell.fee, cur)}` : ''}</span>
        ${r.oversold ? '<br><span class="down small">보유보다 많이 판 기록 — 원가 없는 수량이 있습니다</span>' : ''}</td>
      <td class="num">${fmtMoney(r.costSum, cur)}</td>
      <td class="num">${fmtMoney(r.proceeds, cur)}</td>
      <td class="num ${pctClass(r.pnl)}"><b>${fmtSigned(r.pnl)}</b><br><span class="small">${fmtPct(r.ret)}</span></td>
    </tr>`;
  }).join('');

  // 거래 내역 — 매수·매도 전부(최신순). 지우는 것도 여기서 한다.
  const tradeBody = sum.trades.slice().reverse().map(t => {
    const cur = P.currencyOf(t.symbol);
    const isBuy = t.side === 'buy';
    return `
    <tr>
      <td><span class="tag ${isBuy ? 'buy' : 'sell'}">${isBuy ? '매수' : '매도'}</span>
        <b style="margin-left:6px;">${esc(P.info(t.symbol)?.name || t.name || t.symbol)}</b>
        <br><span class="muted small">${t.date} · ${fmtQty(t.qty)}주 @ ${fmtMoney(t.price, cur)}${t.fee ? ` · 수수료·세금 ${fmtMoney(t.fee, cur)}` : ''}</span></td>
      <td class="num"><button class="btn small danger" data-delpos="${v.id}|${t.id}">삭제</button></td>
    </tr>`;
  }).join('');

  return `
    ${sum.rows.length ? `
    <h4 style="margin:12px 0 6px;">보유 종목</h4>
    <div class="tbl-wrap"><table class="tbl">
      <tr><th>종목</th><th class="num">매입액</th><th class="num">평가액</th><th class="num">수익률</th></tr>
      ${holdBody}
    </table></div>` : '<div class="empty" style="margin-top:10px;">보유 중인 종목이 없습니다 (전부 팔았습니다)</div>'}
    ${sum.bad ? `<div class="warnbox" style="margin-top:8px;">
      <b>매수 ${sum.bad}건은 종목코드를 확인해 주세요.</b> 시세는 받아 왔는데 <b>매수일보다 늦게 시작</b>합니다 —
      코스닥 종목을 <code>.KS</code>로 넣으면 이런 일이 생깁니다(야후가 최근 며칠짜리 껍데기를 줍니다).
      아래 거래 내역에서 그 건을 지우고 <code>.KQ</code>를 붙여 다시 넣으면 됩니다. 합계에서는 빼 두었습니다.
    </div>` : ''}
    ${sum.pending - sum.bad > 0 ? `<div class="warnbox" style="margin-top:8px;">시세를 아직 못 받은 매수 ${sum.pending - sum.bad}건은 합계에서 뺐습니다 — 몇 분 뒤 자동으로 채워집니다.</div>` : ''}

    ${sum.realized.length ? `
    <h4 style="margin:16px 0 6px;">실현손익 <span class="muted small">— 판 것들의 확정 손익</span></h4>
    <div class="tbl-wrap"><table class="tbl">
      <tr><th>매도</th><th class="num">원가</th><th class="num">매도대금</th><th class="num">손익</th></tr>
      ${soldBody}
    </table></div>` : ''}

    <h4 style="margin:16px 0 6px;">거래 내역 <span class="muted small">(${sum.trades.length}건)</span></h4>
    <div class="tbl-wrap"><table class="tbl">${tradeBody}</table></div>

    <p class="hint">같은 종목을 여러 번 샀으면 보유 표에서 <b>한 줄로 합산</b>합니다 — 평균 단가는 수량으로 가중한 값이고 매수 수수료가 포함됩니다.
    평가액은 매수 건마다 그날 이후의 <b>수정종가</b> 변동을 적용해 더한 값입니다(배당·액면분할 반영) — 홈의 보유 종목과 같은 방식.
    매도 원가는 먼저 산 것부터(선입선출) 매기고, 매도 수수료·세금은 매도 대금에서 뺍니다.</p>`;
}

// ---------- 목록 ----------
function vVirtual() {
  const funds = E.virtualFunds(state);

  const cards = funds.map(({ v, sum }) => {
    const isOpen = openFundId === v.id;
    return `
    <div class="card">
      <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div style="min-width:0;">
          <h3 style="margin:0;">${esc(v.name)}</h3>
          <div class="muted small">보유 ${sum.rows.length}종목 · 거래 ${sum.trades.length}건${v.note ? ' · ' + esc(v.note) : ''}</div>
        </div>
        <div style="margin-left:auto; text-align:right; white-space:nowrap;">
          <div style="font-size:17px; font-weight:700;">${sum.trades.length ? fmtMoney(sum.totalKRW) : '–'}</div>
          ${sum.netRet != null
            ? `<div class="small ${pctClass(sum.netProfitKRW)}">${fmtSigned(sum.netProfitKRW)} · ${fmtPct(sum.netRet)}</div>`
            : (sum.ret != null ? `<div class="small ${pctClass(sum.profitKRW)}">${fmtSigned(sum.profitKRW)} · ${fmtPct(sum.ret)}</div>` : '')}
        </div>
      </div>
      <div class="btn-row" style="margin:10px 0 0; flex-wrap:wrap;">
        <button class="btn small ${isOpen ? 'primary' : ''}" data-toggle="${v.id}">${isOpen ? '접기' : '보기'}</button>
        <button class="btn small" data-addpos="${v.id}">가상 매수</button>
        <button class="btn small" data-sell="${v.id}">가상 매도</button>
        <button class="btn small" data-cash="${v.id}">현금</button>
        <button class="btn small" data-edit="${v.id}">이름·메모</button>
        <button class="btn small danger" style="margin-left:auto;" data-delfund="${v.id}">펀드 삭제</button>
      </div>
      ${isOpen ? `<div style="margin-top:12px;">
        ${sum.trades.length ? `<dl class="hero-facts" style="margin:0 0 10px;">
          <dt>투입 원금</dt><dd>${fmtMoney(sum.investedKRW)}
            <span class="muted small">${sum.seed > 0 ? '설정 금액' : '매매에 든 돈(자동)'}</span></dd>
          <dt>현금</dt><dd>${fmtMoney(sum.cashKRW)}${sum.cash.USD ? ` <span class="muted small">(${fmtMoney(sum.cash.KRW)} + ${fmtMoney(sum.cash.USD, 'USD')})</span>`
            : (!sum.manualCash && sum.seed > 0 ? ' <span class="muted small">아직 안 산 돈(자동)</span>' : '')}</dd>
          <dt>총자산</dt><dd><b>${fmtMoney(sum.totalKRW)}</b> <span class="muted small">보유 평가액 + 현금</span></dd>
          ${sum.netRet != null ? `<dt>결산</dt><dd class="${pctClass(sum.netProfitKRW)}">
            <b>${fmtSigned(sum.netProfitKRW)}</b> (${fmtPct(sum.netRet)}) <span class="muted small">총자산 − 투입 원금</span></dd>` : ''}
          <dt class="muted">매입액</dt><dd class="muted">${fmtMoney(sum.costKRW)} → 평가 ${fmtMoney(sum.valueKRW)}
            <span class="${pctClass(sum.profitKRW)}">${fmtSigned(sum.profitKRW)} (${fmtPct(sum.ret)})</span></dd>
          ${sum.realized.length ? `<dt class="muted">실현손익</dt><dd class="${pctClass(sum.realizedKRW)}">${fmtSigned(sum.realizedKRW)}</dd>` : ''}
        </dl>` : ''}
        ${fundDetail(v, sum)}
      </div>` : ''}
    </div>`;
  }).join('');

  return `
    <div class="view-title">가상</div>
    <p class="view-desc">사지 않은 종목으로 만드는 장부. "그때 그 값에 그만큼 샀다면 지금 얼마인가"만 봅니다 — 실제 펀드와는 완전히 분리돼 있어 수익률·기록 어디에도 섞이지 않습니다.</p>
    <div class="btn-row" style="margin:0 0 12px;">
      <button class="btn primary" data-x="newfund">새 가상 펀드</button>
    </div>
    ${funds.length ? cards : '<div class="card"><div class="empty">아직 가상 펀드가 없습니다 — 하나 만들어 보세요</div></div>'}`;
}

vVirtual.bind_ = (root) => {
  const find = findFund;

  root.querySelector('[data-x=newfund]')?.addEventListener('click', () => openFundModal());

  root.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    openFundId = openFundId === b.dataset.toggle ? null : b.dataset.toggle;
    render();
  }));

  root.querySelectorAll('[data-addpos]').forEach(b => b.addEventListener('click', () => {
    const v = find(b.dataset.addpos);
    if (v) { openFundId = v.id; openPositionModal(v); }
  }));

  root.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', () => {
    const v = find(b.dataset.sell);
    if (v) { openFundId = v.id; openSellModal(v); }
  }));

  root.querySelectorAll('[data-cash]').forEach(b => b.addEventListener('click', () => {
    const v = find(b.dataset.cash);
    if (v) { openFundId = v.id; openCashModal(v); }
  }));

  root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const v = find(b.dataset.edit);
    if (v) openFundModal(v);
  }));

  root.querySelectorAll('[data-delpos]').forEach(b => b.addEventListener('click', async () => {
    const [vid, pid] = b.dataset.delpos.split('|');
    const v = find(vid);
    if (!v) return;
    const p = (v.positions || []).find(x => x.id === pid);
    // 같은 종목을 여러 번 사고팔 수 있으므로 어느 건인지 매수/매도·날짜·수량으로 못박아 보여 준다.
    // 매수를 지우면 그 뒤 매도의 원가가 다시 매겨진다(선입선출) — 그 점도 알린다.
    const isBuy = !p || p.side !== 'sell';
    if (!await confirmModal({
      title: `이 ${isBuy ? '매수' : '매도'} 기록을 지울까요?`,
      body: p
        ? `${P.info(p.symbol)?.name || p.name || p.symbol}\n${p.date} · ${fmtQty(p.qty)}주 @ ${fmtMoney(p.price, P.currencyOf(p.symbol))}`
          + (isBuy && (v.positions || []).some(x => x.side === 'sell' && x.symbol === p.symbol)
              ? '\n\n이 종목의 매도 기록이 있어, 지우면 실현손익이 다시 계산됩니다.' : '')
        : '',
      okLabel: '지우기', danger: true,
    })) return;
    // 확인창을 띄운 사이 동기화가 배열을 갈아끼웠을 수 있으므로 지금 다시 찾는다
    const cur = find(vid);
    if (!cur) { render(); return; }
    cur.positions = (cur.positions || []).filter(x => x.id !== pid);
    cur.updatedAt = Date.now();
    saveNow(); render(); toast('뺐습니다');
  }));

  root.querySelectorAll('[data-delfund]').forEach(b => b.addEventListener('click', async () => {
    const v = find(b.dataset.delfund);
    if (!v) return;
    if (!await confirmModal({
      title: '가상 펀드를 삭제할까요?',
      body: `"${v.name}" 과 그 안의 종목 ${(v.positions || []).length}개가 사라집니다. 되돌릴 수 없습니다.`,
      okLabel: '삭제', danger: true,
    })) return;
    // 삭제는 반드시 tombstone과 함께 — 안 그러면 다른 기기의 사본이 되살린다
    state.virtuals = (state.virtuals || []).filter(x => x.id !== v.id);
    state.deleted = state.deleted || {};
    state.deleted[v.id] = Date.now();
    if (openFundId === v.id) openFundId = null;
    saveNow(); render(); toast('삭제했습니다');
  }));
};

registerView('virtual', vVirtual);

// 화면: 평행우주, 개입 점수, 홀딩 일지
import { state, saveNow, toast, registerView, render, confirmModal, openModal, closeModal } from './core.js';
import * as Store from './store.js';
import * as P from './prices.js';
import * as E from './engine.js';
import { uid, todayStr, esc, fmtMoney, fmtPct, fmtQty, pctClass, bindThousands, numOf } from './util.js';
import { lineChart, moneyShort, bindCharts } from './chart.js';

const C = {
  actual: '#0f9d6a', kospi: '#8a8a8a', sp500: '#8b5cc9', coke: '#e0553b', bank: '#3b7ea1', deposits: '#c65ea8',
};

// ---------- 평행우주 ----------
function vWorlds() {
  const w = E.worlds(state);
  if (!w) {
    return `<div class="view-title">만약</div>
      <p class="view-desc">매매 기록이 생기면, "다르게 했다면 지금 얼마인가"를 자동 계산합니다.</p>
      <div class="empty">아직 매수 기록이 없습니다</div>`;
  }
  const li = w.dates.length - 1;
  const pf = E.portfolio(state);
  const rows = [
    ['실제의 나', w.actual[li], C.actual, `기록한 그대로 — 보유 주식${pf.cashTracked ? ' + 입력한 현금' : ' (현금 미입력)'}`],
    ['코스피만 산 나', w.kospi[li], C.kospi, '원금을 넣은 날 같은 금액으로 코스피 지수만 매수'],
    ['S&P500만 산 나', w.sp500[li], C.sp500, '원금을 넣은 날 같은 금액으로 S&P500만 매수'],
    ['코카콜라만 산 나', w.coke[li], C.coke, '원금을 넣은 날 같은 금액으로 코카콜라(KO)만 매수 (배당 재투자)'],
    ['예금만 한 나', w.bank[li], C.bank, `원금을 넣은 날 같은 금액을 연 ${w.rate}% 예금에 (설정에서 금리 변경)`],
  ];
  const dep = w.deposits[li];
  const best = Math.max(...rows.map(r => r[1]));

  // 현금 입력으로 자본이 한 번에 조정된 지점 — 그래프에 표시하고 아래에 이유를 적는다.
  // (안 적으면 투입 원금 선이 이유 없이 절벽처럼 꺾여 보여 "왜 이러지?"가 된다.)
  const adj = (w.cashAdj || []).filter(a => Math.abs(a.amtKRW) >= 10000);
  const chart = lineChart({
    labels: w.dates,
    markers: adj.map(a => ({ date: a.date, label: `${a.date.slice(5).replace('-', '.')} 현금 반영` })),
    format: v => fmtMoney(v),   // 툴팁엔 정확한 금액(축 눈금은 축약)
    series: [
      { label: '실제의 나', color: C.actual, values: w.actual },
      { label: '코스피만', color: C.kospi, values: w.kospi },
      { label: 'S&P500만', color: C.sp500, values: w.sp500 },
      { label: '코카콜라만', color: C.coke, values: w.coke },
      { label: '예금만', color: C.bank, values: w.bank },
      { label: '투입 원금', color: C.deposits, values: w.deposits, dash: true },
    ],
  });

  // 투입 원금이 꺾인 이유 — 길고 대부분은 안 궁금한 내용이라 본문 맨 아래에 접어 둔다.
  const adjNote = adj.length ? `
    <details class="acc" style="margin-top:8px;">
      <summary>투입 원금이 계단처럼 꺾이는 지점이 있습니다 — 이유 보기 (${adj.length}건)</summary>
      <div class="small" style="margin-top:8px;">
        ${adj.map(a => {
          const out = a.amtKRW < 0;
          return `· <b>${esc(a.date)}</b> 입력하신 현금 잔액이 앱 장부보다 ${out ? '적어' : '많아'},
            <b class="${pctClass(a.amtKRW)}">${fmtMoney(Math.abs(a.amtKRW))}</b>을
            ${out ? '펀드 밖으로 나간 돈(회수)' : '새로 넣은 돈(투입)'}으로 반영했습니다.`;
        }).join('<br>')}
        <br><br>앱은 매도 대금을 장부에 쌓아 두는데(pool), 실제 잔액이 그보다 적으면
        그 차액은 <b>펀드 밖으로 나간 것</b>으로 봅니다 — 다른 곳에 썼든 인출했든 이 펀드에서는 빠진 돈이니까요.
        금액은 맞고, 여러 시점에 걸쳐 나간 돈이 <b>현금을 입력한 날 한 번에</b> 반영돼 계단이 가팔라 보일 뿐입니다.
      </div>
    </details>` : '';

  return `
    <div class="view-title">만약</div>
    <p class="view-desc">같은 돈으로 다르게 했다면. 계좌 잔고는 누구나 보지만, 대안과의 차이는 아무도 보여주지 않습니다.</p>
    <div class="card">
      <h3>현재 가치 (투입 원금 ${fmtMoney(dep)})</h3>
      <div class="tbl-wrap"><table class="tbl">
        <tr><th>세계</th><th class="num">현재 가치</th><th class="num">수익률</th><th class="num">실제 대비</th></tr>
        ${rows.map(([label, v, color, note]) => `
          <tr>
            <td><span class="sw" style="background:${color}; display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px;"></span><b>${label}</b>${v === best ? ' <span style="color:var(--accent);">★</span>' : ''}<br><span class="muted small">${note}</span></td>
            <td class="num">${fmtMoney(v)}</td>
            <td class="num ${pctClass(v / dep - 1)}">${fmtPct(dep > 0 ? v / dep - 1 : null)}</td>
            <td class="num ${pctClass(v - rows[0][1])}">${label === '실제의 나' ? '—' : fmtMoney(v - rows[0][1])}</td>
          </tr>`).join('')}
      </table></div>
      <p class="hint">투입 원금은 <b>밖에서 새로 끌어온 돈</b>만 셉니다 — 판 돈으로 다시 산 것은 새 투입이 아니므로, 매매를 많이 했다고 원금이 불어나지 않습니다.
      모든 세계가 같은 날 같은 금액을 굴리므로 비교는 공정합니다. 가정: 배당 재투자 · 달러는 당일 환율 환산 · 예금은 연 ${w.rate}% 복리(세전).</p>
    </div>
    <div class="card">${chart}</div>
    <p class="small muted" style="margin:0 2px;">매도·물타기 하나하나의 채점은 <a href="#/actions">회상</a>에서.</p>
    ${adjNote}`;
}
vWorlds.bind_ = (root) => bindCharts(root);
registerView('worlds', vWorlds);

// ---------- 개입 점수 ----------
// 조회 조건(전체/연도별/종목별). 화면을 다시 그려도 유지된다.
let actionsFilter = { year: null, symbol: null };

function vActions() {
  const ss = E.sellScores(state);
  const ad = E.avgDownBuys(state);

  const g2p = g => g == null ? '–' : fmtPct(g - 1);
  const g2c = g => g == null ? 'flat' : pctClass(g - 1);

  // 조회 조건 적용
  const { year, symbol } = actionsFilter;
  const keep = (date, sym) => (!year || date.slice(0, 4) === year) && (!symbol || sym === symbol);
  // 매도 목록은 최신순 — 방금 판 것이 가장 궁금하다. (replay가 주는 순서는 오래된 것부터)
  const sellRows = ss.rows.filter(x => keep(x.r.sell.date, x.sym))
    .sort((a, b) => a.r.sell.date < b.r.sell.date ? 1 : a.r.sell.date > b.r.sell.date ? -1 : 0);
  const adRows = ad.rows.filter(x => keep(x.t.date, x.t.symbol));

  // 조회 조건 UI — 연도·종목 목록은 실제 기록에서 뽑는다
  const years = [...new Set([
    ...ss.rows.map(x => x.r.sell.date.slice(0, 4)),
    ...ad.rows.map(x => x.t.date.slice(0, 4)),
  ])].sort().reverse();
  const symMap = new Map();
  for (const x of ss.rows) symMap.set(x.sym, x.name);
  for (const x of ad.rows) if (!symMap.has(x.t.symbol)) symMap.set(x.t.symbol, x.t.name || x.t.symbol);
  const symOpts = [...symMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko'))
    .map(([s, n]) => `<option value="${esc(s)}" ${symbol === s ? 'selected' : ''}>${esc(n)}</option>`).join('');

  const filterBar = `
    <div class="card" style="padding:10px 12px;">
      <div class="btn-row" style="margin:0; flex-wrap:wrap; align-items:center;">
        <button class="btn small ${!year ? 'primary' : ''}" data-year="">전체 기간</button>
        ${years.map(y => `<button class="btn small ${year === y ? 'primary' : ''}" data-year="${y}">${y}년</button>`).join('')}
        <select data-symsel style="margin-left:auto; border:1px solid var(--line); border-radius:8px; padding:6px 8px; background:var(--bg); color:inherit; max-width:190px;">
          <option value="">종목 전체</option>
          ${symOpts}
        </select>
      </div>
      ${symbol ? `<div class="small" style="margin-top:8px;">
        <span class="tag">${esc(symMap.get(symbol) || symbol)}</span> 관련 개입만 보는 중
        <button class="btn small" data-clearsym style="margin-left:6px;">✕ 종목 조건 해제</button>
      </div>` : ''}
    </div>`;

  const scoped = [year ? `${year}년` : null, symbol ? (symMap.get(symbol) || symbol) : null].filter(Boolean).join(' · ');
  const scopeNote = scoped ? `<span class="muted small" style="font-weight:400;"> — ${esc(scoped)}</span>` : '';

  // 조회된 것만으로 다시 집계
  const scoredSell = sellRows.filter(x => x.horizon.now != null);
  const avgMissed = scoredSell.length
    ? scoredSell.reduce((s, x) => s + (x.horizon.now - 1), 0) / scoredSell.length : null;
  const scoredAd = adRows.filter(x => x.delta != null);
  const avgDelta = scoredAd.length ? scoredAd.reduce((s, x) => s + x.delta, 0) / scoredAd.length : null;

  const sellBody = sellRows.map(({ r, sym, name, horizon, frozenSince }) => `
    <tr>
      <td>
        <b class="symlink" data-symlink="${esc(sym)}">${esc(name)}</b>
        <br><span class="muted small">${r.sell.date} · ${fmtQty(r.sell.qty)}주</span>
      </td>
      ${E.SELL_HORIZONS.map(m => `<td class="num ${g2c(horizon['m' + m])}">${g2p(horizon['m' + m])}</td>`).join('')}
      <td class="num ${g2c(horizon.now)}"><b>${g2p(horizon.now)}</b>${frozenSince ? `<br><span class="muted small" title="거래정지·상장폐지로 시세가 멈춰 있습니다">${frozenSince} 정지</span>` : ''}</td>
    </tr>`).join('');

  const adBody = adRows.map(x => `
    <tr>
      <td>
        <b class="symlink" data-symlink="${esc(x.t.symbol)}">${esc(x.t.name || x.t.symbol)}</b>
        <br><span class="muted small">${x.t.date} · ${fmtQty(x.t.qty)}주 @ ${fmtMoney(x.t.price, P.currencyOf(x.t.symbol))}</span>
      </td>
      <td class="num ${g2c(x.growth)}">${g2p(x.growth)}</td>
      <td class="num ${g2c(x.benchGrowth)}">${g2p(x.benchGrowth)}</td>
      <td class="num ${x.delta == null ? 'flat' : pctClass(x.delta)}"><b>${x.delta == null ? '–' : fmtPct(x.delta) + 'P'}</b></td>
    </tr>`).join('');

  return `
    <div class="view-title">회상</div>
    <p class="view-desc">내 손이 계좌에 닿은 순간들. 판 뒤 그 주식이 어떻게 됐는지, 물타기한 돈이 지수보다 나았는지를 보여줍니다. 잘잘못은 판정하지 않습니다 — 판 돈을 어디에 썼는지는 당신만 압니다.</p>
    ${filterBar}
    <div class="card">
      <h3>매도 채점 — 판 뒤 그 주식은 어떻게 됐나${scopeNote}</h3>
      ${sellRows.length ? `
      <div class="tbl-wrap"><table class="tbl">
        <tr><th>매도</th>${E.SELL_HORIZONS.map(m => `<th class="num">+${m}개월</th>`).join('')}<th class="num">현재까지</th></tr>
        ${sellBody}
      </table></div>
      ${scoredSell.length ? `<p class="small" style="margin-bottom:0;">
        매도 ${scoredSell.length}건. 판 종목들은 매도 후 현재까지 평균 <b class="${pctClass(avgMissed)}">${fmtPct(avgMissed)}</b> 움직였습니다.
      </p>` : ''}` : '<div class="empty">조회 조건에 맞는 매도 기록이 없습니다</div>'}
      <p class="hint">배당·분할·병합 반영 기준(매도일 100 대비). 종목명을 누르면 그 종목의 개입만 모아 봅니다.
      "정지"는 거래정지·상장폐지로 시세가 그 날짜에 멈췄다는 뜻이라, 그 종목의 "현재까지"는 사실 그날까지입니다.</p>
    </div>
    <div class="card">
      <h3>물타기 채점 — 평단 아래 추가 매수, 그 돈의 성적${scopeNote}</h3>
      ${adRows.length ? `
      <div class="tbl-wrap"><table class="tbl">
        <tr><th>추가 매수</th><th class="num">이후 종목</th><th class="num">같은 기간 지수</th><th class="num">지수 대비</th></tr>
        ${adBody}
      </table></div>
      ${avgDelta != null ? `<p class="small" style="margin-bottom:0;">
        물타기 ${adRows.length}회. 그 돈을 그냥 지수에 넣었을 때와 비교해 평균 <b class="${pctClass(avgDelta)}">${fmtPct(avgDelta)}P</b>.
      </p>` : ''}` : '<div class="empty">조회 조건에 맞는 물타기 매수가 없습니다</div>'}
      <p class="hint">물타기 = 이미 보유 중인 종목을 평균 단가보다 싸게 추가 매수한 것. 한국 종목은 코스피, 미국 종목은 S&P500과 비교합니다.</p>
    </div>`;
}
vActions.bind_ = (root) => {
  root.querySelectorAll('[data-year]').forEach(b => b.addEventListener('click', () => {
    actionsFilter.year = b.dataset.year || null; render();
  }));
  root.querySelector('[data-symsel]')?.addEventListener('change', e => {
    actionsFilter.symbol = e.target.value || null; render();
  });
  root.querySelector('[data-clearsym]')?.addEventListener('click', () => {
    actionsFilter.symbol = null; render();
  });
  root.querySelectorAll('[data-symlink]').forEach(b => b.addEventListener('click', () => {
    actionsFilter.symbol = b.dataset.symlink; render();
  }));
};
registerView('actions', vActions);

// ---------- 관심 종목 ----------
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

function openSwapModal() {
  const pf = E.portfolio(state);
  if (!pf.rows.length) { toast('보유 종목이 있어야 교체 시뮬레이션을 만들 수 있습니다'); return; }
  const fromOpts = pf.rows.map(r =>
    `<option value="${esc(r.symbol)}" data-name="${esc(r.name)}" data-qty="${r.qty}">${esc(r.name)} — 보유 ${fmtQty(r.qty)}주</option>`).join('');
  const toOpts = [...new Set([
    ...(state.watchlist || []).map(w => w.symbol),
    ...P.symbols().filter(s => !s.startsWith('^') && s !== 'KRW=X'),
  ])].filter(s => s).map(s => {
    const w = (state.watchlist || []).find(x => x.symbol === s);
    const nm = w?.name || P.info(s)?.name || s;
    return `<option value="${esc(s)}" data-name="${esc(nm)}">${esc(nm)} (${esc(s)})</option>`;
  }).join('');
  const m = openModal(`
    <h2>교체 시뮬레이션</h2>
    <p class="small muted" style="margin-top:-6px;">"이걸 팔아 저걸 샀다면"을 저장해 두면, 하지 않은 선택의 성적을 계속 채점해 줍니다.</p>
    <form id="swap-form">
      <div class="form-grid">
        <label class="fld">판다고 가정 (보유)
          <select name="from">${fromOpts}</select>
        </label>
        <label class="fld">수량
          <input type="number" name="qty" step="any" min="0" inputmode="decimal" required>
        </label>
        <label class="fld">산다고 가정
          <select name="to">${toOpts}</select>
        </label>
        <label class="fld">기준일
          <input type="date" name="date" max="${todayStr()}" value="${todayStr()}" required>
        </label>
        <label class="fld full">메모 (왜 고민했나, 왜 결국 안 했나)
          <textarea name="note" placeholder="예: 성장은 B가 좋아 보이지만, 세금과 확신 부족으로 보류."></textarea>
        </label>
      </div>
      <div class="btn-row" style="justify-content:flex-end;">
        <button type="button" class="btn" data-x="cancel">취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`);
  const form = m.querySelector('#swap-form');
  const syncQty = () => {
    const opt = form.from.selectedOptions[0];
    if (opt && !form.qty.value) form.qty.value = opt.dataset.qty;
  };
  form.from.addEventListener('change', () => { form.qty.value = ''; syncQty(); });
  syncQty();
  m.querySelector('[data-x=cancel]').onclick = closeModal;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const qty = parseFloat(form.qty.value);
    if (!(qty > 0)) { toast('수량을 확인하세요'); return; }
    const fromOpt = form.from.selectedOptions[0], toOpt = form.to.selectedOptions[0];
    if (fromOpt.value === toOpt.value) { toast('같은 종목끼리는 비교할 수 없습니다'); return; }
    state.swaps.push({
      id: uid(), date: form.date.value,
      fromSymbol: fromOpt.value, fromName: fromOpt.dataset.name, fromQty: qty,
      toSymbol: toOpt.value, toName: toOpt.dataset.name,
      note: form.note.value.trim(),
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    saveNow(); closeModal(); render(); toast('저장했습니다. 이제부터 이 가정이 채점됩니다.');
  });
}

function vWatch() {
  const rows = E.watchRows(state);
  const active = rows.filter(r => !r.w.archived);
  const archived = rows.filter(r => r.w.archived);
  const agg = E.watchAgg(state);
  const swaps = E.swapRows(state);
  const today = todayStr();
  const knownList = P.symbols().filter(s => !s.startsWith('^') && s !== 'KRW=X')
    .map(s => `<option value="${esc(s)}">${esc(P.info(s)?.name || '')}</option>`).join('');

  const itemHtml = (r, isArchived) => {
    const { w } = r;
    const cur = P.currencyOf(w.symbol);
    return `
    <li>
      <div class="trade-head">
        <b>${esc(w.name || w.symbol)}</b>
        <span class="dt muted small">${esc(w.symbol)} · ${w.date} 등록${w.sample ? ' · 예시' : ''}</span>
        <span class="amt small">${r.p0 != null ? `등록일 ${fmtMoney(r.p0, cur)} → ${r.last ? fmtMoney(r.last.close, cur) : '–'}` : '<span class="muted">시세 대기 중</span>'}</span>
      </div>
      ${r.gNow != null ? `
      <div class="trade-meta" style="margin-top:6px;">
        <span>그날 샀다면 <b class="${pctClass(r.gNow - 1)}">${fmtPct(r.gNow - 1)}</b></span>
        <span>같은 기간 지수 <span class="${pctClass(r.gBench - 1)}">${fmtPct(r.gBench != null ? r.gBench - 1 : null)}</span></span>
        ${r.alpha != null ? `<span>차이 <b class="${pctClass(r.alpha)}">${fmtPct(r.alpha)}</b></span>` : ''}
        ${r.buy ? `<span class="tag">${r.buy.date} 실제 매수</span>${r.waitG != null ? `<span>기다린 동안 <b class="${pctClass(r.waitG - 1)}">${fmtPct(r.waitG - 1)}</b>${r.waitG > 1.03 ? ' — 기다림이 비쌌다' : r.waitG < 0.97 ? ' — 기다린 보람이 있었다' : ''}</span>` : ''}` : ''}
        ${isArchived && r.gSinceArchive != null ? `<span>접은 뒤 <b class="${pctClass(r.gSinceArchive - 1)}">${fmtPct(r.gSinceArchive - 1)}</b>${r.gSinceArchive > 1.05 ? ' — 아쉬운 이별' : r.gSinceArchive < 0.95 ? ' — 접길 잘했다' : ''}</span>` : ''}
      </div>` : ''}
      ${w.thesis ? `<div class="trade-body">${esc(w.thesis)}</div>` : ''}
      ${w.trigger ? `<div class="trade-body" style="margin-top:2px;"><span class="tag">매수 조건</span> ${esc(w.trigger)}</div>` : ''}
      <div class="trade-meta">
        <span style="margin-left:auto; white-space:nowrap;">
          ${isArchived
            ? `<button class="btn small" data-unarch="${w.id}">다시 지켜보기</button>`
            : `<button class="btn small" data-arch="${w.id}">관심 접기</button>`}
          <button class="btn small danger" data-del="${w.id}">삭제</button>
        </span>
      </div>
    </li>`;
  };

  const swapItems = swaps.map(x => `
    <li>
      <div class="trade-head">
        <b>${esc(x.s.fromName || x.s.fromSymbol)} ${fmtQty(x.s.fromQty)}주 → ${esc(x.s.toName || x.s.toSymbol)}</b>
        <span class="dt muted small">${x.s.date} 기준${x.s.sample ? ' · 예시' : ''}${x.qtyB != null ? ` · 환산 ${fmtQty(Math.round(x.qtyB * 100) / 100)}주` : ''}</span>
      </div>
      ${x.keptKRW != null && x.swapKRW != null ? `
      <div class="trade-meta" style="margin-top:6px;">
        <span>그대로 뒀다면 <b>${fmtMoney(x.keptKRW)}</b></span>
        <span>바꿨다면 <b>${fmtMoney(x.swapKRW)}</b></span>
        <span>차이 <b class="${pctClass(x.delta)}">${fmtMoney(x.delta)}</b> ${x.delta > 0 ? '— 바꾸는 게 나았다' : x.delta < 0 ? '— 안 바꾸길 잘했다' : ''}</span>
      </div>` : '<div class="trade-meta"><span class="muted">시세 대기 중</span></div>'}
      ${x.s.note ? `<div class="trade-body">${esc(x.s.note)}</div>` : ''}
      <div class="trade-meta"><span style="margin-left:auto;"><button class="btn small danger" data-delswap="${x.s.id}">삭제</button></span></div>
    </li>`).join('');

  return `
    <div class="view-title">관심 종목</div>
    <p class="view-desc">사는 것만 판단이 아닙니다. 안 산 것, 안 바꾼 것도 판단이고 — 여기서는 그 판단도 채점받습니다.</p>
    ${agg && agg.count >= 2 ? `
    <div class="card">
      <h3>안목 점수</h3>
      <p class="small" style="margin:4px 0 0;">
        관심 등록한 ${agg.count}개 종목은 등록 후 평균 <b class="${pctClass(agg.avgG)}">${fmtPct(agg.avgG)}</b>,
        같은 기간 지수는 <b class="${pctClass(agg.avgBench)}">${fmtPct(agg.avgBench)}</b>.
        당신의 눈은 지수 대비 <b class="${pctClass(agg.avgAlpha)}">${fmtPct(agg.avgAlpha)}</b>p입니다.
      </p>
    </div>` : ''}
    <div class="card">
      <h3>관심 등록</h3>
      <form id="watch-form">
        <div class="form-grid">
          <label class="fld">종목
            <input name="symbol" list="watch-symlist" placeholder="티커 (예: 005930 또는 AAPL)" required autocomplete="off">
            <datalist id="watch-symlist">${knownList}</datalist>
          </label>
          <label class="fld">등록일
            <input type="date" name="date" max="${today}" value="${today}" required>
          </label>
          <label class="fld full">왜 눈여겨보는가 — 그리고 왜 아직 안 사는가
            <textarea name="thesis" placeholder="이 글이 나중에 이 종목에 대한 내 판단력의 증거가 됩니다."></textarea>
          </label>
          <label class="fld full">어떤 조건이 되면 살 것인가
            <textarea name="trigger" placeholder="예: 다음 분기 실적에서 마진 개선이 확인되면"></textarea>
          </label>
        </div>
        <div class="btn-row" style="justify-content:flex-end;"><button class="btn primary" type="submit">등록</button></div>
      </form>
    </div>
    <div class="card">
      <h3>지켜보는 중 ${active.length ? `(${active.length})` : ''}</h3>
      ${active.length ? `<ul class="list-plain">${active.map(r => itemHtml(r, false)).join('')}</ul>` : '<div class="empty">아직 관심 종목이 없습니다</div>'}
    </div>
    <div class="card">
      <h3>교체 시뮬레이션 — 하지 않은 선택의 성적</h3>
      <div class="btn-row" style="margin:0 0 6px;"><button class="btn primary" data-x="newswap">새 시뮬레이션</button></div>
      ${swapItems ? `<ul class="list-plain">${swapItems}</ul>` : '<div class="empty">아직 저장된 가정이 없습니다</div>'}
    </div>
    ${archived.length ? `
    <div class="card">
      <h3>접어둔 종목 (${archived.length})</h3>
      <ul class="list-plain">${archived.map(r => itemHtml(r, true)).join('')}</ul>
    </div>` : ''}`;
}
vWatch.bind_ = (root) => {
  root.querySelector('#watch-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const symbol = P.resolveSymbol(f.symbol.value);
    if (!symbol) { toast('종목을 입력하세요'); return; }
    if ((state.watchlist || []).some(w => w.symbol === symbol && !w.archived)) { toast('이미 지켜보는 종목입니다'); return; }
    state.watchlist.push({
      id: uid(), symbol, name: P.info(symbol)?.name || symbol,
      date: f.date.value, thesis: f.thesis.value.trim(), trigger: f.trigger.value.trim(),
      archived: false, createdAt: Date.now(), updatedAt: Date.now(),
    });
    ensureTicker(symbol);
    saveNow(); render(); toast('등록했습니다. 오늘부터 이 판단이 채점됩니다.');
  });
  root.querySelector('[data-x=newswap]').addEventListener('click', openSwapModal);
  root.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', () => {
    const w = state.watchlist.find(x => x.id === b.dataset.arch);
    if (w) { w.archived = true; w.archivedAt = todayStr(); w.updatedAt = Date.now(); saveNow(); render(); toast('접었습니다. 이후에도 조용히 추적합니다.'); }
  }));
  root.querySelectorAll('[data-unarch]').forEach(b => b.addEventListener('click', () => {
    const w = state.watchlist.find(x => x.id === b.dataset.unarch);
    if (w) { w.archived = false; w.updatedAt = Date.now(); saveNow(); render(); }
  }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: '관심 종목 삭제', body: '기록과 채점이 함께 사라집니다. "관심 접기"는 기록을 남기면서 목록만 정리합니다.', okLabel: '삭제', danger: true });
    if (!ok) return;
    Store.removeItem(state, 'watchlist', b.dataset.del);
    saveNow(); render();
  }));
  root.querySelectorAll('[data-delswap]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: '시뮬레이션 삭제', body: '이 가정의 채점 기록을 삭제합니다.', okLabel: '삭제', danger: true });
    if (!ok) return;
    Store.removeItem(state, 'swaps', b.dataset.delswap);
    saveNow(); render();
  }));
};
registerView('watch', vWatch);

// ---------- 홀딩 일지 ----------
function vDiary() {
  const pf = E.portfolio(state);
  const opts = pf.rows.map(r => `<option value="${esc(r.symbol)}">${esc(r.name)} (${esc(r.symbol)})</option>`).join('');
  const rows = E.diaryRows(state);

  const items = rows.map(({ e, p0, gNow, g3, verdict }) => {
    const name = state.trades.find(t => t.symbol === e.symbol)?.name || e.symbol;
    return `
    <li>
      <div class="trade-head">
        <span class="tag ${e.urge === 'sell' ? 'sell' : 'buy'}">${e.urge === 'sell' ? '팔고 싶었다' : '더 사고 싶었다'}</span>
        <b>${esc(name)}</b>
        <span class="dt muted small">${e.date}${e.sample ? ' · 예시' : ''}</span>
        <span class="amt small muted">${p0 ? '그날 ' + fmtMoney(p0, P.currencyOf(e.symbol)) : ''}</span>
      </div>
      ${e.note ? `<div class="trade-body">${esc(e.note)}</div>` : ''}
      <div class="trade-meta">
        ${g3 != null ? `<span>3개월 뒤 <b class="${pctClass(g3 - 1)}">${fmtPct(g3 - 1)}</b></span>` : ''}
        ${verdict ? `<span class="${verdict.cls}"><b>${verdict.text}</b></span>` : '<span class="muted">시세 데이터 없음</span>'}
        <button class="btn small danger" style="margin-left:auto;" data-del="${e.id}">삭제</button>
      </div>
    </li>`;
  }).join('');

  return `
    <div class="view-title">홀딩 일지</div>
    <p class="view-desc">투자에서 제일 어려운 건 사고파는 순간이 아니라 들고 있는 동안입니다. 흔들린 순간을 남기면, 그 감정이 신호였는지 소음이었는지 나중에 채점해 줍니다.</p>
    <div class="card">
      <h3>오늘의 기록</h3>
      ${pf.rows.length ? `
      <form id="diary-form">
        <div class="form-grid">
          <label class="fld">종목<select name="symbol">${opts}</select></label>
          <label class="fld">지금 마음은
            <select name="urge">
              <option value="sell">팔고 싶다</option>
              <option value="buy">더 사고 싶다</option>
            </select>
          </label>
          <label class="fld full">한 줄 메모 — 왜 그런 마음이 드는가
            <textarea name="note" placeholder="예: 폭락 기사가 쏟아진다. 다 팔고 도망가고 싶다." required></textarea>
          </label>
        </div>
        <div class="btn-row" style="justify-content:flex-end;"><button class="btn primary" type="submit">기록</button></div>
      </form>` : '<div class="empty">보유 종목이 있어야 일지를 쓸 수 있습니다</div>'}
    </div>
    <div class="card">
      <h3>지난 기록과 채점</h3>
      ${items ? `<ul class="list-plain">${items}</ul>` : '<div class="empty">아직 일지가 없습니다</div>'}
    </div>`;
}
vDiary.bind_ = (root) => {
  root.querySelector('#diary-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const symbol = f.symbol.value;
    state.diary.push({
      id: uid(), symbol, date: todayStr(), urge: f.urge.value,
      note: f.note.value.trim(),
      priceAtEntry: P.last(symbol)?.close ?? null,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    saveNow(); render(); toast('기록했습니다. 몇 달 뒤 이 감정이 채점됩니다.');
  });
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: '일지 삭제', body: '이 일지 항목을 삭제합니다.', okLabel: '삭제', danger: true });
    if (!ok) return;
    Store.removeItem(state, 'diary', b.dataset.del);
    saveNow(); render();
  }));
};
registerView('diary', vDiary);

// ---------- 투자 비용 (대출 이자) ----------
function openLoanModal(existing) {
  const l = existing || {};
  const m = openModal(`
    <h2>${existing ? '대출 계좌 수정' : '대출 계좌 추가'}</h2>
    <p class="small muted" style="margin-top:-6px;">대출 계좌마다 한 건씩 등록하세요. 각 계좌는 시작일부터 (상환일 또는) 지금까지 따로따로 이자가 쌓입니다.</p>
    <form id="loan-form">
      <div class="form-grid">
        <label class="fld full">계좌 이름 / 종류<input name="name" placeholder="예: 마이너스통장, ○○은행 신용대출" value="${esc(l.name || l.kind || '')}" required></label>
        <label class="fld">최초 대출 금액 (원)<input type="number" name="balance" min="0" step="any" inputmode="numeric" value="${l.balance ?? ''}" required></label>
        <label class="fld">연 이자율 (%)<input type="number" name="rate" min="0" step="any" inputmode="decimal" value="${l.rate ?? ''}" required></label>
        <label class="fld">대출 시작일<input type="date" name="startDate" max="${todayStr()}" value="${l.startDate || l.date || todayStr()}" required></label>
        <label class="fld">상환 완료일 (선택)<input type="date" name="endDate" max="${todayStr()}" value="${l.endDate || ''}"></label>
        <label class="fld full">메모 (선택)<input name="note" value="${esc(l.note || '')}"></label>
      </div>
      <p class="hint" style="margin:2px 0 0;">상환 완료일을 비워두면 "보유 중"으로 보고 오늘까지 이자를 계산합니다. 다 갚았다면 그 날짜를 넣으면 그날로 이자가 멈춥니다.
      <b>일부만 갚았다면</b> 여기 말고 목록의 <b>상환</b> 버튼에 그 날짜와 금액을 넣으세요 — 그날부터 줄어든 잔액으로 이자를 계산합니다.</p>
      <div class="btn-row" style="justify-content:flex-end;">
        <button type="button" class="btn" data-x="cancel">취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`);
  m.querySelector('[data-x=cancel]').onclick = closeModal;
  m.querySelector('#loan-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const balance = parseFloat(f.balance.value);
    const rate = parseFloat(f.rate.value);
    const name = f.name.value.trim();
    const endDate = f.endDate.value || null;
    if (!name) { toast('계좌 이름을 입력하세요'); return; }
    if (isNaN(balance) || balance < 0 || isNaN(rate) || rate < 0) { toast('잔액과 금리를 확인하세요'); return; }
    if (endDate && endDate < f.startDate.value) { toast('상환일이 시작일보다 빠릅니다'); return; }
    const fields = { name, balance, rate, startDate: f.startDate.value, endDate, note: f.note.value.trim(), updatedAt: Date.now() };
    if (existing) {
      delete existing.kind; delete existing.date; // 옛 필드 정리
      Object.assign(existing, fields);
    } else {
      state.loans.push({ id: uid(), ...fields, createdAt: Date.now() });
    }
    saveNow(); closeModal(); render(); toast('저장했습니다');
  });
}

// ---------- 중도 상환 기록 ----------
// 대출을 일부만 갚은 경우. 그 날짜로 구간이 끊겨 이후로는 줄어든 잔액에만 이자가 붙는다.
// 대출 객체 안에 넣으므로(repayments) 저장할 때 대출의 updatedAt을 올려야 동기화된다.
function openRepayModal(loanId) {
  const find = () => (state.loans || []).find(x => x.id === loanId) || null;
  const l = find();
  if (!l) return;
  const acct = E.loanStatus(state)?.accounts.find(a => a.id === loanId);
  const reps = [...(l.repayments || [])].sort((a, b) => a.date < b.date ? 1 : -1);

  const m = openModal(`
    <h2>상환 기록 — ${esc(l.name)}</h2>
    <p class="small muted" style="margin-top:-6px;">
      최초 ${fmtMoney(l.balance)} · 누적 상환 <b>${fmtMoney(acct?.repaid || 0)}</b> · 남은 잔액 <b>${fmtMoney(acct?.balance ?? l.balance)}</b>
    </p>
    <form id="rep-form">
      <div class="form-grid">
        <label class="fld">갚은 날<input type="date" name="date" max="${todayStr()}" min="${l.startDate}" value="${todayStr()}" required></label>
        <label class="fld">갚은 금액 (원)<input name="amount" type="text" inputmode="decimal" autocomplete="off" required></label>
        <label class="fld full">메모 (선택)<input name="note" maxlength="60" placeholder="예: 보너스로 일부 상환"></label>
      </div>
      <p class="hint" style="margin:2px 0 0;">전액을 갚았다면 남은 잔액과 같은 금액을 넣으세요 — 잔액이 0이 되면 그날로 이자가 멈춥니다.</p>
      <div class="btn-row" style="justify-content:flex-end;">
        <button type="button" class="btn" data-x="cancel">닫기</button>
        <button type="submit" class="btn primary">기록</button>
      </div>
    </form>
    ${reps.length ? `<div class="tbl-wrap" style="margin-top:12px;"><table class="tbl">
      <tr><th>갚은 날</th><th class="num">금액</th><th class="num"></th></tr>
      ${reps.map(r => `<tr>
        <td>${r.date}${r.note ? `<br><span class="muted small">${esc(r.note)}</span>` : ''}</td>
        <td class="num">${fmtMoney(r.amount)}</td>
        <td class="num"><button class="btn small danger" data-delrep="${r.id}">삭제</button></td>
      </tr>`).join('')}
    </table></div>` : '<div class="empty" style="margin-top:12px;">아직 상환 기록이 없습니다</div>'}`);

  m.querySelector('[data-x=cancel]').onclick = closeModal;
  const amt = m.querySelector('[name=amount]');
  bindThousands(amt);

  m.querySelector('#rep-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const cur = find();                      // 동기화가 배열을 갈아끼웠을 수 있으므로 지금 다시 찾는다
    if (!cur) { closeModal(); render(); return; }
    const amount = numOf(amt);
    if (!(amount > 0)) { toast('금액을 입력하세요'); return; }
    if (f.date.value < cur.startDate) { toast('대출 시작일보다 빠릅니다'); return; }
    cur.repayments = [...(cur.repayments || []), {
      id: uid(), date: f.date.value, amount, note: f.note.value.trim(),
    }];
    cur.updatedAt = Date.now();              // repayments가 대출 안에 있으므로 필수
    saveNow(); closeModal(); render(); toast('상환을 기록했습니다');
  });

  m.querySelectorAll('[data-delrep]').forEach(b => b.addEventListener('click', () => {
    const cur = find();
    if (!cur) return;
    cur.repayments = (cur.repayments || []).filter(r => r.id !== b.dataset.delrep);
    cur.updatedAt = Date.now();
    saveNow(); closeModal(); render(); toast('지웠습니다');
  }));
}

function vCost() {
  const ln = E.loanStatus(state);
  if (!ln) {
    return `
      <div class="view-title">투자 비용</div>
      <p class="view-desc">빌린 돈으로 투자한다면 그 이자도 엄연한 비용입니다. <b>빌린 돈이 이자보다 더 벌어야</b> 레버리지가 값을 합니다.</p>
      <div class="card">
        <h3>대출 계좌가 없습니다</h3>
        <p class="small muted" style="margin:6px 0 0;">마이너스통장·신용대출 등 투자 자금을 빌린 계좌를 등록하세요. 계좌가 여러 개면 각각 등록하면 됩니다. 매달 나가는 이자와 지금까지 쌓인 비용, 수익이 그 비용을 넘고 있는지를 합산해 보여줍니다.</p>
        <div class="btn-row"><button class="btn primary" data-x="add">대출 계좌 추가</button></div>
      </div>`;
  }

  const acctItems = ln.accounts.map(a => `
    <li>
      <div class="trade-head">
        <b>${esc(a.name)}</b>
        <span class="muted small">${fmtMoney(a.balance)} · 연 ${a.rate}%</span>
        ${a.open ? '' : '<span class="tag">상환 완료</span>'}${a.sample ? ' <span class="tag warn">예시</span>' : ''}
        <span class="amt small" style="${a.open ? 'color:var(--warn-ink);' : ''}">${a.open ? '이번 달 ' + fmtMoney(a.monthly) : '—'}</span>
      </div>
      <div class="trade-meta">
        <span>${a.startDate} ~ ${a.open ? '현재' : a.end} (${a.days}일)</span>
        <span>누적 이자 ${fmtMoney(a.interest)}</span>
        ${a.repaid > 0 ? `<span>상환 ${a.repayCount}회 · ${fmtMoney(a.repaid)} <span class="muted">(최초 ${fmtMoney(a.principal)})</span></span>` : ''}
        <span style="margin-left:auto; white-space:nowrap;">
          <button class="btn small" data-repay="${a.id}">상환</button>
          <button class="btn small" data-edit="${a.id}">수정</button>
          <button class="btn small danger" data-del="${a.id}">삭제</button>
        </span>
      </div>
      ${a.note ? `<div class="trade-body">${esc(a.note)}</div>` : ''}
    </li>`).join('');

  return `
    <div class="view-title">투자 비용</div>
    <p class="view-desc">빌린 돈으로 투자한다면 그 이자도 엄연한 비용입니다. <b>빌린 돈이 이자보다 더 벌어야</b> 레버리지가 값을 합니다.</p>

    <div class="card hero">
      <div class="row"><span>대출 ${ln.openAccts.length}건 · 총 잔액 ${fmtMoney(ln.balance)} · 평균 연 ${ln.wRate.toFixed(2)}%</span></div>
      <div class="big" style="color:var(--warn-ink);">이번 달 이자 ${fmtMoney(ln.monthly)}</div>
      <div class="row"><span>하루 ${fmtMoney(ln.daily)}씩 나가는 셈입니다</span></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">${ln.start} 이후 누적 이자</div><div class="v">${fmtMoney(ln.cumulative)}</div><div class="s">지금까지 낸 비용(추정)</div></div>
      <div class="kpi"><div class="k">명목 손익</div><div class="v ${pctClass(ln.profit)}">${fmtMoney(ln.profit)}</div><div class="s">이자 반영 전</div></div>
      <div class="kpi"><div class="k">이자 차감 후 실질 손익</div><div class="v ${pctClass(ln.netProfit)}">${fmtMoney(ln.netProfit)}</div><div class="s">명목 손익 − 누적 이자</div></div>
    </div>

    ${ln.annualized != null ? `
    <div class="card">
      <h3>레버리지가 값을 하고 있나</h3>
      <p class="small" style="margin:4px 0 0;">
        <b>지금까지 (확정된 금액)</b> —
        ${ln.netProfit >= 0
          ? `누적 이자 ${fmtMoney(ln.cumulative)}를 내고도 <b class="up">${fmtMoney(ln.netProfit)}</b>이 남았습니다.`
          : `번 돈이 누적 이자 ${fmtMoney(ln.cumulative)}에 <b class="down">${fmtMoney(Math.abs(ln.netProfit))}</b> 모자랍니다.`}
      </p>
      <p class="small" style="margin:6px 0 0;">
        <b>앞으로의 속도 (비율)</b> — 펀드 수익률을 연으로 환산하면 약 <b class="${pctClass(ln.annualized)}">${fmtPct(ln.annualized)}</b>,
        평균 대출 금리는 <b>${ln.wRate.toFixed(2)}%</b>.
        ${ln.beatsHurdle
          ? `수익률이 금리를 <b class="up">${(ln.annualized * 100 - ln.wRate).toFixed(2)}%p 앞섭니다</b> —
             이 속도가 이어지면 빌린 돈이 제 몫을 합니다.`
          : `수익률이 금리에 <b class="down">${(ln.wRate - ln.annualized * 100).toFixed(2)}%p 못 미칩니다</b> —
             이 속도가 이어지면 빌린 돈은 이자값을 못 하게 됩니다.`}
      </p>
      <p class="hint">두 줄은 <b>서로 다른 것을 잽니다.</b> 위는 이미 확정된 <b>금액</b>(자기 돈까지 합쳐 번 돈에서 이자를 뺀 것),
      아래는 <b>비율</b>(빌린 돈 1원이 이자보다 더 버는가)입니다. 그래서 <b>“이자를 내고도 남았는데 수익률은 금리보다 낮은”</b>
      상태가 함께 나올 수 있습니다 — 자기 돈이 많을수록 금액은 커지지만, 빌린 돈의 값어치는 비율로만 드러나기 때문입니다.<br>
      연환산 수익률은 펀드 전체 수익을 운용 기간으로 나눈 추정치라 기간이 짧으면 크게 출렁입니다.</p>
    </div>` : ''}

    <div class="card">
      <h3>대출 계좌</h3>
      <div class="btn-row" style="margin:0 0 6px;"><button class="btn primary" data-x="add">대출 계좌 추가</button></div>
      <ul class="list-plain">${acctItems}</ul>
      <p class="hint">계좌마다 시작일부터 상환일(없으면 오늘)까지 잔액·금리로 이자를 계산합니다. 잔액이 크게 바뀌면 그 계좌를 수정해 반영하세요.</p>
    </div>`;
}
vCost.bind_ = (root) => {
  root.querySelector('[data-x=add]')?.addEventListener('click', () => openLoanModal(null));
  root.querySelectorAll('[data-repay]').forEach(b => b.addEventListener('click', () => openRepayModal(b.dataset.repay)));
  root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const l = state.loans.find(x => x.id === b.dataset.edit);
    if (l) openLoanModal(l);
  }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const l = state.loans.find(x => x.id === b.dataset.del);
    const ok = await confirmModal({ title: '대출 계좌 삭제', body: `${l ? esc(l.name) + ' 계좌를 ' : '이 계좌를 '}삭제합니다. 이 계좌의 이자가 합계에서 빠집니다.`, okLabel: '삭제', danger: true });
    if (!ok) return;
    Store.removeItem(state, 'loans', b.dataset.del);
    saveNow(); render();
  }));
};
registerView('cost', vCost);

// ---------- 기간 수익률 (주간/월간/연간) ----------
let returnsUnit = 'month';
let returnsRows = [];   // 화면에 그린 기간들 — 행을 눌렀을 때 되찾으려고 들고 있는다
const UNIT_LABEL = { week: '주간', month: '월간', year: '연간' };

// 기간 한 줄을 눌렀을 때: 그 기간 '말일'의 보유 현황과, 그 기간에 확정된 매도 상세.
function openPeriodDetail(r) {
  const pf = E.portfolio(state, r.end);
  const det = E.realizedDetail(state, r.start, r.end);
  const realizedSum = det.reduce((s, x) => s + x.krw, 0);

  const holdRows = pf.rows.map(x => `
    <tr>
      <td><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.symbol)}</span></td>
      <td class="num">${fmtQty(x.qty)}주</td>
      <td class="num">${fmtMoney(x.cost, x.cur)}</td>
      <td class="num">${fmtMoney(x.value, x.cur)}<br><span class="muted small">${(x.weight * 100).toFixed(1)}%</span></td>
      <td class="num ${pctClass(x.ret)}">${fmtPct(x.ret)}</td>
    </tr>`).join('');

  const cashLine = pf.cashTracked
    ? `<p class="hint">현금 ${fmtMoney(pf.cash.KRW)}${pf.cash.USD ? ' + ' + fmtMoney(pf.cash.USD, 'USD') : ''}
       <span class="muted">(${esc(pf.cashAsOf)} 입력분)</span> 포함</p>`
    : `<p class="hint">이 시점엔 현금 입력이 없어 <b>보유 주식만</b> 집계했습니다.</p>`;

  const detRows = det.map(x => `
    <tr>
      <td>${esc(x.date)}<br><span class="muted small">${esc(x.name)}</span></td>
      <td class="num">${fmtQty(x.qty)}주</td>
      <td class="num ${pctClass(x.krw)}"><b>${fmtMoney(x.krw)}</b></td>
      <td class="num ${pctClass(x.ret)}">${fmtPct(x.ret)}</td>
      <td class="num muted small">${x.holdDays != null ? Math.round(x.holdDays) + '일' : '–'}${x.reasonType ? '<br>' + esc(x.reasonType) : ''}</td>
    </tr>`).join('');

  openModal(`
    <h2>${esc(r.label)}${r.isCurrent ? ' <span class="muted small">진행 중</span>' : ''}</h2>
    <p class="small muted" style="margin-top:-6px;">
      보유 현황은 <b>${esc(r.end)}</b> 종가 기준 · 실현손익은 <b>${esc(r.start)} 다음날부터 ${esc(r.end)}까지</b> 판 것</p>
    <dl class="hero-facts">
      <dt>기말 평가액</dt><dd>${fmtMoney(r.endVal)}</dd>
      <dt>실현손익</dt><dd class="${pctClass(realizedSum)}">${fmtMoney(realizedSum)} <span class="muted small">(${det.length}건)</span></dd>
      <dt>순손익</dt><dd class="${pctClass(r.gain)}">${fmtMoney(r.gain)} <span class="muted small">평가 ${fmtMoney(r.gain - r.realized)}</span></dd>
      <dt>수익률</dt><dd class="${pctClass(r.ret)}"><b>${fmtPct(r.ret)}</b></dd>
    </dl>
    <h3 style="margin:16px 0 8px; font-size:14px;">${esc(r.end)} 보유 종목 (${pf.rows.length})</h3>
    ${pf.rows.length ? `<div class="tbl-wrap"><table class="tbl">
      <tr><th>종목</th><th class="num">수량</th><th class="num">매입액</th><th class="num">평가액</th><th class="num">수익률</th></tr>
      ${holdRows}
    </table></div>${cashLine}` : '<div class="empty">이 시점엔 보유 종목이 없습니다</div>'}
    <h3 style="margin:16px 0 8px; font-size:14px;">이 기간에 판 것 (${det.length})</h3>
    ${det.length ? `<div class="tbl-wrap"><table class="tbl">
      <tr><th>매도일 · 종목</th><th class="num">수량</th><th class="num">실현손익</th><th class="num">수익률</th><th class="num">보유</th></tr>
      ${detRows}
    </table></div>
    <p class="hint">실현손익은 원화 기준(매도 환율로 대금, 매수 환율로 원가 → 환차 포함)이고 수수료·제세금이 반영돼 있습니다.
    수익률은 그 종목 자기 통화 기준입니다.</p>` : '<div class="empty">이 기간엔 판 종목이 없습니다</div>'}
    <div class="btn-row" style="justify-content:flex-end;">
      <button class="btn" data-x="close">닫기</button>
    </div>`).querySelector('[data-x=close]').onclick = closeModal;
}

function vReturns() {
  const unit = returnsUnit;
  const rows = E.periodReturns(state, unit);
  returnsRows = rows;
  const tabs = ['week', 'month', 'year'].map(u =>
    `<button class="btn small ${u === unit ? 'primary' : ''}" data-unit="${u}">${UNIT_LABEL[u]}</button>`).join(' ');

  if (!rows.length) {
    return `
      <div class="view-title">수익</div>
      <p class="view-desc">기간 말(마지막 거래일 종가) 평가액을 전기 말과 비교합니다.</p>
      <div class="btn-row" style="margin:0 0 12px;">${tabs}</div>
      <div class="empty">매매 기록이 생기면 기간별 수익률이 정리됩니다</div>`;
  }

  // 요약: 완료된 기간만(진행 중 제외)으로 평균·최고·최저
  const done = rows.filter(r => !r.isCurrent && r.ret != null);
  const avg = done.length ? done.reduce((s, r) => s + r.ret, 0) / done.length : null;
  const best = done.length ? done.reduce((a, b) => b.ret > a.ret ? b : a) : null;
  const worst = done.length ? done.reduce((a, b) => b.ret < a.ret ? b : a) : null;

  const flowNote = c => Math.abs(c) < 1 ? ''
    : `<br><span class="muted small">${c > 0 ? '투입' : '회수'} ${fmtMoney(Math.abs(c))}</span>`;
  const rowHtml = (r, i) => `
    <tr class="row-link" data-period="${i}">
      <td>${esc(r.label)} <span class="chev">›</span>${r.isCurrent ? ' <span class="muted small">진행 중</span>' : ''}</td>
      <td class="num">${fmtMoney(r.endVal)}</td>
      <td class="num ${pctClass(r.change)}">${fmtMoney(r.change)}${flowNote(r.contrib)}</td>
      <td class="num ${pctClass(r.realized)}">${fmtMoney(r.realized)}</td>
      <td class="num ${pctClass(r.gain)}">${fmtMoney(r.gain)}<br><span class="muted small">평가 ${fmtMoney(r.gain - r.realized)}</span></td>
      <td class="num ${pctClass(r.ret)}"><b>${fmtPct(r.ret)}</b></td>
    </tr>`;
  // 주간은 라벨에 연도가 없으므로, 연도가 바뀔 때마다 구분 행을 한 번씩 넣는다
  let body;
  if (unit === 'week') {
    let prevYear = null;
    body = rows.map((r, i) => {
      const y = r.end.slice(0, 4);
      const sep = y !== prevYear ? `<tr class="year-sep"><td colspan="6">${y}년</td></tr>` : '';
      prevYear = y;
      return sep + rowHtml(r, i);
    }).join('');
  } else {
    body = rows.map((r, i) => rowHtml(r, i)).join('');
  }

  return `
    <div class="view-title">수익</div>
    <p class="view-desc">기간 말(마지막 거래일 종가) 평가액을 전기 말과 비교. 원화 기준(달러 자산은 각 시점 환율로 환산 → 환율 변동 포함).
    <b>실현손익</b>은 판 것만, <b>순손익</b>은 보유분 평가변동까지 포함한 값입니다.</p>
    <div class="btn-row" style="margin:0 0 12px;">${tabs}</div>
    ${done.length ? `<div class="kpis">
      <div class="kpi"><div class="k">${UNIT_LABEL[unit]} 평균 수익률</div><div class="v ${pctClass(avg)}">${fmtPct(avg)}</div><div class="s">완료된 ${done.length}개 기간</div></div>
      <div class="kpi"><div class="k">최고</div><div class="v ${pctClass(best.ret)}">${fmtPct(best.ret)}</div><div class="s">${esc(best.label)}</div></div>
      <div class="kpi"><div class="k">최저</div><div class="v ${pctClass(worst.ret)}">${fmtPct(worst.ret)}</div><div class="s">${esc(worst.label)}</div></div>
    </div>` : ''}
    <div class="card">
      <div class="tbl-wrap"><table class="tbl">
        <tr><th>기간</th><th class="num">기말 평가액</th><th class="num">전기比 증감</th><th class="num">실현손익</th><th class="num">순손익</th><th class="num">수익률</th></tr>
        ${body}
      </table></div>
      <div class="warnbox" style="margin-top:10px;">
        <b>실현손익과 순손익은 다른 숫자입니다 — 더해지지도, 같아지지도 않습니다.</b><br>
        · <b>실현손익</b>: 그 기간에 <b>판 것</b>으로 확정된 손익. 증권사 '실현수익(판매수익)'과 비교할 값입니다.<br>
        · <b>순손익</b>: 보유 중인 종목의 <b>평가액 변동까지 포함</b>한 그 기간의 총 손익(괄호의 '평가'가 미실현분).<br>
        2024년에 사서 2025년에 팔았다면 그 이익 <b>전부</b>가 2025년 실현손익이지만, 2025년 순손익엔 2025년에
        오른 만큼만 들어갑니다(2024년분은 이미 2024년 평가손익으로 셌으므로). 그래서 둘은 어긋나는 게 정상입니다.
      </div>
      <p class="hint">전기比 증감은 들어오고 나간 돈까지 포함한 평가액 변화입니다.
      <b>수익률은 시간가중(TWR)</b> — 돈이 들어오고 나간 날마다 구간을 끊어 각 구간 수익률을 곱하므로
      "얼마를 언제 넣었나"가 수익률에 섞이지 않습니다.<br>
      <b>실현손익은 실제 수수료·제세금과 체결 당시 증권사 적용환율</b>(스프레드 포함)<b>로 계산합니다.</b>
      2026년은 증권사와 +0.4% 차이입니다.<br>
      <b>2025년은 증권사보다 약 22만원 낮게 나오는데, 틀린 게 아닙니다.</b> 크라우드웍스 유상증자 때 산
      신주인수권 <b>₩202,200</b>을 이 앱은 주식 원가에 넣습니다 — 실제로 쓴 돈이니까요. 증권사는 이걸
      별도 증권으로 보고 주식 원가에서 빼기 때문에 그만큼 증권사 수익이 더 커 보입니다.<br>
      나머지 약 2만원 차이는 <b>배당금·계좌이자</b> 때문입니다 — 위 표의 실현손익은 <b>매매만</b> 셉니다.
      배당·이자는 매매 기록 화면의 <b>배당·이자</b> 칸에 따로 쌓이고, 평가액과 수익률에는 반영됩니다.
      세금 신고용 수치는 증권사 화면을 보세요.</p>
    </div>`;
}
vReturns.bind_ = (root) => {
  root.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
    returnsUnit = b.dataset.unit; render();
  }));
  root.querySelectorAll('tr.row-link[data-period]').forEach(tr => tr.addEventListener('click', () => {
    const r = returnsRows[Number(tr.dataset.period)];
    if (r) openPeriodDetail(r);
  }));
};
registerView('returns', vReturns);

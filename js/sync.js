// Dropbox 동기화: 항목 단위 병합 (updatedAt 엄격 비교 — 로컬이 확실히 새것일 때만 로컬 우선)
// 삭제는 tombstone(state.deleted[id]=시각)으로 전파해 기기 간 부활을 막는다.
import * as Dbx from './dropbox.js';

const COLLS = ['trades', 'diary', 'principles', 'letters', 'quotes', 'watchlist', 'swaps', 'loans', 'archives', 'virtuals', 'exchanges', 'cashMoves', 'incomes'];
const K_LAST = 'onefund.lastSync';

let ctx = null;   // { state, persist(), onApplied() }
let timer = null;
let syncing = false;
export let lastError = null;

export function init(c) {
  ctx = c;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
}

export const lastSync = () => parseInt(localStorage.getItem(K_LAST) || '0', 10) || null;

// 저장 직후 호출 — 3초 뒤 동기화 (연타 병합)
export function schedule() {
  if (!Dbx.connected()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), 3000);
}

export function mergeAll(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, ts] of Object.entries(local.deleted || {})) {
    deleted[id] = Math.max(ts, deleted[id] || 0);
  }
  const out = {};
  for (const c of COLLS) {
    const m = new Map();
    for (const it of remote[c] || []) m.set(it.id, it);
    for (const it of local[c] || []) {
      const r = m.get(it.id);
      // 엄격 > : 같으면 원격 우선 (memo-app 규칙)
      if (!r || (it.updatedAt || 0) > (r.updatedAt || 0)) m.set(it.id, it);
    }
    out[c] = [...m.values()].filter(it => !(deleted[it.id] >= (it.updatedAt || 0)));
  }
  const ls = local.settings || {}, rs = remote.settings || {};
  out.settings = (ls.updatedAt || 0) > (rs.updatedAt || 0) ? ls : rs;
  // 90일 지난 tombstone 정리
  const cutoff = Date.now() - 90 * 86400000;
  out.deleted = Object.fromEntries(Object.entries(deleted).filter(([, ts]) => ts > cutoff));
  return out;
}

function payload(state) {
  const p = { version: state.version, settings: state.settings, deleted: state.deleted || {} };
  for (const c of COLLS) p[c] = state[c];
  p.syncedAt = Date.now();
  return p;
}

// 동기화가 실제로 바꾼 게 있는지 판별용 지문. 앱으로 돌아올 때마다 동기화가 도는데,
// 바뀐 게 없는데도 onApplied를 부르면 화면을 통째로 다시 그려 쓰던 글이 날아간다.
function fingerprint(s) {
  const o = { settings: s.settings, deleted: s.deleted || {} };
  for (const c of COLLS) o[c] = s[c] || [];
  return JSON.stringify(o);
}

export async function syncNow() {
  if (!ctx || !Dbx.connected() || syncing) return false;
  syncing = true;
  lastError = null;
  let applied = false;
  try {
    const remoteText = await Dbx.download();
    if (remoteText) {
      let remote = null;
      try { remote = JSON.parse(remoteText); } catch { /* 손상 원격은 무시하고 덮어씀 */ }
      if (remote) {
        const before = fingerprint(ctx.state);
        const merged = mergeAll(ctx.state, remote);
        for (const c of COLLS) ctx.state[c] = merged[c];
        ctx.state.settings = merged.settings;
        ctx.state.deleted = merged.deleted;
        if (fingerprint(ctx.state) !== before) {
          ctx.persist();
          applied = true;
        }
      }
    }
    await Dbx.upload(JSON.stringify(payload(ctx.state)));
    localStorage.setItem(K_LAST, String(Date.now()));
    if (applied) ctx.onApplied?.();   // 실제로 바뀐 게 있을 때만 화면 갱신
    return true;
  } catch (e) {
    lastError = String(e && e.message || e);
    return false;
  } finally {
    syncing = false;
  }
}

export const isSyncing = () => syncing;

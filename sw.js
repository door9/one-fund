// 오프라인 셸 캐시. 시세(data/*)는 항상 네트워크 우선.
const CACHE = 'proj210-v84';
const SHELL = ['.', 'index.html', 'style.css', 'favicon.svg', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png',
  'js/app.js', 'js/core.js', 'js/store.js', 'js/prices.js', 'js/engine.js',
  'js/util.js', 'js/chart.js', 'js/dropbox.js', 'js/sync.js', 'js/lock.js',
  'js/views-main.js', 'js/views-insight.js', 'js/views-write.js', 'js/views-funds.js',
  'js/views-virtual.js'];

// 새 버전을 심을 때는 반드시 **서버에서 새로** 받는다.
// addAll은 브라우저 HTTP 캐시를 그대로 쓰는데, GitHub Pages가 max-age=600을 주므로
// 방금 고쳐 올린 파일 대신 10분 전의 옛 파일이 새 캐시에 구워질 수 있다. 그러면 버전만
// 올라가고 내용은 옛것이라 고쳐도 안 고쳐지는 상태가 된다 — 파일끼리 버전이 어긋나면
// 모듈 로딩이 통째로 실패해 앱이 아무것도 못 그린다(실제로 겪음).
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u =>
        fetch(new Request(u, { cache: 'reload' })).then(r => {
          if (!r.ok) throw new Error(`${u} ${r.status}`);
          return c.put(u, r);
        })
      )))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) {
    // 시세: 네트워크 우선, 실패 시 캐시
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request))
    );
  }
});

// 홈 화면에 추가(PWA)하려면 서비스 워커가 있어야 한다. 캐시는 일부러 두지 않는다.
// 이 대시보드는 주식·동기화처럼 서버에서 받아야 하는 값이 대부분이라 오프라인 가치가 낮고,
// 캐시를 두면 배포한 새 코드 대신 옛 화면이 남아 "고쳤는데 안 바뀐다"는 상황이 생긴다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// 설치 가능 조건을 채우려면 fetch 핸들러가 있어야 하는 브라우저가 있다.
// 가로채기만 하고 그대로 네트워크로 넘긴다(캐시하지 않는다).
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));

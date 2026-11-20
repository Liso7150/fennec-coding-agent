/* Self-destructing replacement for the old caching shell worker.

   That worker served the static shell out of Cache Storage with
   `caches.match(request, { ignoreSearch: true })`, so `app.js?v=40` was answered with
   whatever `app.js` it had cached - and it is still registered on every browser that
   ever loaded the PWA. Deleting the file does not clear it: a 404 on the script URL
   means "no update", so the old worker keeps controlling the scope. The app.js it
   cached was an ES module, and today's `<script src="./app.js?v=40">` is a classic
   script, so those installs failed to parse it and ran nothing at all - no boot, no
   API calls, no error in the page.

   Serving this file at the same URL is the only way the browser fetches new bytes.
   It caches nothing, intercepts nothing, and on activation drops every cache and
   unregisters itself, so the next load comes straight from the agent server. */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((windows) => windows.forEach((client) => client.navigate(client.url)))
  );
});

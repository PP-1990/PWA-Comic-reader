// ============================================================================
// WHAT IS THIS FILE?
// ============================================================================
// This is the app's "service worker" — a special script the browser runs
// in the background, separately from the actual page, that lets the app:
//   1. Keep working even with no internet connection (after you've loaded
//      it online at least once).
//   2. Be "installed" like a real app (via the browser's install prompt),
//      instead of only working as a regular website tab.
//
// It does this by intercepting every network request the page makes and
// serving a saved copy from the browser's local cache when possible,
// instead of always going out to the internet. This file has nothing to
// do with actually reading comics — that's all in index.html. If comics
// aren't opening correctly, this file is very unlikely to be the cause;
// look here only if you're troubleshooting "the app won't work offline"
// or "the app won't install".
//
// IMPORTANT — if you change index.html, jszip.min.js, or anything else
// listed in APP_SHELL below, bump the CACHE_NAME version number (e.g.
// "cbz-reader-v11" -> "cbz-reader-v12"). Otherwise, people who already
// have the app installed/cached will keep seeing the OLD version, since
// the whole point of this file is to avoid re-downloading things.
// ============================================================================

const CACHE_NAME = "cbz-reader-v21";

// Every file the app needs in order to run at all. These all get
// downloaded and saved to the local cache up front (see "install" below),
// so the app can still open even with zero internet connection.
const APP_SHELL = [
    "./index.html",
    "./manifest.json",
    "./jszip.min.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./unrar/unrar-bundle.js"
];

// Runs once, the first time this exact version of sw.js is loaded (i.e.
// whenever CACHE_NAME above changes). Downloads and saves every file in
// APP_SHELL to a local cache named after CACHE_NAME.
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting()) // start using this version right away
    );
});

// Runs once this version has installed and taken over. Cleans up caches
// left behind by any OLDER version of this file, so old cached files don't
// pile up forever taking up storage space.
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

// Runs for EVERY network request the page makes (loading a script, an
// icon, etc.) once this service worker is active. The strategy here is
// "cache first": if we already have a saved copy, use it immediately
// (fast, and works offline); otherwise fetch it from the network like
// normal, and save a copy for next time.
self.addEventListener("fetch", (event) => {

    // Only GET requests make sense to cache (there's nothing else this
    // app sends, but this guards against ever accidentally caching one).
    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request).then((cached) => {

            if (cached) return cached;

            return fetch(event.request)
                .then((response) => {

                    if (response.ok) {
                        // Save a copy of this successful response for next
                        // time. response.clone() is needed because a
                        // response's body can only be read once, and we
                        // need to both cache it AND return it to the page.
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) =>
                            cache.put(event.request, clone)
                        );
                    }

                    return response;
                })
                .catch(() => {
                    // The network request failed (most likely: no internet
                    // connection) and we didn't have a cached copy either.
                    // If this was a request to load the page itself, fall
                    // back to the cached index.html so the app shell can
                    // still open, rather than showing the browser's own
                    // "no internet" error page.
                    if (event.request.mode === "navigate") {
                        return caches.match("./index.html");
                    }
                });
        })
    );
});

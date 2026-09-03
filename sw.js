const CACHE_NAME = "cbz-reader-v7";

const APP_SHELL = [
    "./index.html",
    "./manifest.json",
    "./jszip.min.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./unrar/unrar-bundle.js"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

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

self.addEventListener("fetch", (event) => {

    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request).then((cached) => {

            if (cached) return cached;

            return fetch(event.request)
                .then((response) => {

                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) =>
                            cache.put(event.request, clone)
                        );
                    }

                    return response;
                })
                .catch(() => {
                    if (event.request.mode === "navigate") {
                        return caches.match("./index.html");
                    }
                });
        })
    );
});

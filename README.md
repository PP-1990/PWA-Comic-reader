# Comic Reader

A comic book reader that lives entirely in your browser. Open a `.cbz` or `.cbr` file and read it — no account, no upload, no server involved at any point. Your comics never leave your device.

**[Read comics now →](https://pp-1990.github.io/PWA-Comic-reader/)**

## What it does

- **Reads `.cbz` and `.cbr` files** — the two common comic archive formats — unpacked entirely on your own device.
- **Installs like a real app.** Add it to your phone's home screen or your desktop, and it keeps working with zero internet connection after the first load.
- **Guided View** steps through a page panel by panel, automatically panning and zooming to each one in reading order — right-to-left for manga, if you tell it to. An on-device machine learning model finds the actual panel boundaries (no server, no API calls, nothing sent anywhere); if a page has nothing it can confidently detect, it just shows the whole page rather than guessing wrong. You can also drag or scroll to nudge the framing yourself if it's ever slightly off.
- **Manual zoom, double-tap to zoom, and a thumbnail sidebar** (a swipeable filmstrip on mobile) for everyday reading.
- **Works with no server at all.** You can open `index.html` straight from disk, with no internet connection and nothing installed, and it still reads comics — Guided View's panel detection included.

## Why

Most comic readers either need a native app install or ask you to upload your files to someone else's server. This one is just a web page: open it, pick a file, read. Nothing about your library, your reading habits, or the comics themselves ever goes anywhere but your own device.

## How it's built

A single `index.html` file with all the HTML, CSS, and JavaScript, plus a handful of vendored dependencies (JSZip for `.cbz`, `unrar` compiled to WebAssembly for `.cbr`, ONNX Runtime Web for Guided View's panel-detection model) — no build step, no framework, no bundler.

See [`docs/architecture.html`](docs/architecture.html) for an illustrated breakdown of how it all fits together, from opening a file to how Guided View finds panels.

## License

AGPL-3.0 — see [LICENSE](LICENSE). This is inherited from the model Guided View's panel detection runs: it's licensed AGPL-3.0, which requires any application built on it to be licensed the same way.

## Running it yourself

Clone the repo and open `index.html` in a browser — that's the whole setup. For the full experience (installable, offline-capable, and with Guided View's panel detection working), serve the folder over `http(s)` instead of opening it directly as a file — this repo does that already via GitHub Pages.

```bash
git clone https://github.com/PP-1990/PWA-Comic-reader.git
cd PWA-Comic-reader
# open index.html directly, or serve the folder with any static file server
```

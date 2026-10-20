// ============================================================================
// PANEL DETECTION — shared by index.html (the reader, for Guided View) and
// editor.html (the ACBF authoring tool, where the same automatic detection
// is used as a starting draft the publisher then corrects by hand).
//
// Everything in this file is plain functions operating on whatever <canvas>
// you hand it — nothing here reaches into a specific page's global state —
// so both pages can call the exact same detection pipeline against their
// own page-canvas element without duplicating (and risking drifting) this
// logic between them.
//
// Runs a small object-detection model (models/manga_panel_detector_fp32_1024
// .onnx, via ONNX Runtime Web — see onnx/ort.min.js, which must already be
// loaded via a <script> tag before this file runs) entirely on-device. The
// model only knows two classes — {0: 'frame', 1: 'text'} — and only 'frame'
// (the panel boxes themselves) is used here.
// ============================================================================
const PanelDetection = (() => {
    const PANEL_MODEL_URL = "models/manga_panel_detector_fp32_1024.onnx";
    const PANEL_INPUT_SIZE = 1024; // the model's fixed input size (imgsz) — see its own embedded export metadata
    const PANEL_CLASS_FRAME = 0;   // {0: 'frame', 1: 'text'} — only 'frame' boxes are panels; 'text' (speech bubbles etc.) is ignored
    const PANEL_CONFIDENCE_THRESHOLD = 0.25;
    const PANEL_ROW_TOLERANCE_FRACTION = 0.5; // how close two panels' vertical centers must be (relative to average panel height) to count as "the same row"

    let panelSessionPromise = null;

    // Appends a classic <script> tag and resolves once it's loaded — used
    // below to lazily pull in the (large) file:// fallback assets only if
    // they're actually needed, instead of always loading them up front.
    function loadScriptTag(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load " + src));
            document.head.appendChild(script);
        });
    }

    // Decodes a base64 string back into raw bytes. Used below to turn the
    // embedded copies of the WASM binary and the model back into the same
    // Uint8Array a normal fetch() would have produced.
    function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Lazily creates (once) and reuses the inference session. numThreads is
    // forced to 1 because real WASM multithreading needs cross-origin-
    // isolation response headers (COOP/COEP), which a static host like
    // GitHub Pages doesn't send — without them, onnxruntime-web would just
    // warn and silently fall back to one thread anyway, so this skips
    // straight to that instead of letting it try and fail first.
    //
    // Every other script this app loads uses classic <script> tags
    // specifically because file:// pages block fetch() and dynamic
    // import() of local files — but ort.min.js normally uses BOTH of those
    // internally to load its WASM runtime and the model, since it has no
    // way to know it might be running from a file:// page. When it detects
    // that case (location.protocol === "file:"), it instead pulls in
    // onnx/file-protocol-assets.js — a generated file with the same WASM
    // runtime and model data already embedded as JS strings — and feeds
    // onnxruntime-web the resulting bytes directly instead of a URL for it
    // to fetch: ort.env.wasm.wasmBinary accepts the raw WASM bytes
    // (skipping its normal fetch entirely), ort.env.wasm.wasmPaths.mjs
    // accepts a blob: URL for its small JS wrapper (built from the
    // embedded source via new Blob()+URL.createObjectURL() — unlike a
    // file:// URL, importing a blob: URL isn't restricted this way), and
    // InferenceSession.create() accepts the model's raw bytes directly
    // instead of a URL. On a normal http(s) page, none of this runs — it
    // stays on the plain URL-based loading below, so GitHub Pages / the
    // installed PWA never pay the cost of loading that ~27MB fallback
    // file at all.
    async function getSession() {
        if (panelSessionPromise) return panelSessionPromise;

        if (location.protocol === "file:") {
            panelSessionPromise = (async () => {
                await loadScriptTag("onnx/file-protocol-assets.js");
                const assets = window.__ortFileProtocolAssets;
                const mjsBlobUrl = URL.createObjectURL(new Blob([assets.mjsSource], { type: "text/javascript" }));
                ort.env.wasm.wasmPaths = { mjs: mjsBlobUrl };
                ort.env.wasm.wasmBinary = base64ToBytes(assets.wasmBase64);
                ort.env.wasm.numThreads = 1;
                return ort.InferenceSession.create(base64ToBytes(assets.modelBase64), { executionProviders: ["wasm"] });
            })();
        } else {
            // Must be a full absolute URL, not a plain relative string like
            // "onnx/" — the runtime loads its WASM glue via a dynamic
            // import(), and per the JS module spec a relative path with no
            // leading "./"/"/" is a "bare specifier" there (unlike in
            // fetch(), where it just resolves against the page URL fine),
            // which throws "Failed to resolve module specifier" instead of
            // silently working.
            ort.env.wasm.wasmPaths = new URL("onnx/", document.baseURI).href;
            ort.env.wasm.numThreads = 1;
            panelSessionPromise = ort.InferenceSession.create(PANEL_MODEL_URL, { executionProviders: ["wasm"] });
        }
        return panelSessionPromise;
    }

    // A single "frame" box covering the whole given canvas — the fallback
    // used when detection finds nothing (or fails) for a page, so callers
    // always have at least one box to show instead of getting stuck with
    // none.
    function wholePageBox(canvas) {
        return { x: 0, y: 0, width: canvas.width, height: canvas.height };
    }

    // Draws the given canvas onto a PANEL_INPUT_SIZE square canvas, scaled
    // to fit and letterboxed (padded with neutral gray) rather than
    // stretched — matching how a fixed-imgsz model like this one expects
    // to receive non-square images. Returns the input tensor plus the
    // numbers needed to map its output coordinates back to the source
    // canvas's own full-resolution pixel space.
    function preprocess(sourceCanvas) {
        const srcWidth = sourceCanvas.width;
        const srcHeight = sourceCanvas.height;
        const scale = Math.min(PANEL_INPUT_SIZE / srcWidth, PANEL_INPUT_SIZE / srcHeight);
        const drawWidth = Math.round(srcWidth * scale);
        const drawHeight = Math.round(srcHeight * scale);
        const padX = Math.floor((PANEL_INPUT_SIZE - drawWidth) / 2);
        const padY = Math.floor((PANEL_INPUT_SIZE - drawHeight) / 2);

        const letterboxed = document.createElement("canvas");
        letterboxed.width = PANEL_INPUT_SIZE;
        letterboxed.height = PANEL_INPUT_SIZE;
        const ctx = letterboxed.getContext("2d");
        ctx.fillStyle = "#727272"; // a neutral mid-gray pad, the standard YOLO letterbox convention
        ctx.fillRect(0, 0, PANEL_INPUT_SIZE, PANEL_INPUT_SIZE);
        ctx.drawImage(sourceCanvas, 0, 0, srcWidth, srcHeight, padX, padY, drawWidth, drawHeight);

        const { data } = ctx.getImageData(0, 0, PANEL_INPUT_SIZE, PANEL_INPUT_SIZE);
        const pixelCount = PANEL_INPUT_SIZE * PANEL_INPUT_SIZE;
        // CHW (channel-planar), not HWC — the layout ONNX/PyTorch models expect.
        const chw = new Float32Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            chw[i] = data[i * 4] / 255;
            chw[pixelCount + i] = data[i * 4 + 1] / 255;
            chw[pixelCount * 2 + i] = data[i * 4 + 2] / 255;
        }
        return { tensor: new ort.Tensor("float32", chw, [1, 3, PANEL_INPUT_SIZE, PANEL_INPUT_SIZE]), scale, padX, padY };
    }

    // Converts the model's raw output into "frame"-class boxes in the
    // source canvas's own full-resolution pixel space. The model was
    // exported end-to-end with nms:false (see its embedded metadata) —
    // meaning NMS/duplicate suppression is already baked into the graph
    // itself (the TopK/GatherElements ops visible when inspecting the
    // file), not something this needs to do again — so output0 is already
    // a clean list of final detections: one row per detection, [x1, y1,
    // x2, y2, confidence, classId], in the padded PANEL_INPUT_SIZE
    // square's own pixel space.
    function parseDetections(output, scale, padX, padY, canvasWidth, canvasHeight) {
        const data = output.data;
        const dims = output.dims;
        const numDetections = dims[dims.length - 2];
        const rowLength = dims[dims.length - 1];
        const boxes = [];
        for (let i = 0; i < numDetections; i++) {
            const base = i * rowLength;
            const confidence = data[base + 4];
            const classId = Math.round(data[base + 5]);
            if (confidence < PANEL_CONFIDENCE_THRESHOLD || classId !== PANEL_CLASS_FRAME) continue;

            const x1 = Math.max(0, (data[base] - padX) / scale);
            const y1 = Math.max(0, (data[base + 1] - padY) / scale);
            const x2 = Math.min(canvasWidth, (data[base + 2] - padX) / scale);
            const y2 = Math.min(canvasHeight, (data[base + 3] - padY) / scale);
            const width = x2 - x1;
            const height = y2 - y1;
            if (width <= 0 || height <= 0) continue; // a detection that fell entirely outside the real page after un-padding

            boxes.push({ x: x1, y: y1, width, height });
        }
        return boxes;
    }

    // Groups detected boxes into reading-order rows: sorts by vertical
    // center, then walks through assigning each box to the current row if
    // its center is within PANEL_ROW_TOLERANCE_FRACTION (relative to the
    // average panel height) of that row's running average center,
    // otherwise starting a new row — real panels are rarely pixel-
    // perfectly aligned, so a hard equality check would wrongly split one
    // visual row into many. Each row is then sorted left-to-right. Reading
    // direction (manga vs Western) is deliberately NOT applied here — each
    // caller applies its own manga handling on top of this canonical order.
    function groupPanelsIntoRows(boxes) {
        const sorted = boxes.slice().sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
        const avgHeight = boxes.reduce((sum, b) => sum + b.height, 0) / boxes.length;
        const tolerance = avgHeight * PANEL_ROW_TOLERANCE_FRACTION;

        const rows = [];
        let currentRow = [sorted[0]];
        let rowCenterSum = sorted[0].y + sorted[0].height / 2;
        for (let i = 1; i < sorted.length; i++) {
            const box = sorted[i];
            const boxCenter = box.y + box.height / 2;
            if (Math.abs(boxCenter - rowCenterSum / currentRow.length) <= tolerance) {
                currentRow.push(box);
                rowCenterSum += boxCenter;
            } else {
                rows.push(currentRow);
                currentRow = [box];
                rowCenterSum = boxCenter;
            }
        }
        rows.push(currentRow);
        rows.forEach(row => row.sort((a, b) => a.x - b.x));
        return rows;
    }

    // Runs the full detection pipeline against the given canvas and
    // returns its row-grouped "frame" boxes (or the whole canvas as a
    // single box, if nothing was detected above the confidence
    // threshold). Throws on a loading/inference failure — every caller
    // wraps this in its own try/catch, since what to do about a failure
    // (fall back silently? tell the user?) is a per-page decision, not
    // this module's to make.
    async function detectPanels(canvas) {
        const session = await getSession();
        const { tensor, scale, padX, padY } = preprocess(canvas);
        const outputs = await session.run({ [session.inputNames[0]]: tensor });
        const boxes = parseDetections(outputs[session.outputNames[0]], scale, padX, padY, canvas.width, canvas.height);
        return boxes.length > 0 ? groupPanelsIntoRows(boxes) : [[wholePageBox(canvas)]];
    }

    // Parses an .acbf file's raw XML text into a Map from image filename
    // (basename only, lowercased — ACBF's <image href="..."> can be a bare
    // name or a path like "images/012.jpg", and archive layouts vary, so
    // matching on the basename against the archive's own filenames is
    // more robust than requiring an exact path match) to its ordered list
    // of panel frames. Each frame carries BOTH its bounding box (x, y,
    // width, height — what Guided View's pan/zoom actually needs, since
    // it always frames a rectangle regardless of the panel's real shape)
    // AND its exact polygon `points` ([{x,y}, ...], in file order — what
    // the ACBF editor needs to render/edit the real shape, e.g. an
    // angled or trapezoidal panel border, not just its rectangle
    // envelope). Returns an empty Map on any parse failure or if the file
    // has no recognizable <page>/<frame> structure, which callers treat
    // exactly like "no .acbf file at all" — this is a bonus data source,
    // never a requirement.
    function parseAcbfFrames(xmlText) {
        const framesByImageName = new Map();
        let doc;
        try {
            doc = new DOMParser().parseFromString(xmlText, "application/xml");
        } catch {
            return framesByImageName;
        }
        if (!doc || doc.getElementsByTagName("parsererror").length > 0) return framesByImageName;

        for (const pageEl of doc.getElementsByTagName("page")) {
            const href = pageEl.getElementsByTagName("image")[0]?.getAttribute("href");
            if (!href) continue;
            const baseName = href.split(/[\\/]/).pop().toLowerCase();

            const frames = [];
            for (const frameEl of pageEl.getElementsByTagName("frame")) {
                const coords = (frameEl.getAttribute("points") || "").trim().split(/\s+/)
                    .map(pair => pair.split(",").map(Number));
                if (coords.length < 3 || coords.some(p => p.length !== 2 || p.some(Number.isNaN))) continue;
                const points = coords.map(([x, y]) => ({ x, y }));
                const xs = coords.map(p => p[0]);
                const ys = coords.map(p => p[1]);
                frames.push({
                    x: Math.min(...xs),
                    y: Math.min(...ys),
                    width: Math.max(...xs) - Math.min(...xs),
                    height: Math.max(...ys) - Math.min(...ys),
                    points
                });
            }
            if (frames.length > 0) framesByImageName.set(baseName, frames);
        }
        return framesByImageName;
    }

    // Serializes page-by-page panel polygons into an ACBF XML document —
    // the mirror image of parseAcbfFrames() above. `pages` is an array of
    // { imageName, panels } in reading order already (this doesn't
    // reorder or otherwise second-guess what it's given — the caller,
    // e.g. the ACBF editor, owns reading order), where each panel is
    // { points: [{x,y}, ...] } — at least 3 points, in the page's own
    // full-resolution pixel coordinates; a plain rectangle is just the
    // 4-point case. Produces a minimal but real ACBF document (the
    // <meta-data> block ACBF requires, filled in from `bookTitle`) rather
    // than just the <body> this app's own reader actually reads, so
    // exported files are usable by other ACBF-aware tools too, not just
    // this one.
    function buildAcbfXml(pages, bookTitle) {
        const escapeXml = (s) => String(s).replace(/[&<>"]/g, ch => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]
        ));
        const title = escapeXml(bookTitle || "Untitled");
        const coverHref = pages[0] ? escapeXml(pages[0].imageName) : "";

        const pagesXml = pages.map(page => {
            const framesXml = page.panels.map(panel => {
                const pointsAttr = panel.points
                    .map(p => Math.round(p.x) + "," + Math.round(p.y))
                    .join(" ");
                return `      <frame points="${pointsAttr}"/>`;
            }).join("\n");
            return `    <page>\n      <image href="${escapeXml(page.imageName)}"/>\n${framesXml}\n    </page>`;
        }).join("\n");

        return `<?xml version="1.0" encoding="UTF-8"?>
<ACBF xmlns="http://www.fictionbook-lib.org/xml/acbf/1.0">
  <meta-data>
    <book-info>
      <author><nickname>Unknown</nickname></author>
      <book-title lang="en">${title}</book-title>
      <genre>other</genre>
      <annotation><p></p></annotation>
      <coverpage><image href="${coverHref}"/></coverpage>
    </book-info>
    <publish-info>
      <publisher>Unknown</publisher>
    </publish-info>
    <document-info>
      <author><nickname>Comicaa ACBF Editor</nickname></author>
      <creation-date>${new Date().toISOString().slice(0, 10)}</creation-date>
    </document-info>
  </meta-data>
  <body>
${pagesXml}
  </body>
</ACBF>
`;
    }

    return {
        getSession,
        detectPanels,
        wholePageBox,
        groupPanelsIntoRows,
        parseAcbfFrames,
        buildAcbfXml,
        ROW_TOLERANCE_FRACTION: PANEL_ROW_TOLERANCE_FRACTION
    };
})();

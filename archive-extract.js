// ============================================================================
// ARCHIVE EXTRACTION — shared by index.html (the reader) and editor.html
// (the ACBF authoring tool). Both need the exact same "open a .cbz/.cbr and
// get back an ordered list of page images (+ any .acbf metadata it shipped
// with)" logic, so it lives here once instead of drifting between two
// copies.
//
// Needs JSZip (jszip.min.js) and UnrarJS (unrar/unrar-bundle.js) already
// loaded via <script> tags before this file runs, exactly like index.html
// already does.
// ============================================================================
const ArchiveExtract = (() => {

    // File extensions that count as a comic "page" once we look inside the
    // archive. Comic archives sometimes contain non-image junk too (a text
    // file, a metadata file, etc.) — anything not in this list gets skipped.
    const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"];

    function isImageFile(name) {
        const lower = name.toLowerCase();
        return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
    }

    // Opens a .cbz/.zip file using JSZip and returns a plain list of
    // { name, getBlob() } — one entry per image page found inside, in
    // whatever order they appeared in the archive (sorted into reading
    // order afterward by extractComicArchive()). getBlob() is a function
    // rather than the image data itself, so decompression only happens once
    // a page is actually needed.
    async function extractZipEntries(file, log = () => {}) {
        if (typeof JSZip === "undefined") {
            throw new Error("JSZip failed to load. Check internet connection or CDN.");
        }

        const zip = await JSZip.loadAsync(file);
        const entries = Object.keys(zip.files);

        log("Archive entries:");
        entries.forEach(e => log(" - " + e));

        const pages = entries
            .filter(name =>
                !zip.files[name].dir &&
                isImageFile(name) &&
                !name.includes("__MACOSX")
            )
            .map(name => ({
                name,
                getBlob: () => zip.files[name].async("blob")
            }));

        // An .acbf file, if this archive has one, carries hand-authored panel
        // data — see parseAcbfFrames() in panel-detection.js.
        const acbfName = entries.find(name => /\.acbf$/i.test(name));
        const acbfText = acbfName ? await zip.files[acbfName].async("text") : null;

        return { pages, acbfText };
    }

    // Same idea as extractZipEntries() above, but for .cbr/.rar files, using
    // UnrarJS. Unlike ZIP, RAR doesn't support cheaply reading one file
    // without processing others around it, so all image pages get
    // decompressed up front in a single pass here.
    async function extractRarEntries(file, log = () => {}) {
        if (typeof UnrarJS === "undefined") {
            throw new Error("RAR support failed to load. Check that the unrar/unrar-bundle.js file is present.");
        }

        const data = await file.arrayBuffer();
        const extractor = await UnrarJS.createExtractorFromData({ data });

        // Older RAR archives (esp. from Windows tools) can use "\" as the path
        // separator, so keep the raw name for the extractor API (which matches
        // against the archive's own header text) alongside a normalized display name.
        const headers = [];
        for (const header of extractor.getFileList().fileHeaders) {
            if (header.flags.directory) continue;
            headers.push({ raw: header.name, name: header.name.replace(/\\/g, "/") });
        }

        log("Archive entries:");
        headers.forEach(h => log(" - " + h.name));

        const imageHeaders = headers.filter(h =>
            isImageFile(h.name) && !h.name.includes("__MACOSX")
        );
        const acbfHeader = headers.find(h => /\.acbf$/i.test(h.name));

        const filesToExtract = imageHeaders.map(h => h.raw);
        if (acbfHeader) filesToExtract.push(acbfHeader.raw);

        const blobs = new Map();
        let acbfText = null;
        for (const entry of extractor.extract({ files: filesToExtract }).files) {
            if (acbfHeader && entry.fileHeader.name === acbfHeader.raw) {
                acbfText = new TextDecoder("utf-8").decode(entry.extraction);
            } else {
                blobs.set(entry.fileHeader.name, new Blob([entry.extraction]));
            }
        }

        const pages = imageHeaders
            .filter(h => blobs.has(h.raw))
            .map(h => ({
                name: h.name,
                getBlob: async () => blobs.get(h.raw)
            }));

        return { pages, acbfText };
    }

    // Puts pages into natural reading order (so "page2.jpg" sorts before
    // "page10.jpg", not after it, the way plain alphabetical sorting would
    // get wrong).
    function sortPagesNaturally(pages) {
        pages.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        );
        return pages;
    }

    // The one-stop entry point: picks zip vs rar extraction based on the
    // file's own name, sorts the result into reading order, and returns
    // { pages, acbfText }. `log`, if given, receives the same progress lines
    // extractZipEntries/extractRarEntries always produced.
    async function extractComicArchive(file, log = () => {}) {
        const isRar = /\.(cbr|rar)$/i.test(file.name);
        const { pages, acbfText } = isRar
            ? await extractRarEntries(file, log)
            : await extractZipEntries(file, log);
        sortPagesNaturally(pages);
        return { pages, acbfText };
    }

    return {
        isImageFile,
        extractZipEntries,
        extractRarEntries,
        extractComicArchive,
        IMAGE_EXTENSIONS
    };
})();

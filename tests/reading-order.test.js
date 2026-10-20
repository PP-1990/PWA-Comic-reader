// Run with:  node --test tests/
// No dependencies and no build step: panel-detection.js is loaded straight
// from disk into a sandbox, exactly as a browser <script> tag would run it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "panel-detection.js"), "utf8");
const PanelDetection = vm.runInNewContext(source + "\n;PanelDetection;", {});

const PAGE_W = 1000;
const PAGE_H = 1500;
const box = (x, y, width, height) => ({ x, y, width, height });
// Arrays built inside the vm sandbox belong to a different realm, which strict
// deep-equal rejects even when the contents match; rebuild them here (the
// boxes inside keep their identity).
const normalize = (x) => Array.isArray(x) ? Array.from(x, normalize) : x;
const layout = (boxes, w = PAGE_W, h = PAGE_H) => normalize(PanelDetection.buildReadingLayout(boxes, w, h));
const flatten = (rows, rtl) => normalize(PanelDetection.flattenLayout(rows, rtl));
const order = (boxes, rtl, w, h) => flatten(layout(boxes, w, h), rtl);

test("single panel", () => {
    const a = box(0, 0, 1000, 1500);
    assert.deepEqual(layout([a]), [[a]]);
    assert.deepEqual(order([a], false), [a]);
});

test("2x2 grid reads row by row; manga reverses each row", () => {
    const tl = box(0, 0, 490, 740), tr = box(510, 0, 490, 740);
    const bl = box(0, 760, 490, 740), br = box(510, 760, 490, 740);
    assert.deepEqual(order([br, tl, bl, tr], false), [tl, tr, bl, br]);
    assert.deepEqual(order([br, tl, bl, tr], true), [tr, tl, br, bl]);
});

test("tall panel beside two stacked panels reads column by column", () => {
    const tall = box(0, 0, 480, 1500);
    const top = box(520, 0, 480, 740), bottom = box(520, 760, 480, 740);
    assert.deepEqual(order([bottom, tall, top], false), [tall, top, bottom]);
    // Manga: the stacked column first, still top to bottom, then the tall panel.
    assert.deepEqual(order([bottom, tall, top], true), [top, bottom, tall]);
});

test("tall panel on the right: the stacked column is read first", () => {
    // The old row-grouping read this as A, tall, B.
    const top = box(0, 0, 480, 740), bottom = box(0, 760, 480, 740);
    const tall = box(520, 0, 480, 1500);
    assert.deepEqual(order([tall, bottom, top], false), [top, bottom, tall]);
    assert.deepEqual(order([tall, bottom, top], true), [tall, top, bottom]);
});

test("wide panel over two columns", () => {
    const wide = box(0, 0, 1000, 700);
    const left = box(0, 720, 490, 780), right = box(510, 720, 490, 780);
    assert.deepEqual(order([right, wide, left], false), [wide, left, right]);
    assert.deepEqual(order([right, wide, left], true), [wide, right, left]);
});

test("stacked strips read top to bottom in both directions", () => {
    const a = box(0, 0, 1000, 480), b = box(0, 510, 1000, 480), c = box(0, 1020, 1000, 480);
    assert.deepEqual(order([c, a, b], false), [a, b, c]);
    assert.deepEqual(order([c, a, b], true), [a, b, c]);
});

test("detected boxes that overlap slightly across a gutter are still separated", () => {
    const left = box(0, 0, 505, 700), right = box(500, 0, 500, 700); // 5px overlap, under 1% of the page
    assert.deepEqual(order([right, left], false), [left, right]);
});

test("staggered columns read column by column", () => {
    const a = box(0, 0, 480, 700), b = box(0, 720, 480, 780);
    const c = box(520, 0, 480, 500), d = box(520, 520, 480, 980);
    assert.deepEqual(order([d, b, c, a], false), [a, b, c, d]);
});

test("interlocking pinwheel layout falls back without losing panels", () => {
    const boxes = [box(0, 0, 600, 400), box(600, 0, 400, 600), box(400, 600, 600, 400), box(0, 400, 400, 600)];
    const result = order(boxes, false, 1000, 1000);
    assert.equal(result.length, 4);
    for (const b of boxes) assert.ok(result.includes(b));
});

test("flattenLayout still accepts the plain rows-of-boxes shape", () => {
    const a = box(0, 0, 1, 1), b = box(1, 0, 1, 1), c = box(0, 1, 1, 1);
    assert.deepEqual(flatten([[a, b], [c]], false), [a, b, c]);
    assert.deepEqual(flatten([[a, b], [c]], true), [b, a, c]);
});

// ---------------------------------------------------------------------------
// Property test: build random page layouts by repeatedly cutting a region in
// two with a gutter. There isn't one single "correct" order for every such
// page (two columns whose inner gutters nearly line up read just as well as
// rows), so instead of comparing against one reference order this checks the
// rules every sensible reading order obeys: nothing lost or duplicated, a
// panel is read before anything sitting below it in the same column, and
// before anything beside it in the reading direction on the same row.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomLayout(rand, region, depth, gutter) {
    const canSplitH = region.height > 6 * gutter + 120;
    const canSplitV = region.width > 6 * gutter + 120;
    const wantsSplit = depth < 4 && (canSplitH || canSplitV) && rand() < (depth === 0 ? 1 : 0.6);
    if (!wantsSplit) return [{ ...region }];

    const horizontal = canSplitH && (!canSplitV || rand() < 0.5);
    const fraction = 0.3 + rand() * 0.4;
    let first, second;
    if (horizontal) {
        const cut = region.height * fraction;
        first = { ...region, height: cut - gutter / 2 };
        second = { ...region, y: region.y + cut + gutter / 2, height: region.height - cut - gutter / 2 };
    } else {
        const cut = region.width * fraction;
        first = { ...region, width: cut - gutter / 2 };
        second = { ...region, x: region.x + cut + gutter / 2, width: region.width - cut - gutter / 2 };
    }
    return [
        ...randomLayout(rand, first, depth + 1, gutter),
        ...randomLayout(rand, second, depth + 1, gutter)
    ];
}

const overlap = (aStart, aEnd, bStart, bEnd) => Math.min(aEnd, bEnd) - Math.max(aStart, bStart);

// Throws if `result` breaks a reading rule. `tolerance` mirrors the
// detector's own gutter tolerance (1% of the page).
function assertReadingRules(boxes, result, rtl, label) {
    assert.equal(result.length, boxes.length, `${label}: panel count`);
    assert.equal(new Set(result).size, result.length, `${label}: duplicates`);
    const position = new Map(result.map((b, i) => [b, i]));
    for (const a of boxes) {
        for (const b of boxes) {
            if (a === b) continue;
            // Panels only share a column/row if they overlap by more than the
            // detector's own gutter tolerance; a sliver of overlap is noise.
            const sharesColumn = overlap(a.x, a.x + a.width, b.x, b.x + b.width) > PAGE_W * 0.01;
            const sharesRow = overlap(a.y, a.y + a.height, b.y, b.y + b.height) > PAGE_H * 0.01;
            const above = sharesColumn && a.y + a.height <= b.y + PAGE_H * 0.01;
            const beside = sharesRow && (rtl
                ? b.x + b.width <= a.x + PAGE_W * 0.01
                : a.x + a.width <= b.x + PAGE_W * 0.01);
            if (above || beside) {
                assert.ok(position.get(a) < position.get(b), `${label}: ${JSON.stringify(a)} must be read before ${JSON.stringify(b)}`);
            }
        }
    }
}

test("random gutter-cut layouts obey the reading rules in both directions", () => {
    for (let seed = 1; seed <= 300; seed++) {
        const rand = mulberry32(seed);
        const boxes = randomLayout(rand, { x: 0, y: 0, width: PAGE_W, height: PAGE_H }, 0, 24);
        // Shuffle the input so the result can't depend on detection order.
        const shuffled = boxes.slice().sort(() => rand() - 0.5);
        assertReadingRules(boxes, order(shuffled, false), false, `seed ${seed} left-to-right`);
        assertReadingRules(boxes, order(shuffled, true), true, `seed ${seed} manga`);
    }
});

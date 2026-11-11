// Lossless WebP (VP8L) encoder: port of image-webp 0.2.4 `encoder.rs` for RGBA8 input and default
// params (subtract-green + predictor transform, Huffman-coded literals and run-length references).
//
// For byte-identical output the Huffman code construction reproduces Rust's `BinaryHeap` and
// `sort_unstable_by_key` exactly, including how they order equal frequencies. The sort is the one the
// shipped wasm32 build runs (`(usize, u32)` is 8 bytes there, which selects the sorting-network small
// sort; x86_64 builds use a different small sort and can differ on ties).

/** LSB-first bit writer (the crate's 64-bit buffer, padded with zeros to a byte at the end). */
class BitWriter {
    buf = new Uint8Array(1 << 16);
    len = 0;
    acc = 0;
    n = 0;

    /** `nbits` ≤ 16. */
    write(bits: number, nbits: number): void {
        this.acc |= bits << this.n;
        this.n += nbits;
        while (this.n >= 8) {
            this.push(this.acc & 0xff);
            this.acc >>>= 8;
            this.n -= 8;
        }
    }

    push(b: number): void {
        if (this.len === this.buf.length) {
            const grown = new Uint8Array(this.buf.length * 2);
            grown.set(this.buf);
            this.buf = grown;
        }
        this.buf[this.len++] = b;
    }

    finish(): Uint8Array {
        if (this.n > 0) this.push(this.acc & 0xff);
        this.acc = 0;
        this.n = 0;
        return this.buf.subarray(0, this.len);
    }
}

function writeSingleEntryHuffmanTree(w: BitWriter, symbol: number): void {
    w.write(1, 2);
    if (symbol <= 1) {
        w.write(0, 1);
        w.write(symbol, 1);
    } else {
        w.write(1, 1);
        w.write(symbol, 8);
    }
}

const reverse16 = (v: number): number => {
    let r = 0;
    for (let i = 0; i < 16; i++) r |= ((v >> i) & 1) << (15 - i);
    return r;
};

// ---- std::collections::BinaryHeap<Item> where `Item(freq, index)` orders by reversed frequency only ----

type Item = [freq: number, index: number];
// Item ordering: a <= b ⇔ a.freq >= b.freq, etc. (a min-heap on frequency, ties by heap position)
const le = (a: Item, b: Item): boolean => a[0] >= b[0];
const ge = (a: Item, b: Item): boolean => a[0] <= b[0];
const lt = (a: Item, b: Item): boolean => a[0] > b[0];

function siftUp(d: Item[], start: number, pos: number): void {
    const elem = d[pos];
    let hole = pos;
    while (hole > start) {
        const parent = (hole - 1) >> 1;
        if (le(elem, d[parent])) break;
        d[hole] = d[parent];
        hole = parent;
    }
    d[hole] = elem;
}

function siftDownRange(d: Item[], pos: number, end: number): void {
    const elem = d[pos];
    let hole = pos;
    let child = 2 * hole + 1;
    while (child <= Math.max(end - 2, 0)) {
        if (le(d[child], d[child + 1])) child++;
        if (ge(elem, d[child])) {
            d[hole] = elem;
            return;
        }
        d[hole] = d[child];
        hole = child;
        child = 2 * hole + 1;
    }
    if (child === end - 1 && lt(elem, d[child])) {
        d[hole] = d[child];
        hole = child;
    }
    d[hole] = elem;
}

function siftDownToBottom(d: Item[], pos: number): void {
    const end = d.length;
    const start = pos;
    const elem = d[pos];
    let hole = pos;
    let child = 2 * hole + 1;
    while (child <= Math.max(end - 2, 0)) {
        if (le(d[child], d[child + 1])) child++;
        d[hole] = d[child];
        hole = child;
        child = 2 * hole + 1;
    }
    if (child === end - 1) {
        d[hole] = d[child];
        hole = child;
    }
    d[hole] = elem;
    siftUp(d, start, hole);
}

function heapPop(d: Item[]): Item {
    let item = d.pop()!;
    if (d.length > 0) {
        [item, d[0]] = [d[0], item];
        siftDownToBottom(d, 0);
    }
    return item;
}

// ---- core::slice::sort_unstable (ipnsort), wasm32 instantiation for (usize, u32) keyed by the u32 ----

type Entry = [index: number, freq: number];
type Less = (a: Entry, b: Entry) => boolean;
const byFreq: Less = (a, b) => a[1] < b[1];

function sortUnstable(v: Entry[], isLess: Less): void {
    const len = v.length;
    if (len < 2) return;
    if (len <= 20) {
        insertionSortShiftLeft(v, 0, len, 1, isLess);
        return;
    }
    // ipnsort
    let runLen = 2;
    const descending = isLess(v[1], v[0]);
    if (descending) {
        while (runLen < len && isLess(v[runLen], v[runLen - 1])) runLen++;
    } else {
        while (runLen < len && !isLess(v[runLen], v[runLen - 1])) runLen++;
    }
    if (runLen === len) {
        if (descending) v.reverse();
        return;
    }
    quicksort(v, 0, len, undefined, 2 * Math.floor(Math.log2(len | 1)), isLess);
}

function quicksort(v: Entry[], lo: number, hi: number, ancestorPivot: Entry | undefined, limit: number, isLess: Less): void {
    for (;;) {
        if (hi - lo <= 32) {
            smallSortNetwork(v, lo, hi, isLess);
            return;
        }
        if (limit === 0) {
            heapsort(v, lo, hi, isLess);
            return;
        }
        limit--;

        const pivotPos = choosePivot(v, lo, hi, isLess);

        // If the chosen pivot is equal to the predecessor, it is the smallest element in the slice:
        // partition into equal and greater elements and continue with the greater ones.
        if (ancestorPivot !== undefined && !isLess(ancestorPivot, v[lo + pivotPos])) {
            const numLt = partition(v, lo, hi, pivotPos, (a, b) => !isLess(b, a));
            lo += numLt + 1;
            ancestorPivot = undefined;
            continue;
        }

        const numLt = partition(v, lo, hi, pivotPos, isLess);
        quicksort(v, lo, lo + numLt, ancestorPivot, limit, isLess);
        ancestorPivot = v[lo + numLt];
        lo += numLt + 1;
    }
}

function choosePivot(v: Entry[], lo: number, hi: number, isLess: Less): number {
    const len = hi - lo;
    const lenDiv8 = len >> 3;
    const a = lo, b = lo + lenDiv8 * 4, c = lo + lenDiv8 * 7;
    return (len < 64 ? median3(v, a, b, c, isLess) : median3Rec(v, a, b, c, lenDiv8, isLess)) - lo;
}

function median3Rec(v: Entry[], a: number, b: number, c: number, n: number, isLess: Less): number {
    if (n * 8 >= 64) {
        const n8 = n >> 3;
        a = median3Rec(v, a, a + n8 * 4, a + n8 * 7, n8, isLess);
        b = median3Rec(v, b, b + n8 * 4, b + n8 * 7, n8, isLess);
        c = median3Rec(v, c, c + n8 * 4, c + n8 * 7, n8, isLess);
    }
    return median3(v, a, b, c, isLess);
}

function median3(v: Entry[], a: number, b: number, c: number, isLess: Less): number {
    const x = isLess(v[a], v[b]);
    const y = isLess(v[a], v[c]);
    if (x === y) return isLess(v[b], v[c]) !== x ? c : b;
    return a;
}

/** Moves the pivot to the front, partitions the rest (cyclic branchless Lomuto) and puts the pivot between. */
function partition(v: Entry[], lo: number, hi: number, pivot: number, isLess: Less): number {
    if (hi === lo) return 0;
    [v[lo], v[lo + pivot]] = [v[lo + pivot], v[lo]];
    const pivotValue = v[lo];
    const s = lo + 1;
    let numLt = 0;
    if (hi > s) {
        const gapValue = v[s];
        let gapPos = s;
        for (let right = s + 1; right <= hi; right++) {
            const elem = right === hi ? gapValue : v[right];
            const isLt = isLess(elem, pivotValue);
            const left = s + numLt;
            v[gapPos] = v[left];
            v[left] = elem;
            gapPos = right;
            numLt += isLt ? 1 : 0;
        }
    }
    [v[lo], v[lo + numLt]] = [v[lo + numLt], v[lo]];
    return numLt;
}

function heapsort(v: Entry[], lo: number, hi: number, isLess: Less): void {
    const len = hi - lo;
    for (let i = len + (len >> 1) - 1; i >= 0; i--) {
        let node: number;
        if (i >= len) {
            node = i - len;
        } else {
            [v[lo], v[lo + i]] = [v[lo + i], v[lo]];
            node = 0;
        }
        const end = Math.min(i, len);
        for (;;) {
            let child = 2 * node + 1;
            if (child >= end) break;
            if (child + 1 < end && isLess(v[lo + child], v[lo + child + 1])) child++;
            if (!isLess(v[lo + node], v[lo + child])) break;
            [v[lo + node], v[lo + child]] = [v[lo + child], v[lo + node]];
            node = child;
        }
    }
}

function insertTail(v: Entry[], begin: number, tail: number, isLess: Less): void {
    let sift = tail - 1;
    if (!isLess(v[tail], v[sift])) return;
    const tmp = v[tail];
    let dst = tail;
    for (;;) {
        v[dst] = v[sift];
        dst = sift;
        if (sift === begin) break;
        sift--;
        if (!isLess(tmp, v[sift])) break;
    }
    v[dst] = tmp;
}

function insertionSortShiftLeft(v: Entry[], lo: number, hi: number, offset: number, isLess: Less): void {
    for (let tail = lo + offset; tail < hi; tail++) insertTail(v, lo, tail, isLess);
}

function swapIfLess(v: Entry[], a: number, b: number, isLess: Less): void {
    if (isLess(v[b], v[a])) [v[a], v[b]] = [v[b], v[a]];
}

// prettier-ignore
const SORT9 = [0,3, 1,7, 2,5, 4,8, 0,7, 2,4, 3,8, 5,6, 0,2, 1,3, 4,5, 7,8, 1,4, 3,6, 5,7, 0,1, 2,4, 3,5, 6,8, 2,3, 4,5, 6,7, 1,2, 3,4, 5,6];
// prettier-ignore
const SORT13 = [0,12, 1,10, 2,9, 3,7, 5,11, 6,8, 1,6, 2,3, 4,11, 7,9, 8,10, 0,4, 1,2, 3,6, 7,8, 9,10, 11,12, 4,6, 5,9, 8,11, 10,12, 0,5, 3,8, 4,7, 6,11, 9,10, 0,1, 2,5, 6,9, 7,8, 10,11, 1,3, 2,4, 5,6, 9,10, 1,2, 3,4, 5,7, 6,8, 2,3, 4,5, 6,7, 8,9, 3,4, 5,6];

function smallSortNetwork(v: Entry[], lo: number, hi: number, isLess: Less): void {
    const len = hi - lo;
    if (len < 2) return;
    const lenDiv2 = len >> 1;
    const noMerge = len < 18;

    for (const [start, end] of noMerge ? [[lo, hi]] : [[lo, lo + lenDiv2], [lo + lenDiv2, hi]]) {
        const rl = end - start;
        let presorted = 1;
        const net = rl >= 13 ? SORT13 : rl >= 9 ? SORT9 : undefined;
        if (net) {
            for (let i = 0; i < net.length; i += 2) swapIfLess(v, start + net[i], start + net[i + 1], isLess);
            presorted = rl >= 13 ? 13 : 9;
        }
        insertionSortShiftLeft(v, start, end, presorted, isLess);
    }
    if (noMerge) return;

    // bidirectional merge of the two sorted halves
    const src = v.slice(lo, hi);
    let left = 0, right = lenDiv2, d = lo;
    let leftRev = lenDiv2 - 1, rightRev = len - 1, dRev = hi - 1;
    for (let i = 0; i < lenDiv2; i++) {
        const isL = !isLess(src[right], src[left]);
        v[d++] = isL ? src[left++] : src[right++];
        const isL2 = !isLess(src[rightRev], src[leftRev]);
        v[dRev--] = isL2 ? src[rightRev--] : src[leftRev--];
    }
    if (len & 1) v[d] = left < leftRev + 1 ? src[left] : src[right];
}

// ---- Huffman codes ----

/** Builds length-limited canonical codes; false (all lengths 0) if at most one symbol is used. */
function buildHuffmanTree(frequencies: Uint32Array, lengths: Uint8Array, codes: Uint16Array, lengthLimit: number): boolean {
    let used = 0;
    for (const f of frequencies) if (f > 0) used++;
    if (used <= 1) {
        lengths.fill(0);
        codes.fill(0);
        return false;
    }

    // Build a huffman tree
    const n = frequencies.length;
    const internalNodes: [number, number][] = [];
    const nodes: Item[] = [];
    for (let i = 0; i < n; i++) if (frequencies[i] > 0) nodes.push([frequencies[i], i]);
    for (let p = (nodes.length >> 1) - 1; p >= 0; p--) siftDownRange(nodes, p, nodes.length);
    while (nodes.length > 1) {
        const [frequency1, index1] = heapPop(nodes);
        const root = nodes[0];
        internalNodes.push([index1, root[1]]);
        nodes[0] = [frequency1 + root[0], internalNodes.length + n - 1];
        if (nodes.length > 1) siftDownRange(nodes, 0, nodes.length);
    }

    // Walk the tree to assign code lengths
    lengths.fill(0);
    const stack: [number, number][] = [[heapPop(nodes)[1], 0]];
    while (stack.length > 0) {
        const [node, depth] = stack.pop()!;
        if (node < n) {
            lengths[node] = depth;
        } else {
            const [left, right] = internalNodes[node - n];
            stack.push([left, depth + 1], [right, depth + 1]);
        }
    }

    // Limit the codes to length lengthLimit
    let maxLength = 0;
    for (const length of lengths) maxLength = Math.max(maxLength, length);
    if (maxLength > lengthLimit) {
        const counts = new Uint32Array(16);
        for (const length of lengths) counts[Math.min(length, lengthLimit)]++;

        let total = 0;
        for (let i = 1; i <= lengthLimit; i++) total += counts[i] << (lengthLimit - i);

        while (total > 1 << lengthLimit) {
            let i = lengthLimit - 1;
            while (counts[i] === 0) i--;
            counts[i]--;
            counts[lengthLimit]--;
            counts[i + 1] += 2;
            total--;
        }

        // assign new lengths
        let len = lengthLimit;
        const indexes: Entry[] = Array.from(frequencies, (f, i) => [i, f]);
        sortUnstable(indexes, byFreq);
        for (const [i, frequency] of indexes) {
            if (frequency > 0) {
                while (counts[len] === 0) len--;
                lengths[i] = len;
                counts[len]--;
            }
        }
    }

    // Assign codes
    codes.fill(0);
    let code = 0;
    for (let len = 1; len <= lengthLimit; len++) {
        for (let i = 0; i < n; i++) {
            if (lengths[i] === len) {
                codes[i] = reverse16(code & 0xffff) >> (16 - len);
                code++;
            }
        }
        code <<= 1;
    }
    return true;
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function writeHuffmanTree(w: BitWriter, frequencies: Uint32Array, lengths: Uint8Array, codes: Uint16Array): void {
    if (!buildHuffmanTree(frequencies, lengths, codes, 15)) {
        const symbol = Math.max(0, frequencies.findIndex((f) => f > 0));
        writeSingleEntryHuffmanTree(w, symbol & 0xff);
        return;
    }

    const codeLengthLengths = new Uint8Array(16);
    const codeLengthCodes = new Uint16Array(16);
    const codeLengthFrequencies = new Uint32Array(16);
    for (const length of lengths) codeLengthFrequencies[length]++;
    const singleCodeLengthLength = !buildHuffmanTree(codeLengthFrequencies, codeLengthLengths, codeLengthCodes, 7);

    // Write the huffman tree
    w.write(0, 1); // normal huffman tree
    w.write(19 - 4, 4); // num_code_lengths - 4

    for (const i of CODE_LENGTH_ORDER) {
        if (i > 15 || codeLengthFrequencies[i] === 0) w.write(0, 3);
        else if (singleCodeLengthLength) w.write(1, 3);
        else w.write(codeLengthLengths[i], 3);
    }

    if (lengths.length === 256) {
        w.write(1, 1); // max_symbol is stored
        w.write(3, 3); // max_symbol_nbits / 2 - 2
        w.write(254, 8); // max_symbol - 2
    } else {
        w.write(0, 1);
    }

    // Write the huffman codes
    if (!singleCodeLengthLength) {
        for (const len of lengths) w.write(codeLengthCodes[len], codeLengthLengths[len]);
    }
}

/** `(prefix symbol, extra bits)` of a backward reference length ≥ 5. */
function lengthToSymbol(len: number): [number, number] {
    const l = len - 1;
    const highestBit = 31 - Math.clz32(l);
    const secondHighestBit = (l >> (highestBit - 1)) & 1;
    return [2 * highestBit + secondHighestBit, highestBit - 1];
}

/** Length of the run of pixels equal to pixel `i - 1` starting at `i` (at most 4096). */
function runLength(px: Uint32Array, i: number): number {
    let run = 0;
    while (run < 4096 && i + run < px.length && px[i + run] === px[i - 1]) run++;
    return run;
}

/** Lossless WebP of row-major RGBA8 pixels (`WebPEncoder::new(..).encode(rgba, w, h, ColorType::Rgba8)`). */
export function encodeWebp(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (rgba.length !== width * height * 4) throw new Error(`${rgba.length} bytes is not ${width}x${height} RGBA`);
    if (width === 0 || width > 16384 || height === 0 || height > 16384) throw new Error('Invalid dimensions');

    const w = new BitWriter();
    w.write(0x2f, 8); // signature
    w.write(width - 1, 14);
    w.write(height - 1, 14);
    w.write(1, 1); // alpha used
    w.write(0x0, 3); // version

    // subtract green transform
    w.write(0b101, 3);

    // predictor transform
    w.write(0b111001, 6);
    w.write(0x0, 1); // no color cache
    writeSingleEntryHuffmanTree(w, 2);
    for (let i = 0; i < 4; i++) writeSingleEntryHuffmanTree(w, 0);

    w.write(0x0, 1); // transforms done
    w.write(0x0, 1); // color cache
    w.write(0x0, 1); // meta-huffman codes

    const pixels = rgba.slice();

    // compute subtract green transform
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] -= pixels[i + 1];
        pixels[i + 2] -= pixels[i + 1];
    }

    // compute predictor transform
    const rowBytes = width * 4;
    for (let y = height - 1; y >= 1; y--) {
        for (let i = y * rowBytes; i < (y + 1) * rowBytes; i++) pixels[i] -= pixels[i - rowBytes];
    }
    for (let i = rowBytes - 1; i >= 4; i--) pixels[i] -= pixels[i - 4];
    pixels[3] -= 255;

    // compute frequencies
    const px = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);
    const freq0 = new Uint32Array(256);
    const freq1 = new Uint32Array(280);
    const freq2 = new Uint32Array(256);
    const freq3 = new Uint32Array(256);
    for (let i = 0; i < px.length; ) {
        const o = i * 4;
        freq0[pixels[o]]++;
        freq1[pixels[o + 1]]++;
        freq2[pixels[o + 2]]++;
        freq3[pixels[o + 3]]++;
        i++;
        const run = runLength(px, i);
        if (run > 0) freq1[256 + (run <= 4 ? run - 1 : lengthToSymbol(run)[0])]++;
        i += run;
    }

    // compute and write huffman codes
    const lengths0 = new Uint8Array(256), lengths1 = new Uint8Array(280), lengths2 = new Uint8Array(256), lengths3 = new Uint8Array(256);
    const codes0 = new Uint16Array(256), codes1 = new Uint16Array(280), codes2 = new Uint16Array(256), codes3 = new Uint16Array(256);
    writeHuffmanTree(w, freq1, lengths1, codes1);
    writeHuffmanTree(w, freq0, lengths0, codes0);
    writeHuffmanTree(w, freq2, lengths2, codes2);
    writeHuffmanTree(w, freq3, lengths3, codes3);
    writeSingleEntryHuffmanTree(w, 1);

    // Write image data
    for (let i = 0; i < px.length; ) {
        const o = i * 4;
        const g = pixels[o + 1], r = pixels[o], b = pixels[o + 2], a = pixels[o + 3];
        w.write(codes1[g], lengths1[g]);
        w.write(codes0[r], lengths0[r]);
        w.write(codes2[b], lengths2[b]);
        w.write(codes3[a], lengths3[a]);
        i++;
        const run = runLength(px, i);
        if (run > 0) {
            if (run <= 4) {
                const symbol = 256 + run - 1;
                w.write(codes1[symbol], lengths1[symbol]);
            } else {
                const [symbol, extraBits] = lengthToSymbol(run);
                w.write(codes1[256 + symbol], lengths1[256 + symbol]);
                w.write((run - 1) & ((1 << extraBits) - 1), extraBits);
            }
        }
        i += run;
    }

    const frame = w.finish();
    const padded = frame.length + (frame.length & 1);
    const out = new Uint8Array(20 + padded);
    const view = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    view.setUint32(4, padded + 8 + 4, true);
    out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8); // WEBP VP8L
    view.setUint32(16, frame.length, true);
    out.set(frame, 20);
    return out;
}

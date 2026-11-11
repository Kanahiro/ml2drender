// VP8L lossless decoding: port of image-webp 0.2.4 `lossless.rs`, `huffman.rs` and `lossless_transform.rs`.
// Pixels are RGBA bytes (the crate permutes ARGB to RGBA right after reading from the bitstream).

const fail = (msg: string): never => {
    throw new Error(`webp: ${msg}`);
};

/**
 * LSB-first bit reader over `data[pos, end)` with the crate's 64-bit buffer (two u32 halves): `fill`
 * tops it up to 56..63 bits (8 bytes at a time, or byte by byte near the end), and reads fail when
 * the buffer holds fewer bits than requested, so errors happen exactly where the crate's do.
 */
export class BitReader {
    data: Uint8Array;
    pos: number;
    end: number;
    lo = 0;
    hi = 0;
    nbits = 0;

    constructor(data: Uint8Array, pos: number, end: number) {
        this.data = data;
        this.pos = pos;
        this.end = Math.min(end, data.length);
    }

    fill(): void {
        const d = this.data;
        if (this.end - this.pos >= 8) {
            const p = this.pos, n = this.nbits;
            const l = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
            const h = d[p + 4] | (d[p + 5] << 8) | (d[p + 6] << 16) | (d[p + 7] << 24);
            if (n === 0) {
                this.lo |= l;
                this.hi |= h;
            } else if (n < 32) {
                this.lo |= l << n;
                this.hi |= (h << n) | (l >>> (32 - n));
            } else {
                this.hi |= l << (n - 32);
            }
            this.pos += (63 - n) >> 3;
            this.nbits = n | 56;
        } else {
            while (this.pos < this.end && this.nbits < 56) {
                const b = d[this.pos++], n = this.nbits;
                if (n < 32) {
                    this.lo |= b << n;
                    if (n > 24) this.hi |= b >>> (32 - n);
                } else {
                    this.hi |= b << (n - 32);
                }
                this.nbits += 8;
            }
        }
    }

    /** The next `num` (≤ 31) bits. */
    peek(num: number): number {
        return this.lo & ((1 << num) - 1);
    }

    consume(num: number): void {
        if (this.nbits < num) fail('corrupt bitstream');
        if (num > 0) {
            this.lo = (this.lo >>> num) | (this.hi << (32 - num));
            this.hi >>>= num;
        }
        this.nbits -= num;
    }

    readBits(num: number): number {
        if (this.nbits < num) this.fill();
        const value = this.peek(num);
        this.consume(num);
        return value;
    }
}

// ---- Canonical Huffman codes (huffman.rs, after libwebp's src/utils/huffman.c) ----

const MAX_ALLOWED_CODE_LENGTH = 15;
const MAX_TABLE_BITS = 10;

// Tree nodes: 0 = empty, > 0 = branch (offset to the children), < 0 = leaf -(symbol + 1).
const reverse16 = (v: number): number => {
    let r = 0;
    for (let i = 0; i < 16; i++) r |= ((v >> i) & 1) << (15 - i);
    return r;
};

export class HuffmanTree {
    /** The symbol of a single-node tree (no bits are read), or -1. */
    single: number;
    tree: number[];
    /** Entries `length << 16 | symbol`, or (for codes longer than the table) tree index + 1. */
    table: Uint32Array;
    tableMask: number;

    constructor(single: number, tree: number[] = [], table: Uint32Array = new Uint32Array(0), tableMask = 0) {
        this.single = single;
        this.tree = tree;
        this.table = table;
        this.tableMask = tableMask;
    }

    /** Builds a tree implicitly, just from code lengths */
    static buildImplicit(codeLengths: Uint16Array): HuffmanTree {
        // Count symbols and build histogram
        let numSymbols = 0;
        const hist = new Uint16Array(MAX_ALLOWED_CODE_LENGTH + 1);
        for (const length of codeLengths) {
            if (length !== 0) {
                hist[length]++;
                numSymbols++;
            }
        }

        // Handle special cases
        if (numSymbols === 0) fail('invalid Huffman code');
        if (numSymbols === 1) return new HuffmanTree(codeLengths.findIndex((x) => x !== 0));

        // Assign codes (u16 arithmetic, wrapping as in a release build: a complete code ends at 0 = 2 << 15)
        let currCode = 0;
        const nextCodes = new Uint16Array(MAX_ALLOWED_CODE_LENGTH + 1);
        let maxCodeLength = MAX_ALLOWED_CODE_LENGTH;
        while (hist[maxCodeLength] === 0) maxCodeLength--;
        for (let len = 1; len <= maxCodeLength; len++) {
            nextCodes[len] = currCode;
            currCode = ((currCode + hist[len]) << 1) & 0xffff;
        }

        // Confirm that the huffman tree is valid
        if (currCode !== ((2 << maxCodeLength) & 0xffff)) fail('invalid Huffman code');

        // Calculate table/tree parameters
        const tableBits = Math.min(maxCodeLength, MAX_TABLE_BITS);
        const tableSize = 1 << tableBits;
        const tableMask = tableSize - 1;

        // Populate decoding table
        const tree: number[] = [];
        const table = new Uint32Array(tableSize);
        for (let symbol = 0; symbol < codeLengths.length; symbol++) {
            const length = codeLengths[symbol];
            if (length === 0) continue;

            const code = nextCodes[length];
            nextCodes[length]++;

            if (length <= tableBits) {
                const entry = (length << 16) | symbol;
                for (let j = reverse16(code) >> (16 - length); j < tableSize; j += 1 << length) table[j] = entry;
            } else {
                const tableIndex = (reverse16(code) >> (16 - length)) & tableMask;
                const tableValue = table[tableIndex];

                let nodeIndex: number;
                if (tableValue === 0) {
                    nodeIndex = tree.length;
                    table[tableIndex] = nodeIndex + 1;
                    tree.push(0);
                } else {
                    nodeIndex = tableValue - 1;
                }

                for (let depth = length - tableBits - 1; depth >= 0; depth--) {
                    const node = tree[nodeIndex];
                    let offset: number;
                    if (node === 0) {
                        // Turns a node from empty into a branch and assigns its children
                        offset = tree.length - nodeIndex;
                        tree[nodeIndex] = offset;
                        tree.push(0, 0);
                    } else if (node > 0) {
                        offset = node;
                    } else {
                        return fail('invalid Huffman code');
                    }
                    nodeIndex += offset + ((code >> depth) & 1);
                }

                if (tree[nodeIndex] !== 0) fail('invalid Huffman code');
                tree[nodeIndex] = -(symbol + 1);
            }
        }

        return new HuffmanTree(-1, tree, table, tableMask);
    }

    static buildTwoNode(zero: number, one: number): HuffmanTree {
        return new HuffmanTree(-1, [-(zero + 1), -(one + 1), 0], new Uint32Array([(1 << 16) | zero, (1 << 16) | one]), 1);
    }

    /** Reads a symbol; `br.fill()` must have been called before (or the end of the stream may be misdetected). */
    readSymbol(br: BitReader): number {
        if (this.single >= 0) return this.single;
        let v = br.lo & 0xffff;
        const entry = this.table[v & this.tableMask];
        if (entry >>> 16 !== 0) {
            br.consume(entry >>> 16);
            return entry & 0xffff;
        }
        // slow path: walk the tree with the bits past the table
        v >>= MAX_TABLE_BITS;
        let depth = MAX_TABLE_BITS;
        let index = (entry & 0xffff) - 1;
        for (;;) {
            const node = this.tree[index];
            if (node > 0) {
                index += node + (v & 1);
                depth++;
                v >>= 1;
            } else if (node < 0) {
                br.consume(depth);
                return -node - 1;
            } else {
                return fail('invalid Huffman code');
            }
        }
    }

    /**
     * The `[codeLength, symbol]` of the next symbol if it can be read with only a primary table lookup.
     * May be wrong if there aren't enough bits in the bit reader.
     */
    peekSymbol(br: BitReader): [number, number] | undefined {
        if (this.single >= 0) return [0, this.single];
        const entry = this.table[br.lo & 0xffff & this.tableMask];
        return entry >>> 16 !== 0 ? [entry >>> 16, entry & 0xffff] : undefined;
    }
}

// ---- Lossless decoder (lossless.rs) ----

const CODE_LENGTH_CODES = 19;
const CODE_LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// prettier-ignore
const DISTANCE_MAP = [
    0, 1,  1, 0,  1, 1,  -1, 1, 0, 2,  2, 0,  1, 2,  -1, 2,
    2, 1,  -2, 1, 2, 2,  -2, 2, 0, 3,  3, 0,  1, 3,  -1, 3,
    3, 1,  -3, 1, 2, 3,  -2, 3, 3, 2,  -3, 2, 0, 4,  4, 0,
    1, 4,  -1, 4, 4, 1,  -4, 1, 3, 3,  -3, 3, 2, 4,  -2, 4,
    4, 2,  -4, 2, 0, 5,  3, 4,  -3, 4, 4, 3,  -4, 3, 5, 0,
    1, 5,  -1, 5, 5, 1,  -5, 1, 2, 5,  -2, 5, 5, 2,  -5, 2,
    4, 4,  -4, 4, 3, 5,  -3, 5, 5, 3,  -5, 3, 0, 6,  6, 0,
    1, 6,  -1, 6, 6, 1,  -6, 1, 2, 6,  -2, 6, 6, 2,  -6, 2,
    4, 5,  -4, 5, 5, 4,  -5, 4, 3, 6,  -3, 6, 6, 3,  -6, 3,
    0, 7,  7, 0,  1, 7,  -1, 7, 5, 5,  -5, 5, 7, 1,  -7, 1,
    4, 6,  -4, 6, 6, 4,  -6, 4, 2, 7,  -2, 7, 7, 2,  -7, 2,
    3, 7,  -3, 7, 7, 3,  -7, 3, 5, 6,  -5, 6, 6, 5,  -6, 5,
    8, 0,  4, 7,  -4, 7, 7, 4,  -7, 4, 8, 1,  8, 2,  6, 6,
    -6, 6, 8, 3,  5, 7,  -5, 7, 7, 5,  -7, 5, 8, 4,  6, 7,
    -6, 7, 7, 6,  -7, 6, 8, 5,  7, 7,  -7, 7, 8, 6,  8, 7,
];

const GREEN = 0;
const RED = 1;
const BLUE = 2;
const ALPHA = 3;
const DIST = 4;

const ALPHABET_SIZE = [256 + 24, 256, 256, 256, 40];

const subsampleSize = (size: number, bits: number): number => (size + (1 << bits) - 1) >> bits;

interface ColorCache {
    bits: number;
    colors: Uint8Array; // RGBA per entry
}

function cacheInsert(cache: ColorCache, d: Uint8Array, o: number): void {
    const argb = (d[o + 3] << 24) | (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    const index = Math.imul(0x1e35a7bd, argb) >>> (32 - cache.bits);
    cache.colors.set(d.subarray(o, o + 4), index * 4);
}

interface HuffmanInfo {
    xsize: number;
    colorCache: ColorCache | undefined;
    image: Uint16Array;
    bits: number;
    mask: number;
    groups: HuffmanTree[][];
}

const huffIndex = (info: HuffmanInfo, x: number, y: number): number =>
    info.bits === 0 ? 0 : info.image[(y >> info.bits) * info.xsize + (x >> info.bits)];

type Transform =
    | {kind: 'Predictor'; sizeBits: number; data: Uint8Array}
    | {kind: 'Color'; sizeBits: number; data: Uint8Array}
    | {kind: 'SubtractGreen'}
    | {kind: 'ColorIndexing'; tableSize: number; data: Uint8Array};

/**
 * Decodes a VP8L image from `br` into `buf` (RGBA, `width * height * 4` bytes). With
 * `implicitDimensions` (an ALPH chunk) there is no header and `width` / `height` are the frame's;
 * otherwise the header must match them. Throws on error.
 */
export function decodeLossless(br: BitReader, width: number, height: number, implicitDimensions: boolean, buf: Uint8Array): void {
    new LosslessDecoder(br).decodeFrame(width, height, implicitDimensions, buf);
}

class LosslessDecoder {
    br: BitReader;
    transforms: (Transform | undefined)[] = [undefined, undefined, undefined, undefined];
    transformOrder: number[] = [];
    width = 0;
    height = 0;

    constructor(br: BitReader) {
        this.br = br;
    }

    decodeFrame(width: number, height: number, implicitDimensions: boolean, buf: Uint8Array): void {
        const br = this.br;
        if (implicitDimensions) {
            this.width = width & 0xffff;
            this.height = height & 0xffff;
        } else {
            if (br.readBits(8) !== 0x2f) fail('invalid lossless signature');
            this.width = br.readBits(14) + 1;
            this.height = br.readBits(14) + 1;
            if (this.width !== width || this.height !== height) fail('inconsistent image sizes');
            br.readBits(1); // alpha used
            if (br.readBits(3) !== 0) fail('invalid lossless version number');
        }

        const transformedWidth = this.readTransforms();
        const transformedSize = transformedWidth * this.height * 4;
        this.decodeImageStream(transformedWidth, this.height, true, buf.subarray(0, transformedSize));

        let imageSize = transformedSize;
        let w = transformedWidth;
        for (let i = this.transformOrder.length - 1; i >= 0; i--) {
            const t = this.transforms[this.transformOrder[i]]!;
            switch (t.kind) {
                case 'Predictor':
                    applyPredictorTransform(buf.subarray(0, imageSize), w, this.height, t.sizeBits, t.data);
                    break;
                case 'Color':
                    applyColorTransform(buf.subarray(0, imageSize), w, t.sizeBits, t.data);
                    break;
                case 'SubtractGreen':
                    applySubtractGreenTransform(buf.subarray(0, imageSize));
                    break;
                case 'ColorIndexing':
                    w = this.width;
                    imageSize = w * this.height * 4;
                    applyColorIndexingTransform(buf, w, this.height, t.tableSize, t.data);
                    break;
            }
        }
    }

    /**
     * Reads image data in any of the 5 roles of the spec; only the ARGB image (`isArgbImg`) may have
     * meta Huffman codes.
     */
    decodeImageStream(xsize: number, ysize: number, isArgbImg: boolean, data: Uint8Array): void {
        const cacheBits = this.readColorCache();
        const colorCache = cacheBits === undefined ? undefined : {bits: cacheBits, colors: new Uint8Array(4 << cacheBits)};
        const info = this.readHuffmanCodes(isArgbImg, xsize, ysize, colorCache);
        this.decodeImageData(xsize, ysize, info, data);
    }

    /** Reads transforms and their data; returns the (possibly packed) width of the coded image. */
    readTransforms(): number {
        const br = this.br;
        let xsize = this.width;

        while (br.readBits(1) === 1) {
            const type = br.readBits(2);
            // can only have one of each transform
            if (this.transforms[type] !== undefined) fail('invalid transform');
            this.transformOrder.push(type);

            let t: Transform;
            if (type === 0 || type === 1) {
                const sizeBits = br.readBits(3) + 2;
                const bx = subsampleSize(xsize, sizeBits);
                const by = subsampleSize(this.height, sizeBits);
                const data = new Uint8Array(bx * by * 4);
                this.decodeImageStream(bx, by, false, data);
                t = {kind: type === 0 ? 'Predictor' : 'Color', sizeBits, data};
            } else if (type === 2) {
                t = {kind: 'SubtractGreen'};
            } else {
                const tableSize = br.readBits(8) + 1;
                const data = new Uint8Array(tableSize * 4);
                this.decodeImageStream(tableSize, 1, false, data);
                const bits = tableSize <= 2 ? 3 : tableSize <= 4 ? 2 : tableSize <= 16 ? 1 : 0;
                xsize = subsampleSize(xsize, bits);
                // the color map is subtraction coded
                for (let i = 4; i < data.length; i++) data[i] += data[i - 4];
                t = {kind: 'ColorIndexing', tableSize, data};
            }
            this.transforms[type] = t;
        }

        return xsize;
    }

    readHuffmanCodes(readMeta: boolean, xsize: number, ysize: number, colorCache: ColorCache | undefined): HuffmanInfo {
        const br = this.br;
        let numHuffGroups = 1;
        let bits = 0;
        let hx = 1;
        let image = new Uint16Array(0);

        if (readMeta && br.readBits(1) === 1) {
            // meta huffman codes
            bits = br.readBits(3) + 2;
            hx = subsampleSize(xsize, bits);
            const hy = subsampleSize(ysize, bits);
            const data = new Uint8Array(hx * hy * 4);
            this.decodeImageStream(hx, hy, false, data);
            image = new Uint16Array(hx * hy);
            for (let i = 0; i < image.length; i++) {
                const code = (data[4 * i] << 8) | data[4 * i + 1];
                image[i] = code;
                if (code >= numHuffGroups) numHuffGroups = code + 1;
            }
        }

        const groups: HuffmanTree[][] = [];
        for (let i = 0; i < numHuffGroups; i++) {
            const group: HuffmanTree[] = [];
            for (let j = 0; j < 5; j++) {
                let alphabetSize = ALPHABET_SIZE[j];
                if (j === 0 && colorCache) alphabetSize += 1 << colorCache.bits;
                group.push(this.readHuffmanCode(alphabetSize));
            }
            groups.push(group);
        }

        return {xsize: hx, colorCache, image, bits, mask: bits === 0 ? 0xffff : (1 << bits) - 1, groups};
    }

    readHuffmanCode(alphabetSize: number): HuffmanTree {
        const br = this.br;
        if (br.readBits(1) === 1) {
            // simple code
            const numSymbols = br.readBits(1) + 1;
            const isFirst8Bits = br.readBits(1);
            const zeroSymbol = br.readBits(1 + 7 * isFirst8Bits);
            if (zeroSymbol >= alphabetSize) fail('corrupt bitstream');
            if (numSymbols === 1) return new HuffmanTree(zeroSymbol);
            const oneSymbol = br.readBits(8);
            if (oneSymbol >= alphabetSize) fail('corrupt bitstream');
            return HuffmanTree.buildTwoNode(zeroSymbol, oneSymbol);
        }

        const codeLengthCodeLengths = new Uint16Array(CODE_LENGTH_CODES);
        const numCodeLengths = 4 + br.readBits(4);
        for (let i = 0; i < numCodeLengths; i++) codeLengthCodeLengths[CODE_LENGTH_CODE_ORDER[i]] = br.readBits(3);
        return HuffmanTree.buildImplicit(this.readHuffmanCodeLengths(codeLengthCodeLengths, alphabetSize));
    }

    readHuffmanCodeLengths(codeLengthCodeLengths: Uint16Array, numSymbols: number): Uint16Array {
        const br = this.br;
        const table = HuffmanTree.buildImplicit(codeLengthCodeLengths);

        let maxSymbol: number;
        if (br.readBits(1) === 1) {
            const lengthNbits = 2 + 2 * br.readBits(3);
            const maxMinusTwo = br.readBits(lengthNbits);
            if (maxMinusTwo > numSymbols - 2) fail('corrupt bitstream');
            maxSymbol = 2 + maxMinusTwo;
        } else {
            maxSymbol = numSymbols;
        }

        const codeLengths = new Uint16Array(numSymbols);
        let prevCodeLen = 8; // default code length

        let symbol = 0;
        while (symbol < numSymbols) {
            if (maxSymbol === 0) break;
            maxSymbol--;

            br.fill();
            const codeLen = table.readSymbol(br);

            if (codeLen < 16) {
                codeLengths[symbol++] = codeLen;
                if (codeLen !== 0) prevCodeLen = codeLen;
            } else {
                const slot = codeLen - 16;
                if (slot > 2) fail('corrupt bitstream');
                const extraBits = [2, 3, 7][slot];
                const repeatOffset = slot === 2 ? 11 : 3;
                const repeat = br.readBits(extraBits) + repeatOffset;
                if (symbol + repeat > numSymbols) fail('corrupt bitstream');
                codeLengths.fill(codeLen === 16 ? prevCodeLen : 0, symbol, symbol + repeat);
                symbol += repeat;
            }
        }

        return codeLengths;
    }

    /** Decodes the entropy-coded image: literals, backward references and color cache lookups. */
    decodeImageData(width: number, height: number, info: HuffmanInfo, data: Uint8Array): void {
        const br = this.br;
        const numValues = width * height;
        const cache = info.colorCache;

        let tree = info.groups[huffIndex(info, 0, 0)];
        let index = 0;
        let nextBlockStart = 0;
        while (index < numValues) {
            br.fill();

            if (index >= nextBlockStart) {
                const x = index % width;
                const y = Math.floor(index / width);
                nextBlockStart = Math.min(x | info.mask, width - 1) + y * width + 1;
                tree = info.groups[huffIndex(info, x, y)];

                // Fast path: If all the codes each contain only a single symbol, then the pixel data
                // isn't written to the bitstream and we can just fill the output buffer with the
                // symbol directly.
                if (tree[0].single >= 0 && tree[1].single >= 0 && tree[2].single >= 0 && tree[3].single >= 0) {
                    const code = tree[GREEN].single;
                    if (code < 256) {
                        const n = info.bits === 0 ? numValues : nextBlockStart - index;
                        const red = tree[RED].single, blue = tree[BLUE].single, alpha = tree[ALPHA].single;
                        for (let i = index * 4; i < (index + n) * 4; i += 4) {
                            data[i] = red;
                            data[i + 1] = code;
                            data[i + 2] = blue;
                            data[i + 3] = alpha;
                        }
                        if (cache) cacheInsert(cache, data, index * 4);
                        index += n;
                        continue;
                    }
                }
            }

            const code = tree[GREEN].readSymbol(br);

            if (code < 256) {
                // literal
                const o = index * 4;
                data[o + 1] = code;
                data[o] = tree[RED].readSymbol(br);
                data[o + 2] = tree[BLUE].readSymbol(br);
                if (br.nbits < 15) br.fill();
                data[o + 3] = tree[ALPHA].readSymbol(br);
                if (cache) cacheInsert(cache, data, o);
                index += 1;
            } else if (code < 256 + 24) {
                // backward reference
                const length = getCopyDistance(br, code - 256);
                const distSymbol = tree[DIST].readSymbol(br);
                const distCode = getCopyDistance(br, distSymbol);
                const dist = planeCodeToDistance(width, distCode);

                if (index < dist || numValues - index < length) fail('corrupt bitstream');

                const o = index * 4;
                if (dist === 1) {
                    for (let i = 0; i < length * 4; i++) data[o + i] = data[o - 4 + (i & 3)];
                } else {
                    // (the crate copies 16 bytes at a time, but bytes past `length` are rewritten later)
                    for (let i = 0; i < length * 4; i++) data[o + i] = data[o + i - dist * 4];
                    // only references with a distance other than 1 go into the color cache
                    if (cache) for (let i = 0; i < length; i++) cacheInsert(cache, data, o + i * 4);
                }
                index += length;
            } else {
                // color cache
                if (!cache) return fail('corrupt bitstream');
                data.set(cache.colors.subarray((code - 280) * 4, (code - 280) * 4 + 4), index * 4);
                index += 1;

                if (index < nextBlockStart) {
                    const peek = tree[GREEN].peekSymbol(br);
                    if (peek && peek[1] >= 280) {
                        br.consume(peek[0]);
                        data.set(cache.colors.subarray((peek[1] - 280) * 4, (peek[1] - 280) * 4 + 4), index * 4);
                        index += 1;
                    }
                }
            }
        }
    }

    readColorCache(): number | undefined {
        if (this.br.readBits(1) !== 1) return undefined;
        const codeBits = this.br.readBits(4);
        if (codeBits < 1 || codeBits > 11) fail('invalid color cache bits');
        return codeBits;
    }
}

/** Length or distance from its prefix code and extra bits. */
function getCopyDistance(br: BitReader, prefixCode: number): number {
    if (prefixCode < 4) return prefixCode + 1;
    const extraBits = (prefixCode - 2) >> 1;
    const offset = (2 + (prefixCode & 1)) << extraBits;
    const bits = br.peek(extraBits);
    br.consume(extraBits);
    return offset + bits + 1;
}

function planeCodeToDistance(xsize: number, planeCode: number): number {
    if (planeCode > 120) return planeCode - 120;
    const dist = DISTANCE_MAP[2 * (planeCode - 1)] + DISTANCE_MAP[2 * (planeCode - 1) + 1] * xsize;
    return dist < 1 ? 1 : dist;
}

// ---- Inverse transforms (lossless_transform.rs) ----

const average2 = (a: number, b: number): number => (a + b) >> 1;
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function applyPredictorTransform(d: Uint8Array, width: number, height: number, sizeBits: number, predictorData: Uint8Array): void {
    const blockXsize = subsampleSize(width, sizeBits);
    const w4 = width * 4;

    // Top and left borders ignore the mode: black for the first pixel, L for the first row, T for the first column.
    d[3] += 255;
    for (let i = 4; i < w4; i++) d[i] += d[i - 4];
    for (let y = 1; y < height; y++) {
        for (let i = 0; i < 4; i++) d[y * w4 + i] += d[(y - 1) * w4 + i];
    }

    for (let y = 1; y < height; y++) {
        for (let blockX = 0; blockX < blockXsize; blockX++) {
            const blockIndex = (y >> sizeBits) * blockXsize + blockX;
            const predictor = predictorData[blockIndex * 4 + 1];
            const start = (y * width + Math.max(blockX << sizeBits, 1)) * 4;
            const end = (y * width + Math.min((blockX + 1) << sizeBits, width)) * 4;
            if (predictor > 13) continue;
            for (let i = start; i < end; i += 4) {
                const l = i - 4, t = i - w4, tr = t + 4, tl = t - 4;
                if (predictor === 11) {
                    // Select: the one of L and T closer to L + T - TL
                    let predictLeft = 0, predictTop = 0;
                    for (let k = 0; k < 4; k++) {
                        const predict = d[l + k] + d[t + k] - d[tl + k];
                        predictLeft += Math.abs(predict - d[l + k]);
                        predictTop += Math.abs(predict - d[t + k]);
                    }
                    const src = predictLeft < predictTop ? l : t;
                    for (let k = 0; k < 4; k++) d[i + k] += d[src + k];
                    continue;
                }
                for (let k = 0; k < 4; k++) {
                    const L = d[l + k], T = d[t + k], TR = d[tr + k], TL = d[tl + k];
                    let p: number;
                    switch (predictor) {
                        case 0: p = k === 3 ? 0xff : 0; break;
                        case 1: p = L; break;
                        case 2: p = T; break;
                        case 3: p = TR; break;
                        case 4: p = TL; break;
                        case 5: p = average2(average2(L, TR), T); break;
                        case 6: p = average2(L, TL); break;
                        case 7: p = average2(L, T); break;
                        case 8: p = average2(TL, T); break;
                        case 9: p = average2(T, TR); break;
                        case 10: p = average2(average2(L, TL), average2(T, TR)); break;
                        case 12: p = clampByte(L + T - TL); break;
                        default: {
                            // 13: clamp_add_subtract_half; Rust i16 division truncates toward zero
                            const a = (L + T) >> 1;
                            p = clampByte(a + Math.trunc((a - TL) / 2));
                        }
                    }
                    d[i + k] += p;
                }
            }
        }
    }
}

/** `(t as i8 * c as i8) as u32 >> 5` */
const colorTransformDelta = (t: number, c: number): number => (Math.imul((t << 24) >> 24, (c << 24) >> 24) >>> 0) >>> 5;

function applyColorTransform(d: Uint8Array, width: number, sizeBits: number, transformData: Uint8Array): void {
    const blockXsize = subsampleSize(width, sizeBits);
    const rows = Math.floor(d.length / (width * 4));
    for (let y = 0; y < rows; y++) {
        const tf = (y >> sizeBits) * blockXsize * 4;
        for (let x = 0; x < width; x++) {
            const t = tf + (x >> sizeBits) * 4;
            if (t + 4 > transformData.length) break;
            const redToBlue = transformData[t], greenToBlue = transformData[t + 1], greenToRed = transformData[t + 2];
            const p = (y * width + x) * 4;
            const green = d[p + 1];
            const tempRed = d[p] + colorTransformDelta(greenToRed, green);
            let tempBlue = d[p + 2] + colorTransformDelta(greenToBlue, green);
            tempBlue += colorTransformDelta(redToBlue, tempRed & 0xff);
            d[p] = tempRed & 0xff;
            d[p + 2] = tempBlue & 0xff;
        }
    }
}

function applySubtractGreenTransform(d: Uint8Array): void {
    for (let i = 0; i + 3 < d.length; i += 4) {
        d[i] += d[i + 1];
        d[i + 2] += d[i + 1];
    }
}

/** Expands palette indices (packed 2/4/8 per byte for small tables) in place, bottom row first. */
function applyColorIndexingTransform(d: Uint8Array, width: number, height: number, tableSize: number, table: Uint8Array): void {
    if (tableSize > 16) {
        // out-of-bounds indices are [0,0,0,0] (WebP spec)
        const padded = new Uint8Array(256 * 4);
        padded.set(table.subarray(0, 256 * 4));
        for (let i = 0; i + 3 < d.length; i += 4) d.set(padded.subarray(d[i + 1] * 4, d[i + 1] * 4 + 4), i);
        return;
    }
    const wBits = tableSize <= 2 ? 3 : tableSize <= 4 ? 2 : 1;
    const pixelsPerByte = 1 << wBits;
    const bitsPerEntry = 8 / pixelsPerByte;
    const mask = (1 << bitsPerEntry) - 1;
    const packedWidth = Math.ceil(width / pixelsPerByte);
    if (width === 0 || height === 0) return;

    const indices = new Uint8Array(packedWidth);
    for (let y = height - 1; y >= 0; y--) {
        for (let k = 0; k < packedWidth; k++) indices[k] = d[(y * packedWidth + k) * 4 + 1];
        for (let x = 0; x < width; x++) {
            const k = (indices[x >> wBits] >> ((x & (pixelsPerByte - 1)) * bitsPerEntry)) & mask;
            const o = (y * width + x) * 4;
            if (k < tableSize) d.set(table.subarray(k * 4, k * 4 + 4), o);
            else d.fill(0, o, o + 4);
        }
    }
}

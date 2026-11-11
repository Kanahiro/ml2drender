// VP8 lossy decoding (keyframes only, RFC 6386): port of image-webp 0.2.4 `vp8.rs`,
// `vp8_arithmetic_decoder.rs`, `loop_filter.rs`, `transform.rs` and the bilinear ("fancy") chroma
// upsampling of `yuv.rs`, the crate's default (the "simple" upsampling option is never used).

const fail = (msg: string): never => {
    throw new Error(`webp: ${msg}`);
};

// ---- Boolean entropy decoder (vp8_arithmetic_decoder.rs) ----

const EOF = -0xe;
const POW2 = Float64Array.from({length: 64}, (_, i) => 2 ** i);

/**
 * The crate reads 4 bytes at a time into a u64 and, past the last whole chunk, the 1..3 final bytes
 * one by one; libwebp seems to (sometimes?) allow bitstreams that read one byte past the end, which is
 * replicated by allowing one implicit zero byte. Reading further sets the sticky EOF state, reported as
 * an error at the next `check` (reads past EOF return 0 bits meanwhile). This is the crate's "cold" path;
 * its fast path gives the same results. `value` stays below 2^40, exact in a double.
 */
class ArithmeticDecoder {
    buf: Uint8Array = new Uint8Array(0);
    nChunks = 0;
    chunkIndex = 0;
    value = 0;
    range = 255;
    bitCount = -8;
    finalPos = 0;
    finalBytesRemaining = EOF;

    init(buf: Uint8Array): void {
        const rem = buf.length % 4;
        this.buf = buf;
        this.nChunks = (buf.length - rem) / 4;
        this.finalPos = buf.length - rem;
        this.finalBytesRemaining = rem;
        this.chunkIndex = 0;
        this.value = 0;
        this.range = 255;
        this.bitCount = -8;
    }

    /** Errors if any read so far went past the end of the data. */
    check(): void {
        if (this.finalBytesRemaining === EOF) fail('corrupt bitstream');
    }

    readBit(probability: number): boolean {
        if (this.bitCount < 0) {
            if (this.chunkIndex < this.nChunks) {
                const b = this.buf, p = this.chunkIndex * 4;
                const v = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
                this.chunkIndex++;
                this.value = this.value * 4294967296 + v;
                this.bitCount += 32;
            } else {
                if (this.finalBytesRemaining >= 1) {
                    this.finalBytesRemaining--;
                    this.value = this.value * 256 + this.buf[this.finalPos++];
                    this.bitCount += 8;
                } else if (this.finalBytesRemaining === 0) {
                    this.finalBytesRemaining--;
                    this.value *= 256;
                    this.bitCount += 8;
                } else {
                    this.finalBytesRemaining = EOF;
                    return false;
                }
            }
        }
        const split = 1 + (((this.range - 1) * probability) >> 8);
        const bigsplit = split * POW2[this.bitCount];
        let ret: boolean;
        if (this.value >= bigsplit) {
            this.range -= split;
            this.value -= bigsplit;
            ret = true;
        } else {
            this.range = split;
            ret = false;
        }
        // Shift so that `range >= 128`.
        const shift = Math.max(0, Math.clz32(this.range) - 24);
        this.range <<= shift;
        this.bitCount -= shift;
        return ret;
    }

    readFlag(): boolean {
        return this.readBit(128);
    }

    readLiteral(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) + (this.readBit(128) ? 1 : 0);
        return v;
    }

    readOptionalSignedValue(n: number): number {
        // We should not read further bits if the flag is not set.
        if (!this.readFlag()) return 0;
        const magnitude = this.readLiteral(n);
        return this.readFlag() ? -magnitude : magnitude;
    }

    /** Walks a tree (`lr`: left/right branch per node, see `treeLr`) from node `start`. */
    readTree(lr: Uint8Array, probs: Uint8Array, probOff: number, start: number): number {
        let i = start;
        for (;;) {
            const t = lr[2 * i + (this.readBit(probs[probOff + i]) ? 1 : 0)];
            if (t < 0x80) i = t;
            else return t & 0x7f;
        }
    }
}

// ---- Constants and trees ----

const MAX_SEGMENTS = 4;

// Prediction modes
const DC_PRED = 0;
const V_PRED = 1;
const H_PRED = 2;
const TM_PRED = 3;
const B_PRED = 4;

const B_DC_PRED = 0;
const B_TM_PRED = 1;
const B_VE_PRED = 2;
const B_HE_PRED = 3;
const B_LD_PRED = 4;
const B_RD_PRED = 5;
const B_VR_PRED = 6;
const B_VL_PRED = 7;
const B_HD_PRED = 8;
const B_HU_PRED = 9;

/** `TreeNode::prepare_branch` for each entry: a node index, or 0x80 | leaf value. */
const treeLr = (tree: number[]): Uint8Array => Uint8Array.from(tree, (t) => (t > 0 ? t >> 1 : 0x80 | -t));

const SEGMENT_ID_LR = treeLr([2, 4, -0, -1, -2, -3]);

// Section 11.2
// Tree for determining the keyframe luma intra prediction modes:
const KEYFRAME_YMODE_LR = treeLr([-B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED]);
// Default probabilities for decoding the keyframe luma modes
const KEYFRAME_YMODE_PROBS = new Uint8Array([145, 156, 163, 128]);

// Tree for determining the keyframe B_PRED mode:
const KEYFRAME_BPRED_MODE_LR = treeLr([
    -B_DC_PRED, 2, -B_TM_PRED, 4, -B_VE_PRED, 6, 8, 12, -B_HE_PRED, 10, -B_RD_PRED, -B_VR_PRED,
    -B_LD_PRED, 14, -B_VL_PRED, 16, -B_HD_PRED, -B_HU_PRED,
]);

// Section 11.4 Tree for determining macroblock the chroma mode
const KEYFRAME_UV_MODE_LR = treeLr([-DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED]);
// Probabilities for determining macroblock mode
const KEYFRAME_UV_MODE_PROBS = new Uint8Array([142, 114, 183]);

// DCT Tokens
const DCT_0 = 0;
const DCT_1 = 1;
const DCT_2 = 2;
const DCT_3 = 3;
const DCT_4 = 4;
const DCT_CAT1 = 5;
const DCT_CAT2 = 6;
const DCT_CAT3 = 7;
const DCT_CAT4 = 8;
const DCT_CAT5 = 9;
const DCT_CAT6 = 10;
const DCT_EOB = 11;

const DCT_TOKEN_LR = treeLr([
    -DCT_EOB, 2, -DCT_0, 4, -DCT_1, 6, 8, 12, -DCT_2, 10, -DCT_3, -DCT_4, 14, 16, -DCT_CAT1,
    -DCT_CAT2, 18, 20, -DCT_CAT3, -DCT_CAT4, -DCT_CAT5, -DCT_CAT6,
]);

const PROB_DCT_CAT = [
    [159],
    [165, 145],
    [173, 148, 140],
    [176, 155, 140, 135],
    [180, 157, 141, 134, 130],
    [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];

const DCT_CAT_BASE = [5, 7, 11, 19, 35, 67];
const COEFF_BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7];
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];

// Probabilities for the BPRED_MODE_TREE, [top][left][node]
const KEYFRAME_BPRED_MODE_PROBS = new Uint8Array([
    231, 120, 48, 89, 115, 113, 120, 152, 112,
    152, 179, 64, 126, 170, 118, 46, 70, 95,
    175, 69, 143, 80, 85, 82, 72, 155, 103,
    56, 58, 10, 171, 218, 189, 17, 13, 152,
    144, 71, 10, 38, 171, 213, 144, 34, 26,
    114, 26, 17, 163, 44, 195, 21, 10, 173,
    121, 24, 80, 195, 26, 62, 44, 64, 85,
    170, 46, 55, 19, 136, 160, 33, 206, 71,
    63, 20, 8, 114, 114, 208, 12, 9, 226,
    81, 40, 11, 96, 182, 84, 29, 16, 36,
    134, 183, 89, 137, 98, 101, 106, 165, 148,
    72, 187, 100, 130, 157, 111, 32, 75, 80,
    66, 102, 167, 99, 74, 62, 40, 234, 128,
    41, 53, 9, 178, 241, 141, 26, 8, 107,
    104, 79, 12, 27, 217, 255, 87, 17, 7,
    74, 43, 26, 146, 73, 166, 49, 23, 157,
    65, 38, 105, 160, 51, 52, 31, 115, 128,
    87, 68, 71, 44, 114, 51, 15, 186, 23,
    47, 41, 14, 110, 182, 183, 21, 17, 194,
    66, 45, 25, 102, 197, 189, 23, 18, 22,
    88, 88, 147, 150, 42, 46, 45, 196, 205,
    43, 97, 183, 117, 85, 38, 35, 179, 61,
    39, 53, 200, 87, 26, 21, 43, 232, 171,
    56, 34, 51, 104, 114, 102, 29, 93, 77,
    107, 54, 32, 26, 51, 1, 81, 43, 31,
    39, 28, 85, 171, 58, 165, 90, 98, 64,
    34, 22, 116, 206, 23, 34, 43, 166, 73,
    68, 25, 106, 22, 64, 171, 36, 225, 114,
    34, 19, 21, 102, 132, 188, 16, 76, 124,
    62, 18, 78, 95, 85, 57, 50, 48, 51,
    193, 101, 35, 159, 215, 111, 89, 46, 111,
    60, 148, 31, 172, 219, 228, 21, 18, 111,
    112, 113, 77, 85, 179, 255, 38, 120, 114,
    40, 42, 1, 196, 245, 209, 10, 25, 109,
    100, 80, 8, 43, 154, 1, 51, 26, 71,
    88, 43, 29, 140, 166, 213, 37, 43, 154,
    61, 63, 30, 155, 67, 45, 68, 1, 209,
    142, 78, 78, 16, 255, 128, 34, 197, 171,
    41, 40, 5, 102, 211, 183, 4, 1, 221,
    51, 50, 17, 168, 209, 192, 23, 25, 82,
    125, 98, 42, 88, 104, 85, 117, 175, 82,
    95, 84, 53, 89, 128, 100, 113, 101, 45,
    75, 79, 123, 47, 51, 128, 81, 171, 1,
    57, 17, 5, 71, 102, 57, 53, 41, 49,
    115, 21, 2, 10, 102, 255, 166, 23, 6,
    38, 33, 13, 121, 57, 73, 26, 1, 85,
    41, 10, 67, 138, 77, 110, 90, 47, 114,
    101, 29, 16, 10, 85, 128, 101, 196, 26,
    57, 18, 10, 102, 102, 213, 34, 20, 43,
    117, 20, 15, 36, 163, 128, 68, 1, 26,
    138, 31, 36, 171, 27, 166, 38, 44, 229,
    67, 87, 58, 169, 82, 115, 26, 59, 179,
    63, 59, 90, 180, 59, 166, 93, 73, 154,
    40, 40, 21, 116, 143, 209, 34, 39, 175,
    57, 46, 22, 24, 128, 1, 54, 17, 37,
    47, 15, 16, 183, 34, 223, 49, 45, 183,
    46, 17, 33, 183, 6, 98, 15, 32, 183,
    65, 32, 73, 115, 28, 128, 23, 128, 205,
    40, 3, 9, 115, 51, 192, 18, 6, 223,
    87, 37, 9, 115, 59, 77, 64, 21, 47,
    104, 55, 44, 218, 9, 54, 53, 130, 226,
    64, 90, 70, 205, 40, 41, 23, 26, 57,
    54, 57, 112, 184, 5, 41, 38, 166, 213,
    30, 34, 26, 133, 152, 116, 10, 32, 134,
    75, 32, 12, 51, 192, 255, 160, 43, 51,
    39, 19, 53, 221, 26, 114, 32, 73, 255,
    31, 9, 65, 234, 2, 15, 1, 118, 73,
    88, 31, 35, 67, 102, 85, 55, 186, 85,
    56, 21, 23, 111, 59, 205, 45, 37, 192,
    55, 38, 70, 124, 73, 102, 1, 34, 98,
    102, 61, 71, 37, 34, 53, 31, 243, 192,
    69, 60, 71, 38, 73, 119, 28, 222, 37,
    68, 45, 128, 34, 1, 47, 11, 245, 171,
    62, 17, 19, 70, 146, 85, 55, 62, 70,
    75, 15, 9, 9, 64, 255, 184, 119, 16,
    37, 43, 37, 154, 100, 163, 85, 160, 1,
    63, 9, 92, 136, 28, 64, 32, 201, 85,
    86, 6, 28, 5, 64, 255, 25, 248, 1,
    56, 8, 17, 132, 137, 255, 55, 116, 128,
    58, 15, 20, 82, 135, 57, 26, 121, 40,
    164, 50, 31, 137, 154, 133, 25, 35, 218,
    51, 103, 44, 131, 131, 123, 31, 6, 158,
    86, 40, 64, 135, 148, 224, 45, 183, 128,
    22, 26, 17, 131, 240, 154, 14, 1, 209,
    83, 12, 13, 54, 192, 255, 68, 47, 28,
    45, 16, 21, 91, 64, 222, 7, 1, 197,
    56, 21, 39, 155, 60, 138, 23, 102, 213,
    85, 26, 85, 85, 128, 128, 32, 146, 171,
    18, 11, 7, 63, 144, 171, 4, 4, 246,
    35, 27, 10, 146, 174, 171, 12, 26, 128,
    190, 80, 35, 99, 180, 80, 126, 54, 45,
    85, 126, 47, 87, 176, 51, 41, 20, 32,
    101, 75, 128, 139, 118, 146, 116, 128, 85,
    56, 41, 15, 176, 236, 85, 37, 9, 62,
    146, 36, 19, 30, 171, 255, 97, 27, 20,
    71, 30, 17, 119, 118, 255, 17, 18, 138,
    101, 38, 60, 138, 55, 70, 43, 26, 142,
    138, 45, 61, 62, 219, 1, 81, 188, 64,
    32, 41, 20, 117, 151, 142, 20, 21, 163,
    112, 19, 12, 61, 195, 128, 48, 4, 24,
]);

// Section 13.4: token probabilities, [plane 4][band 8][complexity 3][node 11].
// Probabilities that a token's probability will be updated
const COEFF_UPDATE_PROBS = new Uint8Array([
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    176, 246, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    223, 241, 252, 255, 255, 255, 255, 255, 255, 255, 255,
    249, 253, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 244, 252, 255, 255, 255, 255, 255, 255, 255, 255,
    234, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    253, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 246, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    239, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 248, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    251, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    251, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 254, 253, 255, 254, 255, 255, 255, 255, 255, 255,
    250, 255, 254, 255, 254, 255, 255, 255, 255, 255, 255,
    254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    217, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    225, 252, 241, 253, 255, 255, 254, 255, 255, 255, 255,
    234, 250, 241, 250, 253, 255, 253, 254, 255, 255, 255,
    255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    223, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    238, 253, 254, 254, 255, 255, 255, 255, 255, 255, 255,
    255, 248, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    249, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 253, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    247, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    253, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 254, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    186, 251, 250, 255, 255, 255, 255, 255, 255, 255, 255,
    234, 251, 244, 254, 255, 255, 255, 255, 255, 255, 255,
    251, 251, 243, 253, 254, 255, 254, 255, 255, 255, 255,
    255, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    236, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    251, 253, 253, 254, 254, 255, 255, 255, 255, 255, 255,
    255, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    248, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    250, 254, 252, 254, 255, 255, 255, 255, 255, 255, 255,
    248, 254, 249, 253, 255, 255, 255, 255, 255, 255, 255,
    255, 253, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    246, 253, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    252, 254, 251, 254, 254, 255, 255, 255, 255, 255, 255,
    255, 254, 252, 255, 255, 255, 255, 255, 255, 255, 255,
    248, 254, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    253, 255, 254, 254, 255, 255, 255, 255, 255, 255, 255,
    255, 251, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    245, 251, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    253, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 251, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    252, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    249, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 253, 255, 255, 255, 255, 255, 255, 255, 255,
    250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
]);

// Default token probabilities
const COEFF_PROBS = new Uint8Array([
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    253, 136, 254, 255, 228, 219, 128, 128, 128, 128, 128,
    189, 129, 242, 255, 227, 213, 255, 219, 128, 128, 128,
    106, 126, 227, 252, 214, 209, 255, 255, 128, 128, 128,
    1, 98, 248, 255, 236, 226, 255, 255, 128, 128, 128,
    181, 133, 238, 254, 221, 234, 255, 154, 128, 128, 128,
    78, 134, 202, 247, 198, 180, 255, 219, 128, 128, 128,
    1, 185, 249, 255, 243, 255, 128, 128, 128, 128, 128,
    184, 150, 247, 255, 236, 224, 128, 128, 128, 128, 128,
    77, 110, 216, 255, 236, 230, 128, 128, 128, 128, 128,
    1, 101, 251, 255, 241, 255, 128, 128, 128, 128, 128,
    170, 139, 241, 252, 236, 209, 255, 255, 128, 128, 128,
    37, 116, 196, 243, 228, 255, 255, 255, 128, 128, 128,
    1, 204, 254, 255, 245, 255, 128, 128, 128, 128, 128,
    207, 160, 250, 255, 238, 128, 128, 128, 128, 128, 128,
    102, 103, 231, 255, 211, 171, 128, 128, 128, 128, 128,
    1, 152, 252, 255, 240, 255, 128, 128, 128, 128, 128,
    177, 135, 243, 255, 234, 225, 128, 128, 128, 128, 128,
    80, 129, 211, 255, 194, 224, 128, 128, 128, 128, 128,
    1, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    246, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    255, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    198, 35, 237, 223, 193, 187, 162, 160, 145, 155, 62,
    131, 45, 198, 221, 172, 176, 220, 157, 252, 221, 1,
    68, 47, 146, 208, 149, 167, 221, 162, 255, 223, 128,
    1, 149, 241, 255, 221, 224, 255, 255, 128, 128, 128,
    184, 141, 234, 253, 222, 220, 255, 199, 128, 128, 128,
    81, 99, 181, 242, 176, 190, 249, 202, 255, 255, 128,
    1, 129, 232, 253, 214, 197, 242, 196, 255, 255, 128,
    99, 121, 210, 250, 201, 198, 255, 202, 128, 128, 128,
    23, 91, 163, 242, 170, 187, 247, 210, 255, 255, 128,
    1, 200, 246, 255, 234, 255, 128, 128, 128, 128, 128,
    109, 178, 241, 255, 231, 245, 255, 255, 128, 128, 128,
    44, 130, 201, 253, 205, 192, 255, 255, 128, 128, 128,
    1, 132, 239, 251, 219, 209, 255, 165, 128, 128, 128,
    94, 136, 225, 251, 218, 190, 255, 255, 128, 128, 128,
    22, 100, 174, 245, 186, 161, 255, 199, 128, 128, 128,
    1, 182, 249, 255, 232, 235, 128, 128, 128, 128, 128,
    124, 143, 241, 255, 227, 234, 128, 128, 128, 128, 128,
    35, 77, 181, 251, 193, 211, 255, 205, 128, 128, 128,
    1, 157, 247, 255, 236, 231, 255, 255, 128, 128, 128,
    121, 141, 235, 255, 225, 227, 255, 255, 128, 128, 128,
    45, 99, 188, 251, 195, 217, 255, 224, 128, 128, 128,
    1, 1, 251, 255, 213, 255, 128, 128, 128, 128, 128,
    203, 1, 248, 255, 255, 128, 128, 128, 128, 128, 128,
    137, 1, 177, 255, 224, 255, 128, 128, 128, 128, 128,
    253, 9, 248, 251, 207, 208, 255, 192, 128, 128, 128,
    175, 13, 224, 243, 193, 185, 249, 198, 255, 255, 128,
    73, 17, 171, 221, 161, 179, 236, 167, 255, 234, 128,
    1, 95, 247, 253, 212, 183, 255, 255, 128, 128, 128,
    239, 90, 244, 250, 211, 209, 255, 255, 128, 128, 128,
    155, 77, 195, 248, 188, 195, 255, 255, 128, 128, 128,
    1, 24, 239, 251, 218, 219, 255, 205, 128, 128, 128,
    201, 51, 219, 255, 196, 186, 128, 128, 128, 128, 128,
    69, 46, 190, 239, 201, 218, 255, 228, 128, 128, 128,
    1, 191, 251, 255, 255, 128, 128, 128, 128, 128, 128,
    223, 165, 249, 255, 213, 255, 128, 128, 128, 128, 128,
    141, 124, 248, 255, 255, 128, 128, 128, 128, 128, 128,
    1, 16, 248, 255, 255, 128, 128, 128, 128, 128, 128,
    190, 36, 230, 255, 236, 255, 128, 128, 128, 128, 128,
    149, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    1, 226, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    247, 192, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    240, 128, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    1, 134, 252, 255, 255, 128, 128, 128, 128, 128, 128,
    213, 62, 250, 255, 255, 128, 128, 128, 128, 128, 128,
    55, 93, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
    202, 24, 213, 235, 186, 191, 220, 160, 240, 175, 255,
    126, 38, 182, 232, 169, 184, 228, 174, 255, 187, 128,
    61, 46, 138, 219, 151, 178, 240, 170, 255, 216, 128,
    1, 112, 230, 250, 199, 191, 247, 159, 255, 255, 128,
    166, 109, 228, 252, 211, 215, 255, 174, 128, 128, 128,
    39, 77, 162, 232, 172, 180, 245, 178, 255, 255, 128,
    1, 52, 220, 246, 198, 199, 249, 220, 255, 255, 128,
    124, 74, 191, 243, 183, 193, 250, 221, 255, 255, 128,
    24, 71, 130, 219, 154, 170, 243, 182, 255, 255, 128,
    1, 182, 225, 249, 219, 240, 255, 224, 128, 128, 128,
    149, 150, 226, 252, 216, 205, 255, 171, 128, 128, 128,
    28, 108, 170, 242, 183, 194, 254, 223, 255, 255, 128,
    1, 81, 230, 252, 204, 203, 255, 192, 128, 128, 128,
    123, 102, 209, 247, 188, 196, 255, 233, 128, 128, 128,
    20, 95, 153, 243, 164, 173, 255, 203, 128, 128, 128,
    1, 222, 248, 255, 216, 213, 128, 128, 128, 128, 128,
    168, 175, 246, 252, 235, 205, 255, 255, 128, 128, 128,
    47, 116, 215, 255, 211, 212, 255, 255, 128, 128, 128,
    1, 121, 236, 253, 212, 214, 255, 255, 128, 128, 128,
    141, 84, 213, 252, 201, 202, 255, 219, 128, 128, 128,
    42, 80, 160, 240, 162, 185, 255, 205, 128, 128, 128,
    1, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    244, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
    238, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
]);

const DC_QUANT = new Uint16Array([
    4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 15, 16, 17, 17,
    18, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 25, 25, 26, 27, 28,
    29, 30, 31, 32, 33, 34, 35, 36, 37, 37, 38, 39, 40, 41, 42, 43,
    44, 45, 46, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
    59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74,
    75, 76, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    91, 93, 95, 96, 98, 100, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118,
    122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 143, 145, 148, 151, 154, 157,
]);
const AC_QUANT = new Uint16Array([
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
    52, 53, 54, 55, 56, 57, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76,
    78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108,
    110, 112, 114, 116, 119, 122, 125, 128, 131, 134, 137, 140, 143, 146, 149, 152,
    155, 158, 161, 164, 167, 170, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209,
    213, 217, 221, 225, 229, 234, 239, 245, 249, 254, 259, 264, 269, 274, 279, 284,
]);
// ---- Frame and decoder state ----

/** A decoded keyframe: Y plane at `bufferWidth` (width rounded up to 16) stride, U/V at half that. */
export interface Frame {
    width: number;
    height: number;
    ybuf: Uint8Array;
    ubuf: Uint8Array;
    vbuf: Uint8Array;
}

interface MacroBlock {
    bpred: Uint8Array; // 16 IntraMode
    complexity: Uint8Array; // 9
    lumaMode: number;
    chromaMode: number;
    segmentid: number;
    coeffsSkipped: boolean;
    nonZeroDct: boolean;
}

const newMacroBlock = (): MacroBlock => ({
    bpred: new Uint8Array(16),
    complexity: new Uint8Array(9),
    lumaMode: DC_PRED,
    chromaMode: DC_PRED,
    segmentid: 0,
    coeffsSkipped: false,
    nonZeroDct: false,
});

interface Segment {
    ydc: number;
    yac: number;
    y2dc: number;
    y2ac: number;
    uvdc: number;
    uvac: number;
    deltaValues: boolean;
    quantizerLevel: number;
    loopfilterLevel: number;
}

const dcQuant = (index: number): number => DC_QUANT[Math.max(0, Math.min(127, index))];
const acQuant = (index: number): number => AC_QUANT[Math.max(0, Math.min(127, index))];

/** Decodes the VP8 bitstream in `data[start, end)` (a VP8 chunk's payload). Throws on error. */
export function decodeVp8(data: Uint8Array, start: number, end: number): Frame {
    return new Vp8Decoder(data, start, Math.min(end, data.length)).decodeFrame();
}

class Vp8Decoder {
    data: Uint8Array;
    pos: number;
    end: number;
    b = new ArithmeticDecoder();

    mbwidth = 0;
    mbheight = 0;
    macroblocks: MacroBlock[] = [];

    width = 0;
    height = 0;
    ybuf = new Uint8Array(0);
    ubuf = new Uint8Array(0);
    vbuf = new Uint8Array(0);
    keyframe = false;
    filterType = false; // if true uses simple filter, else the normal filter
    filterLevel = 0;
    sharpnessLevel = 0;

    segmentsEnabled = false;
    segmentsUpdateMap = false;
    segment: Segment[] = Array.from({length: MAX_SEGMENTS}, () => ({
        ydc: 0, yac: 0, y2dc: 0, y2ac: 0, uvdc: 0, uvac: 0, deltaValues: false, quantizerLevel: 0, loopfilterLevel: 0,
    }));

    loopFilterAdjustmentsEnabled = false;
    refDelta = [0, 0, 0, 0];
    modeDelta = [0, 0, 0, 0];

    partitions = Array.from({length: 8}, () => new ArithmeticDecoder());
    numPartitions = 1;

    segmentTreeProbs = new Uint8Array([255, 255, 255]);
    tokenProbs = COEFF_PROBS.slice();

    probSkipFalse: number | undefined = undefined;

    top: MacroBlock[] = [];
    left: MacroBlock = newMacroBlock();

    // The borders from the previous macroblock, used for predictions. See Section 12.
    // Note that the left border contains the top left pixel.
    topBorderY = new Uint8Array(0);
    leftBorderY = new Uint8Array(0);
    topBorderU = new Uint8Array(0);
    leftBorderU = new Uint8Array(0);
    topBorderV = new Uint8Array(0);
    leftBorderV = new Uint8Array(0);

    constructor(data: Uint8Array, start: number, end: number) {
        this.data = data;
        this.pos = start;
        this.end = end;
    }

    readExact(n: number): Uint8Array {
        if (this.pos + n > this.end) fail('unexpected end of file');
        const out = this.data.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    readU24(): number {
        const b = this.readExact(3);
        return b[0] | (b[1] << 8) | (b[2] << 16);
    }

    readU16(): number {
        const b = this.readExact(2);
        return b[0] | (b[1] << 8);
    }

    updateTokenProbabilities(): void {
        for (let i = 0; i < COEFF_UPDATE_PROBS.length; i++) {
            if (this.b.readBit(COEFF_UPDATE_PROBS[i])) this.tokenProbs[i] = this.b.readLiteral(8);
        }
        this.b.check();
    }

    initPartitions(n: number): void {
        if (n > 1) {
            const sizes = this.readExact(3 * n - 3);
            for (let i = 0; i < n - 1; i++) {
                const size = sizes[3 * i] | (sizes[3 * i + 1] << 8) | (sizes[3 * i + 2] << 16);
                this.partitions[i].init(this.readExact(size));
            }
        }
        this.partitions[n - 1].init(this.data.subarray(this.pos, this.end));
        this.pos = this.end;
    }

    readQuantizationIndices(): void {
        const b = this.b;
        const yacAbs = b.readLiteral(7);
        const ydcDelta = b.readOptionalSignedValue(4);
        const y2dcDelta = b.readOptionalSignedValue(4);
        const y2acDelta = b.readOptionalSignedValue(4);
        const uvdcDelta = b.readOptionalSignedValue(4);
        const uvacDelta = b.readOptionalSignedValue(4);

        const n = this.segmentsEnabled ? MAX_SEGMENTS : 1;
        for (let i = 0; i < n; i++) {
            const s = this.segment[i];
            const base = this.segmentsEnabled
                ? s.deltaValues ? s.quantizerLevel + yacAbs : s.quantizerLevel
                : yacAbs;

            s.ydc = dcQuant(base + ydcDelta);
            s.yac = acQuant(base);
            s.y2dc = dcQuant(base + y2dcDelta) * 2;
            // The intermediate result (max`284*155`) can be larger than the `i16` range.
            s.y2ac = Math.floor((acQuant(base + y2acDelta) * 155) / 100);
            s.uvdc = dcQuant(base + uvdcDelta);
            s.uvac = acQuant(base + uvacDelta);

            if (s.y2ac < 8) s.y2ac = 8;
            if (s.uvdc > 132) s.uvdc = 132;
        }
        b.check();
    }

    readLoopFilterAdjustments(): void {
        if (this.b.readFlag()) {
            for (let i = 0; i < 4; i++) this.refDelta[i] = this.b.readOptionalSignedValue(6);
            for (let i = 0; i < 4; i++) this.modeDelta[i] = this.b.readOptionalSignedValue(6);
        }
        this.b.check();
    }

    readSegmentUpdates(): void {
        const b = this.b;
        // Section 9.3
        this.segmentsUpdateMap = b.readFlag();
        const updateSegmentFeatureData = b.readFlag();

        if (updateSegmentFeatureData) {
            const segmentFeatureMode = b.readFlag();
            for (let i = 0; i < MAX_SEGMENTS; i++) this.segment[i].deltaValues = !segmentFeatureMode;
            for (let i = 0; i < MAX_SEGMENTS; i++) this.segment[i].quantizerLevel = b.readOptionalSignedValue(7);
            for (let i = 0; i < MAX_SEGMENTS; i++) this.segment[i].loopfilterLevel = b.readOptionalSignedValue(6);
        }

        if (this.segmentsUpdateMap) {
            for (let i = 0; i < 3; i++) {
                const update = b.readFlag();
                this.segmentTreeProbs[i] = update ? b.readLiteral(8) : 255;
            }
        }
        b.check();
    }

    readFrameHeader(): void {
        const tag = this.readU24();
        this.keyframe = (tag & 1) === 0;
        const firstPartitionSize = tag >> 5;

        if (this.keyframe) {
            const magic = this.readExact(3);
            if (magic[0] !== 0x9d || magic[1] !== 0x01 || magic[2] !== 0x2a) fail('invalid VP8 magic');

            const w = this.readU16();
            const h = this.readU16();
            this.width = w & 0x3fff;
            this.height = h & 0x3fff;

            this.mbwidth = Math.ceil(this.width / 16);
            this.mbheight = Math.ceil(this.height / 16);
            this.top = Array.from({length: this.mbwidth}, newMacroBlock);
            // Almost always the first macro block, except when non exists (i.e. `width == 0`)
            this.left = newMacroBlock();

            this.ybuf = new Uint8Array(this.mbwidth * 16 * this.mbheight * 16);
            this.ubuf = new Uint8Array(this.mbwidth * 8 * this.mbheight * 8);
            this.vbuf = new Uint8Array(this.mbwidth * 8 * this.mbheight * 8);

            this.topBorderY = new Uint8Array(this.width + 4 + 16).fill(127);
            this.leftBorderY = new Uint8Array(1 + 16).fill(129);
            // 8 pixels per macroblock
            this.topBorderU = new Uint8Array(8 * this.mbwidth).fill(127);
            this.leftBorderU = new Uint8Array(1 + 8).fill(129);
            this.topBorderV = new Uint8Array(8 * this.mbwidth).fill(127);
            this.leftBorderV = new Uint8Array(1 + 8).fill(129);
        }

        // initialise binary decoder
        this.b.init(this.readExact(firstPartitionSize));
        const b = this.b;

        if (this.keyframe) {
            const colorSpace = b.readLiteral(1);
            b.readLiteral(1); // pixel type
            if (colorSpace !== 0) fail('invalid VP8 color space');
        }

        this.segmentsEnabled = b.readFlag();
        if (this.segmentsEnabled) this.readSegmentUpdates();

        this.filterType = b.readFlag();
        this.filterLevel = b.readLiteral(6);
        this.sharpnessLevel = b.readLiteral(3);

        this.loopFilterAdjustmentsEnabled = b.readFlag();
        if (this.loopFilterAdjustmentsEnabled) this.readLoopFilterAdjustments();

        const numPartitions = 1 << b.readLiteral(2);
        b.check();

        this.numPartitions = numPartitions;
        this.initPartitions(numPartitions);

        this.readQuantizationIndices();

        if (!this.keyframe) fail('non-keyframe frames are not supported');

        // Refresh entropy probs ?????
        b.readLiteral(1);

        this.updateTokenProbabilities();

        const mbNoSkipCoeff = b.readLiteral(1);
        this.probSkipFalse = mbNoSkipCoeff === 1 ? b.readLiteral(8) : undefined;
        b.check();
    }

    readMacroblockHeader(mbx: number): MacroBlock {
        const b = this.b;
        const mb = newMacroBlock();

        if (this.segmentsEnabled && this.segmentsUpdateMap) {
            mb.segmentid = b.readTree(SEGMENT_ID_LR, this.segmentTreeProbs, 0, 0);
        }

        mb.coeffsSkipped = this.probSkipFalse !== undefined ? b.readBit(this.probSkipFalse) : false;

        // intra prediction (keyframes only)
        mb.lumaMode = b.readTree(KEYFRAME_YMODE_LR, KEYFRAME_YMODE_PROBS, 0, 0);
        const top = this.top[mbx];
        if (mb.lumaMode === B_PRED) {
            // This is predicted individually
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const t = top.bpred[12 + x];
                    const l = this.left.bpred[y];
                    const bmode = b.readTree(KEYFRAME_BPRED_MODE_LR, KEYFRAME_BPRED_MODE_PROBS, (t * 10 + l) * 9, 0);
                    mb.bpred[x + y * 4] = bmode;
                    top.bpred[12 + x] = bmode;
                    this.left.bpred[y] = bmode;
                }
            }
        } else {
            const mode = LUMA_INTRA[mb.lumaMode];
            for (let i = 0; i < 4; i++) {
                mb.bpred[12 + i] = mode;
                this.left.bpred[i] = mode;
            }
        }

        mb.chromaMode = b.readTree(KEYFRAME_UV_MODE_LR, KEYFRAME_UV_MODE_PROBS, 0, 0);

        top.chromaMode = mb.chromaMode;
        top.lumaMode = mb.lumaMode;
        top.bpred.set(mb.bpred);

        b.check();
        return mb;
    }

    intraPredictLuma(mbx: number, mby: number, mb: MacroBlock, resdata: Int32Array): void {
        const stride = 1 + 16 + 4;
        const mw = this.mbwidth;
        const ws = createBorderLuma(mbx, mby, mw, this.topBorderY, this.leftBorderY);

        switch (mb.lumaMode) {
            case V_PRED: predictVpred(ws, 16, 1, 1, stride); break;
            case H_PRED: predictHpred(ws, 16, 1, 1, stride); break;
            case TM_PRED: predictTmpred(ws, 16, 1, 1, stride); break;
            case DC_PRED: predictDcpred(ws, 16, stride, mby !== 0, mbx !== 0); break;
            case B_PRED: predict4x4(ws, stride, mb.bpred, resdata); break;
        }

        if (mb.lumaMode !== B_PRED) {
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    addResidue(ws, resdata, (x + y * 4) * 16, 1 + y * 4, 1 + x * 4, stride);
                }
            }
        }

        this.leftBorderY[0] = ws[16];
        for (let i = 0; i < 16; i++) this.leftBorderY[1 + i] = ws[(i + 1) * stride + 16];
        for (let i = 0; i < 16; i++) this.topBorderY[mbx * 16 + i] = ws[16 * stride + 1 + i];

        for (let y = 0; y < 16; y++) {
            const o = (mby * 16 + y) * mw * 16 + mbx * 16;
            for (let i = 0; i < 16; i++) this.ybuf[o + i] = ws[(1 + y) * stride + 1 + i];
        }
    }

    intraPredictChroma(mbx: number, mby: number, mb: MacroBlock, resdata: Int32Array): void {
        const stride = 1 + 8;
        const mw = this.mbwidth;

        // 8x8 with left top border of 1
        const uws = createBorderChroma(mbx, mby, this.topBorderU, this.leftBorderU);
        const vws = createBorderChroma(mbx, mby, this.topBorderV, this.leftBorderV);

        for (const ws of [uws, vws]) {
            switch (mb.chromaMode) {
                case DC_PRED: predictDcpred(ws, 8, stride, mby !== 0, mbx !== 0); break;
                case V_PRED: predictVpred(ws, 8, 1, 1, stride); break;
                case H_PRED: predictHpred(ws, 8, 1, 1, stride); break;
                case TM_PRED: predictTmpred(ws, 8, 1, 1, stride); break;
            }
        }

        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                const i = x + y * 2;
                const y0 = 1 + y * 4;
                const x0 = 1 + x * 4;
                addResidue(uws, resdata, 16 * 16 + i * 16, y0, x0, stride);
                addResidue(vws, resdata, 20 * 16 + i * 16, y0, x0, stride);
            }
        }

        setChromaBorder(this.leftBorderU, this.topBorderU, uws, mbx);
        setChromaBorder(this.leftBorderV, this.topBorderV, vws, mbx);

        for (let y = 0; y < 8; y++) {
            const o = (mby * 8 + y) * mw * 8 + mbx * 8;
            const w = (1 + y) * stride + 1;
            for (let i = 0; i < 8; i++) {
                this.ubuf[o + i] = uws[w + i];
                this.vbuf[o + i] = vws[w + i];
            }
        }
    }

    /** Reads one 4x4 block's tokens into `blocks[off..off + 16]`; whether any coefficient was coded. */
    readCoefficients(blocks: Int32Array, off: number, p: number, plane: number, complexity: number, dcq: number, acq: number): boolean {
        const first = plane === 0 ? 1 : 0;
        const probs = this.tokenProbs;
        const decoder = this.partitions[p];

        let hasCoefficients = false;
        let skip = false;

        for (let i = first; i < 16; i++) {
            const probOff = ((plane * 8 + COEFF_BANDS[i]) * 3 + complexity) * 11;
            const token = decoder.readTree(DCT_TOKEN_LR, probs, probOff, skip ? 1 : 0);

            let absValue: number;
            if (token === DCT_EOB) break;
            if (token === DCT_0) {
                skip = true;
                hasCoefficients = true;
                complexity = 0;
                continue;
            }
            if (token <= DCT_4) {
                absValue = token;
            } else {
                const cat = token - DCT_CAT1;
                let extra = 0;
                for (const t of PROB_DCT_CAT[cat]) extra = extra + extra + (decoder.readBit(t) ? 1 : 0);
                absValue = DCT_CAT_BASE[cat] + extra;
            }

            skip = false;
            complexity = absValue === 0 ? 0 : absValue === 1 ? 1 : 2;

            if (decoder.readFlag()) absValue = -absValue;

            const zigzag = ZIGZAG[i];
            blocks[off + zigzag] = absValue * (zigzag > 0 ? acq : dcq);

            hasCoefficients = true;
        }

        decoder.check();
        return hasCoefficients;
    }

    readResidualData(mb: MacroBlock, mbx: number, p: number): Int32Array {
        const seg = this.segment[mb.segmentid];
        const top = this.top[mbx];
        const left = this.left;
        const blocks = new Int32Array(384);
        let plane = mb.lumaMode === B_PRED ? 3 : 1;

        if (plane === 1) {
            const complexity = top.complexity[0] + left.complexity[0];
            const block = new Int32Array(16);
            const n = this.readCoefficients(block, 0, p, plane, complexity, seg.y2dc, seg.y2ac);

            left.complexity[0] = n ? 1 : 0;
            top.complexity[0] = n ? 1 : 0;

            iwht4x4(block);
            for (let k = 0; k < 16; k++) blocks[16 * k] = block[k];

            plane = 0;
        }

        for (let y = 0; y < 4; y++) {
            let l = left.complexity[y + 1];
            for (let x = 0; x < 4; x++) {
                const off = (x + y * 4) * 16;
                const complexity = top.complexity[x + 1] + l;
                const n = this.readCoefficients(blocks, off, p, plane, complexity, seg.ydc, seg.yac);

                if (blocks[off] !== 0 || n) {
                    mb.nonZeroDct = true;
                    idct4x4(blocks, off);
                }

                l = n ? 1 : 0;
                top.complexity[x + 1] = n ? 1 : 0;
            }
            left.complexity[y + 1] = l;
        }

        plane = 2;

        for (const j of [5, 7]) {
            for (let y = 0; y < 2; y++) {
                let l = left.complexity[y + j];
                for (let x = 0; x < 2; x++) {
                    const off = (x + y * 2 + (j === 5 ? 16 : 20)) * 16;
                    const complexity = top.complexity[x + j] + l;
                    const n = this.readCoefficients(blocks, off, p, plane, complexity, seg.uvdc, seg.uvac);
                    if (blocks[off] !== 0 || n) {
                        mb.nonZeroDct = true;
                        idct4x4(blocks, off);
                    }
                    l = n ? 1 : 0;
                    top.complexity[x + j] = n ? 1 : 0;
                }
                left.complexity[y + j] = l;
            }
        }

        return blocks;
    }

    /** Does loop filtering on the macroblock */
    loopFilter(mbx: number, mby: number, mb: MacroBlock): void {
        const lumaW = this.mbwidth * 16;
        const chromaW = this.mbwidth * 8;
        const [filterLevel, interiorLimit, hevThreshold] = this.calculateFilterParameters(mb);
        if (filterLevel === 0) return;

        const mbedgeLimit = (filterLevel + 2) * 2 + interiorLimit;
        const subBedgeLimit = filterLevel * 2 + interiorLimit;
        const {ybuf, ubuf, vbuf} = this;

        // we skip subblock filtering if the coding mode isn't B_PRED and there's no DCT coefficient coded
        const doSubblockFiltering = mb.lumaMode === B_PRED || (!mb.coeffsSkipped && mb.nonZeroDct);

        // The "horizontal" filters of the crate (on an 8-pixel row slice) are the vertical ones with stride 1.

        // filter across left of macroblock
        if (mbx > 0) {
            if (this.filterType) {
                for (let y = 0; y < 16; y++) {
                    simpleSegment(mbedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16, 1);
                }
            } else {
                for (let y = 0; y < 16; y++) {
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16, 1);
                }
                for (let y = 0; y < 8; y++) {
                    const o = (mby * 8 + y) * chromaW + mbx * 8;
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, ubuf, o, 1);
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, vbuf, o, 1);
                }
            }
        }

        // filter across vertical subblocks in macroblock
        if (doSubblockFiltering) {
            if (this.filterType) {
                for (let x = 4; x < 16; x += 4) {
                    for (let y = 0; y < 16; y++) {
                        simpleSegment(subBedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16 + x, 1);
                    }
                }
            } else {
                for (let x = 4; x < 16; x += 4) {
                    for (let y = 0; y < 16; y++) {
                        subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16 + x, 1);
                    }
                }
                for (let y = 0; y < 8; y++) {
                    const o = (mby * 8 + y) * chromaW + mbx * 8 + 4;
                    subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, ubuf, o, 1);
                    subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, vbuf, o, 1);
                }
            }
        }

        // filter across top of macroblock
        if (mby > 0) {
            if (this.filterType) {
                for (let x = 0; x < 16; x++) {
                    simpleSegment(mbedgeLimit, ybuf, mby * 16 * lumaW + mbx * 16 + x, lumaW);
                }
            } else {
                for (let x = 0; x < 16; x++) {
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, ybuf, mby * 16 * lumaW + mbx * 16 + x, lumaW);
                }
                for (let x = 0; x < 8; x++) {
                    const o = mby * 8 * chromaW + mbx * 8 + x;
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, ubuf, o, chromaW);
                    macroblockFilter(hevThreshold, interiorLimit, mbedgeLimit, vbuf, o, chromaW);
                }
            }
        }

        // filter across horizontal subblock edges within the macroblock
        if (doSubblockFiltering) {
            if (this.filterType) {
                for (let y = 4; y < 16; y += 4) {
                    for (let x = 0; x < 16; x++) {
                        simpleSegment(subBedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16 + x, lumaW);
                    }
                }
            } else {
                for (let y = 4; y < 16; y += 4) {
                    for (let x = 0; x < 16; x++) {
                        subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, ybuf, (mby * 16 + y) * lumaW + mbx * 16 + x, lumaW);
                    }
                }
                for (let x = 0; x < 8; x++) {
                    const o = (mby * 8 + 4) * chromaW + mbx * 8 + x;
                    subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, ubuf, o, chromaW);
                    subblockFilter(hevThreshold, interiorLimit, subBedgeLimit, vbuf, o, chromaW);
                }
            }
        }
    }

    /** The filter level, interior limit and hev threshold. */
    calculateFilterParameters(mb: MacroBlock): [number, number, number] {
        const segment = this.segment[mb.segmentid];
        let filterLevel = this.filterLevel;

        // if frame level filter level is 0, we must skip loop filter
        if (filterLevel === 0) return [0, 0, 0];

        if (this.segmentsEnabled) {
            if (segment.deltaValues) filterLevel += segment.loopfilterLevel;
            else filterLevel = segment.loopfilterLevel;
        }

        filterLevel = Math.max(0, Math.min(63, filterLevel));

        if (this.loopFilterAdjustmentsEnabled) {
            filterLevel += this.refDelta[0];
            if (mb.lumaMode === B_PRED) filterLevel += this.modeDelta[0];
        }

        filterLevel = Math.max(0, Math.min(63, filterLevel));

        let interiorLimit = filterLevel;
        if (this.sharpnessLevel > 0) {
            interiorLimit >>= this.sharpnessLevel > 4 ? 2 : 1;
            if (interiorLimit > 9 - this.sharpnessLevel) interiorLimit = 9 - this.sharpnessLevel;
        }
        if (interiorLimit === 0) interiorLimit = 1;

        // high edge variance threshold (keyframe values)
        let hevThreshold = 0;
        if (filterLevel >= 40) hevThreshold = 2;
        else if (filterLevel >= 15) hevThreshold = 1;

        return [filterLevel, interiorLimit, hevThreshold];
    }

    decodeFrame(): Frame {
        this.readFrameHeader();

        for (let mby = 0; mby < this.mbheight; mby++) {
            const p = mby % this.numPartitions;
            this.left = newMacroBlock();

            for (let mbx = 0; mbx < this.mbwidth; mbx++) {
                const mb = this.readMacroblockHeader(mbx);
                let blocks: Int32Array;
                if (!mb.coeffsSkipped) {
                    blocks = this.readResidualData(mb, mbx, p);
                } else {
                    if (mb.lumaMode !== B_PRED) {
                        this.left.complexity[0] = 0;
                        this.top[mbx].complexity[0] = 0;
                    }
                    for (let i = 1; i < 9; i++) {
                        this.left.complexity[i] = 0;
                        this.top[mbx].complexity[i] = 0;
                    }
                    blocks = new Int32Array(384);
                }

                this.intraPredictLuma(mbx, mby, mb, blocks);
                this.intraPredictChroma(mbx, mby, mb, blocks);

                this.macroblocks.push(mb);
            }

            this.leftBorderY = new Uint8Array(1 + 16).fill(129);
            this.leftBorderU = new Uint8Array(1 + 8).fill(129);
            this.leftBorderV = new Uint8Array(1 + 8).fill(129);
        }

        // do loop filtering
        for (let mby = 0; mby < this.mbheight; mby++) {
            for (let mbx = 0; mbx < this.mbwidth; mbx++) {
                this.loopFilter(mbx, mby, this.macroblocks[mby * this.mbwidth + mbx]);
            }
        }

        return {width: this.width, height: this.height, ybuf: this.ybuf, ubuf: this.ubuf, vbuf: this.vbuf};
    }
}

/** `LumaMode::into_intra` for the non-B modes: DC → B_DC, V → B_VE, H → B_HE, TM → B_TM. */
const LUMA_INTRA = [B_DC_PRED, B_VE_PRED, B_HE_PRED, B_TM_PRED];

// ---- Intra prediction ----

function createBorderLuma(mbx: number, mby: number, mbw: number, top: Uint8Array, left: Uint8Array): Uint8Array {
    const stride = 1 + 16 + 4;
    const ws = new Uint8Array((1 + 16) * stride);

    // A
    if (mby === 0) {
        ws.fill(127, 1, stride);
    } else {
        for (let i = 0; i < 16; i++) ws[1 + i] = top[mbx * 16 + i];
        if (mbx === mbw - 1) {
            ws.fill(top[mbx * 16 + 15], 17, stride);
        } else {
            for (let i = 0; i < 4; i++) ws[17 + i] = top[mbx * 16 + 16 + i];
        }
    }

    for (let i = 17; i < stride; i++) {
        ws[4 * stride + i] = ws[i];
        ws[8 * stride + i] = ws[i];
        ws[12 * stride + i] = ws[i];
    }

    // L
    for (let i = 0; i < 16; i++) ws[(i + 1) * stride] = mbx === 0 ? 129 : left[1 + i];

    // P
    ws[0] = mby === 0 ? 127 : mbx === 0 ? 129 : left[0];

    return ws;
}

// creates the left and top border for chroma prediction
function createBorderChroma(mbx: number, mby: number, top: Uint8Array, left: Uint8Array): Uint8Array {
    const stride = 1 + 8;
    const block = new Uint8Array(stride * stride);

    // above
    for (let i = 0; i < 8; i++) block[1 + i] = mby === 0 ? 127 : top[mbx * 8 + i];
    // left
    for (let y = 0; y < 8; y++) block[(y + 1) * stride] = mbx === 0 ? 129 : left[1 + y];

    block[0] = mby === 0 ? 127 : mbx === 0 ? 129 : left[0];
    return block;
}

function setChromaBorder(leftBorder: Uint8Array, topBorder: Uint8Array, block: Uint8Array, mbx: number): void {
    const stride = 1 + 8;
    // top left is top right of previous chroma block
    leftBorder[0] = block[8];
    for (let i = 0; i < 8; i++) leftBorder[1 + i] = block[(i + 1) * stride + 8];
    for (let i = 0; i < 8; i++) topBorder[mbx * 8 + i] = block[8 * stride + 1 + i];
}

const avg3 = (left: number, cur: number, right: number): number => (left + 2 * cur + right + 2) >> 2;
const avg2 = (cur: number, right: number): number => (cur + right + 1) >> 1;
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function addResidue(p: Uint8Array, r: Int32Array, roff: number, y0: number, x0: number, stride: number): void {
    let pos = y0 * stride + x0;
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) p[pos + x] = clamp255(r[roff + y * 4 + x] + p[pos + x]);
        pos += stride;
    }
}

function predict4x4(ws: Uint8Array, stride: number, modes: Uint8Array, resdata: Int32Array): void {
    for (let sby = 0; sby < 4; sby++) {
        for (let sbx = 0; sbx < 4; sbx++) {
            const i = sbx + sby * 4;
            const y0 = sby * 4 + 1;
            const x0 = sbx * 4 + 1;
            switch (modes[i]) {
                case B_TM_PRED: predictTmpred(ws, 4, x0, y0, stride); break;
                case B_VE_PRED: predictBvepred(ws, x0, y0, stride); break;
                case B_HE_PRED: predictBhepred(ws, x0, y0, stride); break;
                case B_DC_PRED: predictBdcpred(ws, x0, y0, stride); break;
                case B_LD_PRED: predictBldpred(ws, x0, y0, stride); break;
                case B_RD_PRED: predictBrdpred(ws, x0, y0, stride); break;
                case B_VR_PRED: predictBvrpred(ws, x0, y0, stride); break;
                case B_VL_PRED: predictBvlpred(ws, x0, y0, stride); break;
                case B_HD_PRED: predictBhdpred(ws, x0, y0, stride); break;
                case B_HU_PRED: predictBhupred(ws, x0, y0, stride); break;
            }
            addResidue(ws, resdata, i * 16, y0, x0, stride);
        }
    }
}

/** Copies the top row to the rows below it (from column 1 to the end of the row, as the crate does). */
function predictVpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number): void {
    const n = Math.min(stride - 1, stride * y0 - x0);
    for (let r = 0; r < size; r++) {
        const o = (y0 + r) * stride + 1;
        for (let k = 0; k < n; k++) a[o + k] = a[x0 + k];
    }
}

/** Copies the first value of a row to the values right of it (to the end of the row). */
function predictHpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number): void {
    for (let r = y0; r < y0 + size; r++) a.fill(a[r * stride + x0 - 1], r * stride + x0, (r + 1) * stride);
}

function predictDcpred(a: Uint8Array, size: number, stride: number, above: boolean, left: boolean): void {
    let sum = 0;
    let shf = size === 8 ? 2 : 3;
    if (left) {
        for (let y = 0; y < size; y++) sum += a[(y + 1) * stride];
        shf += 1;
    }
    if (above) {
        for (let i = 1; i <= size; i++) sum += a[i];
        shf += 1;
    }
    const dcval = !left && !above ? 128 : (sum + (1 << (shf - 1))) >> shf;
    for (let y = 0; y < size; y++) a.fill(dcval, 1 + stride * (y + 1), 1 + stride * (y + 1) + size);
}

/** X_ij = L_i + A_j - P (RFC 6386 p. 52). */
function predictTmpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number): void {
    const p = a[(y0 - 1) * stride + x0 - 1];
    const above = (y0 - 1) * stride + x0;
    for (let y = 0; y < size; y++) {
        const row = (y0 + y) * stride + x0;
        const leftMinusP = a[row - 1] - p;
        for (let k = 0; k < size; k++) a[row + k] = clamp255(leftMinusP + a[above + k]);
    }
}

function predictBdcpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    let v = 4;
    for (let i = 0; i < 4; i++) v += a[(y0 - 1) * stride + x0 + i];
    for (let i = 0; i < 4; i++) v += a[(y0 + i) * stride + x0 - 1];
    v >>= 3;
    for (let r = 0; r < 4; r++) a.fill(v, (y0 + r) * stride + x0, (y0 + r) * stride + x0 + 4);
}

function predictBvepred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const t = (y0 - 1) * stride + x0;
    const p = a[t - 1];
    const avg = [avg3(p, a[t], a[t + 1]), avg3(a[t], a[t + 1], a[t + 2]), avg3(a[t + 1], a[t + 2], a[t + 3]), avg3(a[t + 2], a[t + 3], a[t + 4])];
    for (let r = 0; r < 4; r++) a.set(avg, (y0 + r) * stride + x0);
}

function predictBhepred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const p = a[(y0 - 1) * stride + x0 - 1];
    const [l0, l1, l2, l3] = leftPixels(a, x0, y0, stride);
    const avgs = [avg3(p, l0, l1), avg3(l0, l1, l2), avg3(l1, l2, l3), avg3(l2, l3, l3)];
    for (let r = 0; r < 4; r++) a.fill(avgs[r], (y0 + r) * stride + x0, (y0 + r) * stride + x0 + 4);
}

const topPixels = (a: Uint8Array, x0: number, y0: number, stride: number): Uint8Array =>
    a.subarray((y0 - 1) * stride + x0, (y0 - 1) * stride + x0 + 8);

const leftPixels = (a: Uint8Array, x0: number, y0: number, stride: number): number[] => [
    a[y0 * stride + x0 - 1],
    a[(y0 + 1) * stride + x0 - 1],
    a[(y0 + 2) * stride + x0 - 1],
    a[(y0 + 3) * stride + x0 - 1],
];

function edgePixels(a: Uint8Array, x0: number, y0: number, stride: number): number[] {
    const pos = (y0 - 1) * stride + x0 - 1;
    return [a[pos + 4 * stride], a[pos + 3 * stride], a[pos + 2 * stride], a[pos + stride], a[pos], a[pos + 1], a[pos + 2], a[pos + 3], a[pos + 4]];
}

function predictBldpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [a0, a1, a2, a3, a4, a5, a6, a7] = topPixels(a, x0, y0, stride);
    const avgs = [avg3(a0, a1, a2), avg3(a1, a2, a3), avg3(a2, a3, a4), avg3(a3, a4, a5), avg3(a4, a5, a6), avg3(a5, a6, a7), avg3(a6, a7, a7)];
    for (let i = 0; i < 4; i++) a.set(avgs.slice(i, i + 4), (y0 + i) * stride + x0);
}

function predictBrdpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [e0, e1, e2, e3, e4, e5, e6, e7, e8] = edgePixels(a, x0, y0, stride);
    const avgs = [avg3(e0, e1, e2), avg3(e1, e2, e3), avg3(e2, e3, e4), avg3(e3, e4, e5), avg3(e4, e5, e6), avg3(e5, e6, e7), avg3(e6, e7, e8)];
    for (let i = 0; i < 4; i++) a.set(avgs.slice(3 - i, 7 - i), (y0 + i) * stride + x0);
}

function predictBvrpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [, e1, e2, e3, e4, e5, e6, e7, e8] = edgePixels(a, x0, y0, stride);
    const at = (r: number, c: number): number => (y0 + r) * stride + x0 + c;
    a[at(3, 0)] = avg3(e1, e2, e3);
    a[at(2, 0)] = avg3(e2, e3, e4);
    a[at(3, 1)] = avg3(e3, e4, e5);
    a[at(1, 0)] = avg3(e3, e4, e5);
    a[at(2, 1)] = avg2(e4, e5);
    a[at(0, 0)] = avg2(e4, e5);
    a[at(3, 2)] = avg3(e4, e5, e6);
    a[at(1, 1)] = avg3(e4, e5, e6);
    a[at(2, 2)] = avg2(e5, e6);
    a[at(0, 1)] = avg2(e5, e6);
    a[at(3, 3)] = avg3(e5, e6, e7);
    a[at(1, 2)] = avg3(e5, e6, e7);
    a[at(2, 3)] = avg2(e6, e7);
    a[at(0, 2)] = avg2(e6, e7);
    a[at(1, 3)] = avg3(e6, e7, e8);
    a[at(0, 3)] = avg2(e7, e8);
}

function predictBvlpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [a0, a1, a2, a3, a4, a5, a6, a7] = topPixels(a, x0, y0, stride);
    const at = (r: number, c: number): number => (y0 + r) * stride + x0 + c;
    a[at(0, 0)] = avg2(a0, a1);
    a[at(1, 0)] = avg3(a0, a1, a2);
    a[at(2, 0)] = avg2(a1, a2);
    a[at(0, 1)] = avg2(a1, a2);
    a[at(1, 1)] = avg3(a1, a2, a3);
    a[at(3, 0)] = avg3(a1, a2, a3);
    a[at(2, 1)] = avg2(a2, a3);
    a[at(0, 2)] = avg2(a2, a3);
    a[at(3, 1)] = avg3(a2, a3, a4);
    a[at(1, 2)] = avg3(a2, a3, a4);
    a[at(2, 2)] = avg2(a3, a4);
    a[at(0, 3)] = avg2(a3, a4);
    a[at(3, 2)] = avg3(a3, a4, a5);
    a[at(1, 3)] = avg3(a3, a4, a5);
    a[at(2, 3)] = avg3(a4, a5, a6);
    a[at(3, 3)] = avg3(a5, a6, a7);
}

function predictBhdpred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [e0, e1, e2, e3, e4, e5, e6, e7] = edgePixels(a, x0, y0, stride);
    const at = (r: number, c: number): number => (y0 + r) * stride + x0 + c;
    a[at(3, 0)] = avg2(e0, e1);
    a[at(3, 1)] = avg3(e0, e1, e2);
    a[at(2, 0)] = avg2(e1, e2);
    a[at(3, 2)] = avg2(e1, e2);
    a[at(2, 1)] = avg3(e1, e2, e3);
    a[at(3, 3)] = avg3(e1, e2, e3);
    a[at(2, 2)] = avg2(e2, e3);
    a[at(1, 0)] = avg2(e2, e3);
    a[at(2, 3)] = avg3(e2, e3, e4);
    a[at(1, 1)] = avg3(e2, e3, e4);
    a[at(1, 2)] = avg2(e3, e4);
    a[at(0, 0)] = avg2(e3, e4);
    a[at(1, 3)] = avg3(e3, e4, e5);
    a[at(0, 1)] = avg3(e3, e4, e5);
    a[at(0, 2)] = avg3(e4, e5, e6);
    a[at(0, 3)] = avg3(e5, e6, e7);
}

function predictBhupred(a: Uint8Array, x0: number, y0: number, stride: number): void {
    const [l0, l1, l2, l3] = leftPixels(a, x0, y0, stride);
    const at = (r: number, c: number): number => (y0 + r) * stride + x0 + c;
    a[at(0, 0)] = avg2(l0, l1);
    a[at(0, 1)] = avg3(l0, l1, l2);
    a[at(0, 2)] = avg2(l1, l2);
    a[at(1, 0)] = avg2(l1, l2);
    a[at(0, 3)] = avg3(l1, l2, l3);
    a[at(1, 1)] = avg3(l1, l2, l3);
    a[at(1, 2)] = avg2(l2, l3);
    a[at(2, 0)] = avg2(l2, l3);
    a[at(1, 3)] = avg3(l2, l3, l3);
    a[at(2, 1)] = avg3(l2, l3, l3);
    a[at(2, 2)] = l3;
    a[at(2, 3)] = l3;
    a[at(3, 0)] = l3;
    a[at(3, 1)] = l3;
    a[at(3, 2)] = l3;
    a[at(3, 3)] = l3;
}

// ---- Inverse transforms (transform.rs) ----

const CONST1 = 20091;
const CONST2 = 35468;

/** `(x * c) >> 16` in i64 (the products overflow i32; doubles hold them exactly). */
const mulShr16 = (x: number, c: number): number => Math.floor((x * c) / 65536);

function idct4x4(block: Int32Array, o: number): void {
    for (let i = 0; i < 4; i++) {
        const b0 = block[o + i], b4 = block[o + 4 + i], b8 = block[o + 8 + i], b12 = block[o + 12 + i];
        const a1 = b0 + b8;
        const b1 = b0 - b8;
        const c1 = mulShr16(b4, CONST2) - (b12 + mulShr16(b12, CONST1));
        const d1 = b4 + mulShr16(b4, CONST1) + mulShr16(b12, CONST2);
        block[o + i] = a1 + d1;
        block[o + 4 + i] = b1 + c1;
        block[o + 12 + i] = a1 - d1;
        block[o + 8 + i] = b1 - c1;
    }
    for (let i = 0; i < 4; i++) {
        const r = o + 4 * i;
        const b0 = block[r], b1v = block[r + 1], b2 = block[r + 2], b3 = block[r + 3];
        const a1 = b0 + b2;
        const b1 = b0 - b2;
        const c1 = mulShr16(b1v, CONST2) - (b3 + mulShr16(b3, CONST1));
        const d1 = b1v + mulShr16(b1v, CONST1) + mulShr16(b3, CONST2);
        block[r] = Math.floor((a1 + d1 + 4) / 8);
        block[r + 3] = Math.floor((a1 - d1 + 4) / 8);
        block[r + 1] = Math.floor((b1 + c1 + 4) / 8);
        block[r + 2] = Math.floor((b1 - c1 + 4) / 8);
    }
}

// 14.3
function iwht4x4(block: Int32Array): void {
    for (let i = 0; i < 4; i++) {
        const a1 = block[i] + block[12 + i];
        const b1 = block[4 + i] + block[8 + i];
        const c1 = block[4 + i] - block[8 + i];
        const d1 = block[i] - block[12 + i];
        block[i] = a1 + b1;
        block[4 + i] = c1 + d1;
        block[8 + i] = a1 - b1;
        block[12 + i] = d1 - c1;
    }
    for (let r = 0; r < 16; r += 4) {
        const a1 = block[r] + block[r + 3];
        const b1 = block[r + 1] + block[r + 2];
        const c1 = block[r + 1] - block[r + 2];
        const d1 = block[r] - block[r + 3];
        block[r] = (a1 + b1 + 3) >> 3;
        block[r + 1] = (c1 + d1 + 3) >> 3;
        block[r + 2] = (a1 - b1 + 3) >> 3;
        block[r + 3] = (d1 - c1 + 3) >> 3;
    }
}

// ---- Loop filter (loop_filter.rs; sections 15.2 and 15.3). `point` is the first pixel after the edge. ----

const c = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);
const u2s = (v: number): number => v - 128;
const s2u = (v: number): number => c(v) + 128;
const diff = (a: number, b: number): number => (a > b ? a - b : b - a);

/** Adjusts the 2 middle pixels; used in both the simple and normal filters. */
function commonAdjust(useOuterTaps: boolean, px: Uint8Array, point: number, stride: number): number {
    const p1 = u2s(px[point - 2 * stride]);
    const p0 = u2s(px[point - stride]);
    const q0 = u2s(px[point]);
    const q1 = u2s(px[point + stride]);

    // value for the outer 2 pixels
    const outer = useOuterTaps ? c(p1 - q1) : 0;
    let a = c(outer + 3 * (q0 - p0));
    const b = c(a + 3) >> 3;
    a = c(a + 4) >> 3;

    px[point] = s2u(q0 - a);
    px[point - stride] = s2u(p0 + b);
    return a;
}

const simpleThreshold = (limit: number, px: Uint8Array, point: number, stride: number): boolean =>
    diff(px[point - stride], px[point]) * 2 + (diff(px[point - 2 * stride], px[point + stride]) >> 1) <= limit;

const shouldFilter = (interior: number, edge: number, px: Uint8Array, point: number, s: number): boolean =>
    simpleThreshold(edge, px, point, s) &&
    // there are actually only 6 diff comparisons required as per the spec (RFC 6386 section 20.6)
    diff(px[point - 4 * s], px[point - 3 * s]) <= interior &&
    diff(px[point - 3 * s], px[point - 2 * s]) <= interior &&
    diff(px[point - 2 * s], px[point - s]) <= interior &&
    diff(px[point + 3 * s], px[point + 2 * s]) <= interior &&
    diff(px[point + 2 * s], px[point + s]) <= interior &&
    diff(px[point + s], px[point]) <= interior;

const highEdgeVariance = (threshold: number, px: Uint8Array, point: number, s: number): boolean =>
    diff(px[point - 2 * s], px[point - s]) > threshold || diff(px[point + s], px[point]) > threshold;

/** Simple filter (15.2): affects 4 pixels on an edge (2 each side). */
function simpleSegment(edgeLimit: number, px: Uint8Array, point: number, stride: number): void {
    if (simpleThreshold(edgeLimit, px, point, stride)) commonAdjust(true, px, point, stride);
}

/** Normal filter (15.3) on the edges between subblocks inside a macroblock. */
function subblockFilter(hevThreshold: number, interiorLimit: number, edgeLimit: number, px: Uint8Array, point: number, s: number): void {
    if (shouldFilter(interiorLimit, edgeLimit, px, point, s)) {
        const hv = highEdgeVariance(hevThreshold, px, point, s);
        const a = (commonAdjust(hv, px, point, s) + 1) >> 1;
        if (!hv) {
            px[point + s] = s2u(u2s(px[point + s]) - a);
            px[point - 2 * s] = s2u(u2s(px[point - 2 * s]) + a);
        }
    }
}

/** Normal filter (15.3) on the edges between macroblocks. */
function macroblockFilter(hevThreshold: number, interiorLimit: number, edgeLimit: number, px: Uint8Array, point: number, s: number): void {
    if (!shouldFilter(interiorLimit, edgeLimit, px, point, s)) return;
    if (!highEdgeVariance(hevThreshold, px, point, s)) {
        const p2 = u2s(px[point - 3 * s]);
        const p1 = u2s(px[point - 2 * s]);
        const p0 = u2s(px[point - s]);
        const q0 = u2s(px[point]);
        const q1 = u2s(px[point + s]);
        const q2 = u2s(px[point + 2 * s]);

        const w = c(c(p1 - q1) + 3 * (q0 - p0));

        let a = c((27 * w + 63) >> 7);
        px[point] = s2u(q0 - a);
        px[point - s] = s2u(p0 + a);

        a = c((18 * w + 63) >> 7);
        px[point + s] = s2u(q1 - a);
        px[point - 2 * s] = s2u(p1 + a);

        a = c((9 * w + 63) >> 7);
        px[point + 2 * s] = s2u(q2 - a);
        px[point - 3 * s] = s2u(p2 + a);
    } else {
        commonAdjust(true, px, point, s);
    }
}

// ---- YUV -> RGB (yuv.rs), libwebp's src/dsp/yuv.h ----

/** `_mm_mulhi_epu16` emulation */
const mulhi = (v: number, coeff: number): number => (v * coeff) >> 8;
const clip = (v: number): number => clamp255(v >> 6);

function setPixel(buf: Uint8Array, o: number, y: number, u: number, v: number): void {
    const yy = mulhi(y, 19077);
    buf[o] = clip(yy + mulhi(v, 26149) - 14234);
    buf[o + 1] = clip(yy - mulhi(u, 6419) - mulhi(v, 13320) + 8708);
    buf[o + 2] = clip(yy + mulhi(u, 33050) - 17685);
}

const fancy = (main: number, secondary1: number, secondary2: number, tertiary: number): number =>
    (9 * main + 3 * secondary1 + 3 * secondary2 + tertiary + 8) >> 4;

/**
 * Fills `buf` (`bpp` 3 or 4 bytes per pixel; the 4th byte is left untouched) with the frame upsampled
 * with libwebp's "fancy" bilinear chroma interpolation: each chroma sample weighs 9/3/3/1 by distance,
 * and the top row (and the bottom one for even heights) only uses its nearest chroma row.
 */
export function fillRgbFancy(frame: Frame, buf: Uint8Array, bpp: number): void {
    const {width, height, ybuf, ubuf, vbuf} = frame;
    const bufferWidth = Math.ceil(width / 16) * 16;
    const cbw = bufferWidth / 2;
    const rowBytes = width * bpp;

    // fill top row first since it only uses the top u/v row
    fillRow1(buf, 0, ybuf, 0, ubuf, vbuf, 0, width, bpp);

    const pairs = (height - 1) >> 1;
    for (let k = 0; k < pairs; k++) {
        const out = (1 + 2 * k) * rowBytes;
        const y = (1 + 2 * k) * bufferWidth;
        fillRow2(buf, out, ybuf, y, ubuf, vbuf, k * cbw, (k + 1) * cbw, width, bpp);
        fillRow2(buf, out + rowBytes, ybuf, y + bufferWidth, ubuf, vbuf, (k + 1) * cbw, k * cbw, width, bpp);
    }

    // if the image has even height there will be one final row with only one u/v row matching it
    if (1 + 2 * pairs < height) {
        const chromaHeight = Math.ceil(height / 2);
        fillRow1(buf, (height - 1) * rowBytes, ybuf, (height - 1) * bufferWidth, ubuf, vbuf, (chromaHeight - 1) * cbw, width, bpp);
    }
}

/** A row interpolated between chroma rows `c1` (the nearer) and `c2`. */
function fillRow2(buf: Uint8Array, o: number, ybuf: Uint8Array, y: number, ubuf: Uint8Array, vbuf: Uint8Array, c1: number, c2: number, width: number, bpp: number): void {
    const cw = (width + 1) >> 1;
    // need to do left pixel separately since it will only have one u/v value
    setPixel(buf, o, ybuf[y], fancy(ubuf[c1], ubuf[c1], ubuf[c2], ubuf[c2]), fancy(vbuf[c1], vbuf[c1], vbuf[c2], vbuf[c2]));

    // two pixels at a time since they share the same u/v values
    const n = (width - 1) >> 1;
    for (let j = 0; j < n; j++) {
        const p = o + bpp + 2 * j * bpp;
        const u0 = ubuf[c1 + j], u1 = ubuf[c1 + j + 1], u2 = ubuf[c2 + j], u3 = ubuf[c2 + j + 1];
        const v0 = vbuf[c1 + j], v1 = vbuf[c1 + j + 1], v2 = vbuf[c2 + j], v3 = vbuf[c2 + j + 1];
        setPixel(buf, p, ybuf[y + 1 + 2 * j], fancy(u0, u1, u2, u3), fancy(v0, v1, v2, v3));
        setPixel(buf, p + bpp, ybuf[y + 2 + 2 * j], fancy(u1, u0, u3, u2), fancy(v1, v0, v3, v2));
    }

    if ((width - 1) & 1) {
        const u1 = ubuf[c1 + cw - 1], u2 = ubuf[c2 + cw - 1];
        const v1 = vbuf[c1 + cw - 1], v2 = vbuf[c2 + cw - 1];
        setPixel(buf, o + (width - 1) * bpp, ybuf[y + width - 1], fancy(u1, u1, u2, u2), fancy(v1, v1, v2, v2));
    }
}

/** A row using only chroma row `c1`. */
function fillRow1(buf: Uint8Array, o: number, ybuf: Uint8Array, y: number, ubuf: Uint8Array, vbuf: Uint8Array, c1: number, width: number, bpp: number): void {
    const cw = (width + 1) >> 1;
    // doing left pixel first
    setPixel(buf, o, ybuf[y], ubuf[c1], vbuf[c1]);

    // two pixels at a time since they share the same u/v value
    const n = (width - 1) >> 1;
    for (let j = 0; j < n; j++) {
        const p = o + bpp + 2 * j * bpp;
        const u0 = ubuf[c1 + j], u1 = ubuf[c1 + j + 1];
        const v0 = vbuf[c1 + j], v1 = vbuf[c1 + j + 1];
        setPixel(buf, p, ybuf[y + 1 + 2 * j], fancy(u0, u1, u0, u1), fancy(v0, v1, v0, v1));
        setPixel(buf, p + bpp, ybuf[y + 2 + 2 * j], fancy(u1, u0, u1, u0), fancy(v1, v0, v1, v0));
    }

    if ((width - 1) & 1) {
        setPixel(buf, o + (width - 1) * bpp, ybuf[y + width - 1], ubuf[c1 + cw - 1], vbuf[c1 + cw - 1]);
    }
}

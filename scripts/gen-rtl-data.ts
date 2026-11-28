// Generate crates/core/src/symbol/rtl_data.rs: the Unicode tables behind GL JS's built-in right-to-left
// support (`arabic_shaping.ts`, `bidi.ts` and the `unicode_properties.g.ts` they read), from the same
// sources GL JS builds them from: UCD 17.0.0 (`build/generate-unicode-data.ts`) and bidi-js 1.1.0.
//
// Usage:
//   npm i --prefix <dir> @unicode/unicode-17.0.0 bidi-js@1.1.0
//   node scripts/gen-rtl-data.ts <dir>/node_modules > crates/core/src/symbol/rtl_data.rs
import {pathToFileURL} from 'node:url';

const modules = process.argv[2];
if (!modules) throw new Error('usage: node scripts/gen-rtl-data.ts <node_modules>');
const ucd = async (path: string) =>
    (await import(pathToFileURL(`${modules}/@unicode/unicode-17.0.0/${path}/code-points.mjs`).href)).default;
const bidi = (await import(pathToFileURL(`${modules}/bidi-js/dist/bidi.mjs`).href)).default();

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** Sorted code points as inclusive `(start, end)` ranges. */
function ranges(codePoints: Iterable<number>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const cp of [...new Set(codePoints)].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && last[1] + 1 === cp) last[1] = cp;
        else out.push([cp, cp]);
    }
    return out;
}

const rangeTable = (name: string, doc: string, codePoints: Iterable<number>) =>
    `/// ${doc}\npub const ${name}: &[(u32, u32)] = &[\n${ranges(codePoints)
        .map(([a, b]) => `    (${hex(a)}, ${hex(b)}),`)
        .join('\n')}\n];\n`;

// `arabicBlocks` / `readJoiningTypes` / `readPresentationForms` of generate-unicode-data.ts.
const arabicBlocks: Array<[number, number]> = [
    [0x0600, 0x06ff], [0x0750, 0x077f], [0x0870, 0x089f], [0x08a0, 0x08ff],
    [0xfb50, 0xfdff], [0xfe70, 0xfeff], [0x200c, 0x200d],
];
const isArabic = (cp: number) => arabicBlocks.some(([a, b]) => cp >= a && cp <= b);

const joining: Array<[number, number, string]> = [];
for (const [type, name] of [['R', 'Right_Joining'], ['L', 'Left_Joining'], ['D', 'Dual_Joining'], ['C', 'Join_Causing'], ['T', 'Transparent']]) {
    for (const [a, b] of ranges((await ucd(`Joining_Type/${name}`)).filter(isArabic))) joining.push([a, b, type]);
}
joining.sort((x, y) => x[0] - y[0]);

const forms = new Map<number, number[]>();
const ligatures = new Map<number, number[]>();
const markCarriers = new Set([0x0020, 0x0640]);
for (const [shape, name] of ['Isolated', 'Final', 'Initial', 'Medial'].entries()) {
    const decompositions: Map<number, number | number[]> = await ucd(`Decomposition_Mapping/${name}`);
    for (const [cp, decomposition] of decompositions) {
        if (cp < 0xfb50 || cp > 0xfeff) continue;
        const bases = [decomposition].flat();
        const carried = bases.length === 2 && markCarriers.has(bases[0]);
        if (bases.length === 1 || carried) {
            const base = carried ? bases[1] : bases[0];
            const entry = forms.get(base) ?? [0, 0, 0, 0];
            entry[shape] = cp;
            forms.set(base, entry);
        } else if (cp >= 0xfef5 && cp <= 0xfefc) {
            if (bases[0] !== 0x0644) throw new Error(`unexpected ligature ${hex(cp)}`);
            const entry = ligatures.get(bases[1]) ?? [0, 0];
            entry[shape] = cp;
            ligatures.set(bases[1], entry);
        }
    }
}

// `isInRTLScript`.
const readRightToLeft = new Set<number>([
    ...(await ucd('Bidi_Class/Right_To_Left')),
    ...(await ucd('Bidi_Class/Arabic_Letter')),
]);
const rtlScript: number[] = [];
const index = (await import(pathToFileURL(`${modules}/@unicode/unicode-17.0.0/index.mjs`).href)).default;
for (const script of index.Script) {
    if (script === 'Common') continue;
    const codePoints: number[] = await ucd(`Script/${script}`);
    if (codePoints.some(cp => readRightToLeft.has(cp))) for (const cp of codePoints) rtlScript.push(cp);
}

// `joinsToTheFollowingGrapheme` and the `\p{gc=Mc}` of `canCombineGraphemes`.
const joinsToFollowing = [...(await ucd('Indic_Syllabic_Category/Invisible_Stacker')), 0x200d];
const spacingMarks: number[] = await ucd('General_Category/Spacing_Mark');

// bidi-js data, read back through its own lookups so that its decoding (and its quirks) carry over.
const BIDI_TYPES = ['L', 'R', 'EN', 'ES', 'ET', 'AN', 'CS', 'B', 'S', 'WS', 'ON', 'BN', 'NSM', 'AL', 'LRO', 'RLO', 'LRE', 'RLE', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI'];
const bidiTypes: Array<[number, number, number]> = [];
const mirrors: Array<[number, number]> = [];
const openToClose: Array<[number, number]> = [];
const closeToOpen: Array<[number, number]> = [];
const canonical: Array<[number, number]> = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
    const char = String.fromCodePoint(cp);
    const type = BIDI_TYPES.indexOf(bidi.getBidiCharTypeName(char));
    if (type < 0) throw new Error(`unknown bidi type at ${hex(cp)}`);
    const last = bidiTypes[bidiTypes.length - 1];
    if (type !== 0) {
        if (last && last[1] + 1 === cp && last[2] === type) last[1] = cp;
        else bidiTypes.push([cp, cp, type]);
    }
    const pairs: Array<[Array<[number, number]>, string | null]> = [
        [mirrors, bidi.getMirroredCharacter(char)],
        [openToClose, bidi.openingToClosingBracket(char)],
        [closeToOpen, bidi.closingToOpeningBracket(char)],
        [canonical, bidi.getCanonicalBracket(char)],
    ];
    for (const [table, to] of pairs) if (to !== null) table.push([cp, to.codePointAt(0)!]);
}
if (bidiTypes.some(([a, b]) => b >= 0xd800 && a <= 0xdfff)) throw new Error('surrogates have a bidi type');

const pairTable = (name: string, doc: string, pairs: Array<[number, number]>) =>
    `/// ${doc}\npub const ${name}: &[(u32, u32)] = &[\n${pairs
        .map(([a, b]) => `    (${hex(a)}, ${hex(b)}),`)
        .join('\n')}\n];\n`;

const out = [
    '// Generated by scripts/gen-rtl-data.ts from UCD 17.0.0 (@unicode/unicode-17.0.0) and bidi-js 1.1.0. Do not edit.',
    '',
    '/// `Joining_Type` of the Arabic blocks (`ENCODED_JOINING_TYPES`), as sorted `(start, end, type)`. Absent is `U`.',
    'pub const JOINING_TYPES: &[(u32, u32, u8)] = &[',
    ...joining.map(([a, b, t]) => `    (${hex(a)}, ${hex(b)}, b'${t}'),`),
    '];',
    '',
    '/// `PRESENTATION_FORMS`: each letter\'s `[isolated, final, initial, medial]`, 0 where there is none.',
    'pub const PRESENTATION_FORMS: &[(u32, [u32; 4])] = &[',
    ...[...forms].sort((a, b) => a[0] - b[0]).map(([cp, f]) => `    (${hex(cp)}, [${f.map(hex).join(', ')}]),`),
    '];',
    '',
    '/// `LIGATURES`: lam followed by each alef, as `(alef, [isolated, final])`.',
    'pub const LAM_ALEF: &[(u32, [u32; 2])] = &[',
    ...[...ligatures].sort((a, b) => a[0] - b[0]).map(([cp, f]) => `    (${hex(cp)}, [${f.map(hex).join(', ')}]),`),
    '];',
    '',
    rangeTable('RTL_SCRIPT', '`codePointIsInRTLScript`.', rtlScript),
    rangeTable('JOINS_TO_FOLLOWING', 'The former half of `canCombineGraphemes` (invisible stackers and ZWJ).', joinsToFollowing),
    rangeTable('SPACING_MARK', '`\\p{gc=Mc}`, the latter half of `canCombineGraphemes`.', spacingMarks),
    `/// bidi-js character types, as sorted \`(start, end, type)\`; \`type\` indexes ${BIDI_TYPES.join(', ')}. Absent is \`L\`.`,
    'pub const BIDI_TYPES: &[(u32, u32, u8)] = &[',
    ...bidiTypes.map(([a, b, t]) => `    (${hex(a)}, ${hex(b)}, ${t}),`),
    '];',
    '',
    pairTable('MIRRORS', 'bidi-js `getMirroredCharacter`.', mirrors),
    pairTable('OPENING_TO_CLOSING', 'bidi-js `openingToClosingBracket`.', openToClose),
    pairTable('CLOSING_TO_OPENING', 'bidi-js `closingToOpeningBracket`.', closeToOpen),
    pairTable('CANONICAL_BRACKET', 'bidi-js `getCanonicalBracket`.', canonical),
];
process.stdout.write(out.join('\n'));

// Runs maplibre-gl-js render tests (fixtures/render) and reports pass rates.
// Usage: node packages/ml2drender/tests/render-tests.ts [id-substring-filter]
//   → target/test-report/render/{summary.md,results.json,<id>/{actual,expected,diff}.png}
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {convertIndexedToRgb, decode} from 'fast-png';
import pixelmatch from 'pixelmatch';
import {RenderError, Renderer, View} from '../src/core/renderer.ts';
import {encodePng} from '../src/core/encode.ts';

const root = resolve(import.meta.dirname, '../../..');
const testsDir = join(root, 'fixtures/render/tests');
const assets = join(root, 'fixtures/render/assets');
const outDir = join(root, 'target/test-report/render');
const filter = process.argv[2];

/** Operations with no effect on a static render. */
const NOOP_OPERATIONS = ['wait', 'idle', 'sleep', 'redraw'];

type Outcome = {status: 'pass'; diff: number} | {status: 'fail'; error: string} | {status: 'skip'; reason: string};

class Tally {
    pass = 0;
    fail = 0;
    skip = 0;

    add(status: string) {
        if (status === 'pass') this.pass++;
        else if (status === 'fail') this.fail++;
        else this.skip++;
    }

    rate(): number {
        const run = this.pass + this.fail;
        return run === 0 ? 0 : (100 * this.pass) / run;
    }

    line(): string {
        return `total ${this.pass + this.fail + this.skip} — pass ${this.pass} / fail ${this.fail} / skip ${this.skip} — pass rate ${this.rate().toFixed(1)}% of ${this.pass + this.fail} in scope`;
    }

    row(label: string): string {
        return `| ${label} | ${this.pass} | ${this.fail} | ${this.skip} | ${this.rate().toFixed(1)}% |\n`;
    }
}

/** Rust `str` / `Path` ordering: by UTF-8 bytes, path component by component. */
const cmpBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const cmpPath = (a: string, b: string) => {
    const [pa, pb] = [a.split(sep), b.split(sep)];
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        const c = cmpBytes(pa[i], pb[i]);
        if (c) return c;
    }
    return pa.length - pb.length;
};

/** All files named `name` under `dir`, sorted. */
function findFiles(dir: string, name: string): string[] {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        for (const e of readdirSync(d, {withFileTypes: true})) {
            const p = join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.name === name) out.push(p);
        }
    }
    return out.sort(cmpPath);
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const u64 = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const f64 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function run() {
    if (!existsSync(join(root, 'fixtures'))) {
        console.error('fixtures/ missing: run scripts/fetch-fixtures.sh');
        process.exit(2);
    }
    const exclusions = readJson(join(import.meta.dirname, 'exclusions.json'));
    rmSync(outDir, {recursive: true, force: true});
    mkdirSync(outDir, {recursive: true});

    const overall = new Tally();
    const byLayer = new Map<string, Tally>();
    const skipReasons = new Map<string, number>();
    const failReasons = new Map<string, number>();
    const results: unknown[] = [];

    for (const stylePath of findFiles(testsDir, 'style.json')) {
        const dir = resolve(stylePath, '..');
        const id = relative(testsDir, dir).split(sep).join('/');
        if (filter !== undefined && !id.includes(filter)) continue;
        let outcome: Outcome;
        let layerTypes: string[] = [];
        // Each test is isolated: anything it throws is its failure.
        try {
            const style = readJson(stylePath);
            const layers: unknown[] = Array.isArray(style?.layers) ? style.layers : [];
            layerTypes = [...new Set(layers.map((l: any) => l?.type).filter((t): t is string => typeof t === 'string'))].sort(cmpBytes);
            const reason = exclusion(exclusions, style);
            outcome = reason !== undefined ? {status: 'skip', reason} : runOne(dir, style, join(outDir, id));
        } catch (e) {
            // The first line (the message) groups fail reasons; a bug's stack follows.
            const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
            outcome = {status: 'fail', error: e instanceof RenderError || !(e instanceof Error) ? message : `${message}\n${e.stack ?? ''}`};
        }
        const detail = outcome.status === 'pass' ? outcome.diff : outcome.status === 'fail' ? outcome.error : outcome.reason;
        results.push({id, status: outcome.status, detail, layers: layerTypes});
        if (outcome.status === 'skip') {
            skipReasons.set(outcome.reason, (skipReasons.get(outcome.reason) ?? 0) + 1);
        } else if (outcome.status === 'fail') {
            const key = outcome.error.startsWith('diff ') ? 'pixel diff above allowed' : outcome.error.split('\n')[0];
            failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
        }
        overall.add(outcome.status);
        for (const t of layerTypes) {
            let tally = byLayer.get(t);
            if (!tally) byLayer.set(t, (tally = new Tally()));
            tally.add(outcome.status);
        }
    }

    const sorted = <V>(m: Map<string, V>) => [...m].sort((a, b) => cmpBytes(a[0], b[0]));
    let md = `## Render tests\n\n${overall.line()}\n\n| layer type | pass | fail | skip | pass rate (excl. skip) |\n|---|---|---|---|---|\n`;
    for (const [t, tally] of sorted(byLayer)) md += tally.row(t);
    md += '\n(a test counts under every layer type it uses)\n\n### Skip reasons\n\n';
    for (const [r, n] of sorted(skipReasons)) md += `- ${n}: ${r}\n`;
    md += '\n### Fail reasons\n\n';
    for (const [r, n] of sorted(failReasons)) md += `- ${n}: ${r}\n`;
    process.stdout.write(md);
    writeFileSync(join(outDir, 'summary.md'), md);
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    console.error(`report: ${outDir}`);
}

function runOne(dir: string, style: any, outDir: string): Outcome {
    const t = style?.metadata?.test ?? {};
    const width = u64(t.width) ?? 512;
    const height = u64(t.height) ?? 512;
    // The harness passes `maxCanvasSize: [8192, 8192]`; MapLibre lowers the pixel ratio to fit.
    const requestedRatio = f64(t.pixelRatio) ?? 1;
    const fit = (size: number) => Math.min(8192 / (size * requestedRatio), 1);
    const pixelRatio = requestedRatio * Math.min(fit(width), fit(height));
    const allowed = f64(t.allowed) ?? 0.00025;
    const threshold = f64(t.threshold) ?? 0.1285;

    const num = (v: unknown) => f64(v) ?? 0;
    const view = new View([num(style.center?.[0]), num(style.center?.[1])], num(style.zoom), num(style.bearing), width, height, pixelRatio, 0);
    const maxZoom = f64(t.maxZoom);
    const crossSource = typeof t.crossSourceCollisions === 'boolean' ? t.crossSourceCollisions : true;
    const rendered = render(style, view, maxZoom, crossSource);
    const [cw, ch] = [Math.round(width * pixelRatio), Math.round(height * pixelRatio)];
    if (rendered.length !== cw * ch * 4) {
        return {status: 'fail', error: `renderer returned ${rendered.length} bytes, expected ${cw}x${ch} RGBA`};
    }
    // `readPixels(0, 0, w, h)` reads the bottom-left corner (GL's origin).
    const w = Math.min(u64(t.reportWidth) ?? cw, cw);
    const h = Math.min(u64(t.reportHeight) ?? ch, ch);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = ch - h; y < ch; y++) rgba.set(rendered.subarray(y * cw * 4, (y * cw + w) * 4), (y - (ch - h)) * w * 4);

    // Like upstream: compare against every expected*.png, keep the closest.
    let best: {diff: number; diffImg: Uint8Array; expected: Uint8Array} | undefined;
    for (const name of readdirSync(dir)) {
        if (!(name.startsWith('expected') && name.endsWith('.png'))) continue;
        const decoded = decodePng(join(dir, name));
        if (!decoded || decoded.width !== w || decoded.height !== h) continue;
        const diffImg = new Uint8Array(w * h * 4);
        const diff = pixelmatch(rgba, decoded.data, diffImg, w, h, {threshold}) / (w * h);
        if (!best || diff < best.diff) best = {diff, diffImg, expected: decoded.data};
    }
    if (!best) return {status: 'fail', error: `no expected*.png of size ${w}x${h}`};
    if (best.diff <= allowed) return {status: 'pass', diff: best.diff};
    mkdirSync(outDir, {recursive: true});
    for (const [name, img] of [['actual.png', rgba], ['expected.png', best.expected], ['diff.png', best.diffImg]] as const) {
        writeFileSync(join(outDir, name), encodePng(img, w, h));
    }
    return {status: 'fail', error: `diff ${best.diff.toFixed(5)} > allowed ${allowed}`};
}

/** The host loop: answer `needs()` from the local assets until it is empty, then render. */
function render(style: any, view: View, maxZoom: number | undefined, crossSourceCollisions: boolean): Uint8Array {
    const r = new Renderer(JSON.stringify(style), view);
    r.setCrossSourceCollisions(crossSourceCollisions);
    if (maxZoom !== undefined) r.setMaxZoom(maxZoom);
    let rounds = 0;
    for (;;) {
        const needs = r.needs();
        if (needs.length === 0) break;
        rounds++;
        if (rounds > 32) throw new Error(`needs() not settling after ${rounds} rounds: ${JSON.stringify(needs[0].url)}`);
        for (const res of needs) {
            // The upstream test server answers 204 (empty body) for these, 404 otherwise.
            let bytes: Uint8Array | undefined;
            if (res.url.includes('/sparse204/1-')) {
                bytes = new Uint8Array(0);
            } else {
                const path = localPath(res.url);
                try {
                    bytes = path !== undefined ? readFileSync(path) : undefined;
                } catch {
                    bytes = undefined;
                }
            }
            r.provide(res.url, bytes);
        }
    }
    return r.render().data;
}

/** `local://x` and the upstream harness server `http://localhost:2900/x` both map to assets/x. */
function localPath(url: string): string | undefined {
    const prefix = ['local://', 'http://localhost:2900/'].find((p) => url.startsWith(p));
    if (prefix === undefined) return undefined;
    const rel = url.slice(prefix.length).split(/[?#]/)[0];
    return join(assets, percentDecode(rel));
}

function percentDecode(s: string): string {
    const b = Buffer.from(s);
    const out: number[] = [];
    const hex = (c: number | undefined) => c !== undefined && /[0-9a-fA-F]/.test(String.fromCharCode(c));
    for (let i = 0; i < b.length; i++) {
        if (b[i] === 0x25 && hex(b[i + 1]) && hex(b[i + 2])) {
            out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16));
            i += 2;
        } else {
            out.push(b[i]);
        }
    }
    return new TextDecoder().decode(new Uint8Array(out));
}

function exclusion(ex: any, style: any): string | undefined {
    const rule = (table: string, key: unknown) => {
        if (typeof key !== 'string') return undefined;
        const r = ex?.[table]?.[key];
        return typeof r === 'string' ? `${table}.${key}: ${r}` : undefined;
    };
    const nonzero = (v: unknown) => typeof v === 'number' && v !== 0;
    if (nonzero(style?.pitch)) return 'pitch != 0 (3D)';
    if (nonzero(style?.roll)) return 'roll != 0 (3D)';
    if (style?.projection !== undefined && style.projection?.type !== 'mercator') return 'non-mercator projection';
    const t = style?.metadata?.test;
    const ops: unknown[] = Array.isArray(t?.operations) ? t.operations : [];
    const op = ops.map((o) => (Array.isArray(o) ? o[0] : undefined)).find((o): o is string => typeof o === 'string' && !NOOP_OPERATIONS.includes(o));
    if (op !== undefined) return `operation \`${op}\`: runtime style/camera changes out of scope`;
    if (style === null || typeof style !== 'object' || Array.isArray(style)) return undefined;
    const layers: any[] = Array.isArray(style.layers) ? style.layers : [];
    const sources: any[] = style.sources && typeof style.sources === 'object' && !Array.isArray(style.sources) ? Object.values(style.sources) : [];
    const first = <T>(xs: T[], f: (x: T) => string | undefined) => xs.map(f).find((r) => r !== undefined);
    return (
        first(layers, (l) => rule('layer_types', l?.type)) ??
        first(sources, (s) => rule('source_types', s?.type)) ??
        first(sources, (s) => rule('source_encodings', s?.encoding)) ??
        first(Object.keys(style), (k) => rule('style_properties', k)) ??
        first(t && typeof t === 'object' && !Array.isArray(t) ? Object.keys(t) : [], (k) => rule('test_options', k))
    );
}

/** RGBA8 of a PNG, expanding palettes, gray and 16-bit samples. */
function decodePng(path: string): {width: number; height: number; data: Uint8Array} | undefined {
    let png;
    try {
        png = decode(readFileSync(path));
    } catch {
        return undefined;
    }
    const {width, height} = png;
    let samples: ArrayLike<number> = png.data;
    let channels = png.channels;
    if (png.palette) {
        samples = convertIndexedToRgb(png);
        channels = png.palette[0].length;
    } else if (png.depth === 16) {
        samples = Uint8Array.from(png.data, (v) => v >> 8);
    } else if (png.depth !== 8) {
        // ponytail: sub-byte grayscale is not unpacked; the fixtures' expected images are all RGBA8.
        return undefined;
    }
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels;
        const [r, g, b, a] =
            channels === 4 ? [samples[s], samples[s + 1], samples[s + 2], samples[s + 3]]
            : channels === 3 ? [samples[s], samples[s + 1], samples[s + 2], 255]
            : channels === 2 ? [samples[s], samples[s], samples[s], samples[s + 1]]
            : [samples[s], samples[s], samples[s], 255];
        data.set([r, g, b, a], i * 4);
    }
    return {width, height, data};
}

run();

// Compare rendering performance of checkouts on upstream fixtures (`pnpm fixtures`), offline.
// Each variant is a checkout driven through its own JS API (packages/ml2drender/src/index.ts), so API
// changes between them are fine. Checkouts from before the TypeScript port render with their WASM. The
// first variant is the baseline; renders alternate between variants. Prints a Markdown report; exits 1
// if a case is slower than the baseline by > threshold.
//
// Usage: pnpm bench <name>=<checkout>[:<wasm>] ... [--samples 15] [--threshold 0.1] [--png <dir>]
//   TypeScript checkouts need `pnpm install`. For WASM checkouts, <wasm> (relative to the current directory)
//   defaults to <checkout>/target/wasm32-unknown-unknown/wasm/ml2drender_wasm.wasm (`pnpm build:wasm` there).
// Example, working tree vs main: git worktree add ../main main && (cd ../main && pnpm install) && pnpm bench main=../main head=.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(import.meta.dirname, '..');
const assets = join(root, 'fixtures/render/assets');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const samples = Number(option('samples', '15'));
const threshold = Number(option('threshold', '0.1'));
const pngDir = option('png', '');
const variants = args.map((arg) => {
  const [name, spec] = arg.split('=');
  const [dir, wasm] = spec.split(':');
  const ts = existsSync(join(dir, 'packages/ml2drender/src/core/renderer.ts'));
  return {name, dir: resolve(dir), wasm: ts ? undefined : resolve(wasm ?? join(dir, 'target/wasm32-unknown-unknown/wasm/ml2drender_wasm.wasm'))};
});
if (variants.length < 2) throw new Error('usage: node scripts/bench.ts base=<checkout>[:<wasm>] head=<checkout>[:<wasm>] [--samples N] [--threshold R] [--png dir]');

interface View {center: [number, number]; zoom: number; bearing?: number; width: number; height: number; pixelRatio?: number}
// Base checkouts may predate RenderedImage.toPng() and renderView().
interface Renderer {renderView?(view: View): Promise<{data: Uint8ClampedArray; toPng?(): Uint8Array}>; render?(view: View): Promise<{data: Uint8ClampedArray; toPng?(): Uint8Array}>; renderPng?(view: View): Promise<Uint8Array>}
const draw = (r: Renderer, view: View) => r.renderView ? r.renderView(view) : r.render!(view);
interface Api {MapRenderer: {init(style: object, options: object): Promise<Renderer>}}

// Synthetic styles. Fixture resources are local://<path under assets>.
const tile = (z: number, x: number, y: number): [number, number] =>
  [x / 2 ** z * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI];
// The corner shared by the dense Berlin streets tiles 14/8802..8803/5374..5375.
const berlin = tile(14, 8803, 5375);
const streets = (file: string) => {
  const style = JSON.parse(readFileSync(join(assets, 'styles', file), 'utf8'));
  style.sources.maplibre = {type: 'vector', tiles: ['local://tiles/{z}-{x}-{y}.mvt'], maxzoom: 14};
  return style;
};
const geojson = (features: object[]) => ({type: 'geojson', data: {type: 'FeatureCollection', features}});
const point = (i: number, columns: number, step: number): [number, number] =>
  [berlin[0] - 0.02 + (i % columns) * step, berlin[1] - 0.012 + Math.floor(i / columns) * step * 0.6];
const styles: Record<string, object> = {
  bright: streets('bright-v9.json'),
  basic: streets('basic-v9.json'),
  dem: {version: 8, sources: {dem: {type: 'raster-dem', tiles: ['local://tiles/{z}-{x}-{y}.terrain.png'], tileSize: 256, maxzoom: 12}}, layers: [
    {id: 'relief', type: 'color-relief', source: 'dem', paint: {'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#004400', 500, '#88aa44', 1500, '#ccaa66', 3000, '#ffffff']}},
    {id: 'shade', type: 'hillshade', source: 'dem'},
  ]},
  satellite: {version: 8, sources: {satellite: {type: 'raster', tiles: ['local://tiles/{z}-{x}-{y}.satellite.png'], tileSize: 256, maxzoom: 12}}, layers: [{id: 'satellite', type: 'raster', source: 'satellite'}]},
  // Many layers filtering one GeoJSON source.
  lines: {version: 8, sources: {data: geojson(Array.from({length: 1500}, (_, i) => ({type: 'Feature', properties: {kind: i % 8}, geometry: {type: 'LineString', coordinates: Array.from({length: 24}, (_, j) => {
    const [x, y] = point(i, 50, 0.0008);
    return [x + j * 0.00002, y + j * 0.00004];
  })}})))}, layers: Array.from({length: 8}, (_, i) => ({id: `line-${i}`, type: 'line', source: 'data', filter: ['==', ['get', 'kind'], i], paint: {'line-width': 1 + i % 3, 'line-color': '#557799'}}))},
  labels: {version: 8, glyphs: 'local://glyphs/{fontstack}/{range}.pbf', sources: {data: geojson(Array.from({length: 10000}, (_, i) => ({type: 'Feature', properties: {name: `Label ${i % 97}`}, geometry: {type: 'Point', coordinates: point(i, 100, 0.0004)}})))},
    layers: [{id: 'labels', type: 'symbol', source: 'data', layout: {'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10}}]},
  icons: {version: 8, sprite: 'local://sprites/bright-v9', sources: {data: geojson(Array.from({length: 1024}, (_, i) => ({type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: point(i, 32, 0.0012)}})))},
    layers: [{id: 'icons', type: 'symbol', source: 'data', layout: {'icon-image': 'cafe-15', 'icon-allow-overlap': true, 'icon-ignore-placement': true}}]},
};
const terrain = tile(12, 759, 1609);
// `center` moved by (dx, dy) CSS px at `zoom`.
const shift = ([lng, lat]: [number, number], zoom: number, dx: number, dy: number): [number, number] => {
  const size = 512 * 2 ** zoom;
  const x = (lng + 180) / 360 * size + dx;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * size + dy;
  return [x / size * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI];
};
// The four quadrants of `view`, as views of half its size: neighboring output tiles of one renderer.
const quadrants = (view: View): View[] => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) =>
  ({...view, center: shift(view.center, view.zoom, i * view.width / 4, j * view.height / 4), width: view.width / 2, height: view.height / 2}));
// The fixture sprites are 1x only, so cases with icons use DPR 1. The dense tiles span 1024 px at z15.
// With `then`, one renderer renders `view` untimed and then `then` (timed, per view), as a tile
// server or map client does with `set_view`.
const cases: {name: string; style: string; view: View; then?: View[]}[] = [
  {name: 'bright z14', style: 'bright', view: {center: berlin, zoom: 14, width: 512, height: 512}},
  {name: 'bright z15', style: 'bright', view: {center: berlin, zoom: 15, width: 1024, height: 1024}},
  {name: 'bright z16.5 bearing 17°', style: 'bright', view: {center: berlin, zoom: 16.5, bearing: 17, width: 1024, height: 1024}},
  {name: 'basic z15', style: 'basic', view: {center: berlin, zoom: 15, width: 1024, height: 1024}},
  {name: 'hillshade + color-relief', style: 'dem', view: {center: terrain, zoom: 13, width: 512, height: 512, pixelRatio: 2}},
  {name: 'raster', style: 'satellite', view: {center: terrain, zoom: 13.5, bearing: 17, width: 512, height: 512, pixelRatio: 2}},
  {name: 'GeoJSON lines, 8 layers', style: 'lines', view: {center: berlin, zoom: 14, width: 512, height: 512, pixelRatio: 2}},
  {name: 'GeoJSON 10k labels', style: 'labels', view: {center: berlin, zoom: 14, width: 512, height: 512}},
  {name: 'GeoJSON 1024 icons', style: 'icons', view: {center: berlin, zoom: 14, width: 1024, height: 1024}},
  // One z14 data tile: the whole of it, then its four z15 quadrants.
  ...[{name: 'bright z15, 4 tiles of one data tile (reuse)', style: 'bright', view: {center: shift(berlin, 15, -512, -512), zoom: 15, width: 1024, height: 1024}},
    {name: 'GeoJSON 10k labels, 4 tiles (reuse)', style: 'labels', view: {center: shift(berlin, 14, -256, -256), zoom: 14, width: 512, height: 512}},
  ].map((c) => ({...c, then: quadrants(c.view)})),
];

globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  try {
    return new Response(readFileSync(join(assets, decodeURIComponent(url.replace(/^local:\/\//, '')))));
  } catch {
    return new Response(null, {status: 404});
  }
};

// TypeScript checkouts run as is. WASM checkouts: transpile the API with this checkout's TypeScript (no
// type check: its node_modules may be absent).
const tsc = join(root, 'packages/ml2drender/node_modules/.bin/tsc');
const loaded = await Promise.all(variants.map(async (v) => {
  if (!v.wasm) return {...v, api: (await import(pathToFileURL(join(v.dir, 'packages/ml2drender/src/index.ts')).href)) as Api, module: undefined};
  const out = mkdtempSync(join(tmpdir(), 'ml2drender-bench-'));
  execFileSync(tsc, ['--noCheck', '--skipLibCheck', '--target', 'es2024', '--module', 'esnext', '--outDir', out, join(v.dir, 'packages/ml2drender/src/index.ts')]);
  const api: Api = await import(pathToFileURL(join(out, 'index.js')).href);
  return {...v, api, module: await WebAssembly.compile(readFileSync(v.wasm))};
}));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// Interquartile range relative to the median: how noisy a measurement was.
const spread = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)]) / median(xs);
};
const pct = (r: number) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

const [base, ...others] = loaded;
const head = `| ケース | ${loaded.map((v) => v.name).join(' | ')} | 差 | ばらつき | 出力 |`;
const rows = [head, `|---|${loaded.map(() => '---:|').join('')}---:|---:|---|`];
const memory = loaded.map(() => 0);
let regressions = 0;
for (const c of cases) {
  const runs = loaded.map((v) => ({v, renderer: undefined as Renderer | undefined, times: [] as number[], hash: ''}));
  for (let i = 0; i < samples + 2; i++) {
    // Alternate the order to spread warm-up, JIT and thermal effects; the first two rounds warm up.
    for (const run of i % 2 ? [...runs].reverse() : runs) {
      // A new renderer each time: renderers keep decoded tiles, and this measures a cold render.
      run.renderer = await run.v.api.MapRenderer.init(styles[c.style], {wasm: run.v.module, cache: {ttlMs: Infinity}});
      if (c.then) await draw(run.renderer, c.view);
      const views = c.then ?? [c.view];
      const start = performance.now();
      let image!: {data: Uint8ClampedArray};
      for (const view of views) image = await draw(run.renderer, view);
      const ms = (performance.now() - start) / views.length;
      if (i >= 2) run.times.push(ms);
      run.hash ||= createHash('sha256').update(image.data).digest('hex');
    }
  }
  runs.forEach((run, i) => {
    const wasm = (run.renderer as unknown as {wasm?: {memory: WebAssembly.Memory}}).wasm;
    memory[i] = Math.max(memory[i], wasm?.memory.buffer.byteLength ?? 0);
  });
  if (pngDir) {
    mkdirSync(pngDir, {recursive: true});
    const view = (c.then ?? [c.view]).at(-1)!;
    for (const [i, run] of runs.entries()) {
      const r = run.renderer!;
      const png = r.renderPng ? await r.renderPng(view) : (await draw(r, view)).toPng!();
      writeFileSync(join(pngDir, `${c.name.replace(/[^\w.-]+/g, '_')}.${loaded[i].name}.png`), png);
    }
  }
  const medians = runs.map((r) => median(r.times));
  const ratios = medians.slice(1).map((m) => m / medians[0] - 1);
  const worst = Math.max(...ratios);
  if (worst > threshold) regressions++;
  const mark = worst > threshold ? ' ⚠️ 劣化' : Math.min(...ratios) < -threshold ? ' 改善' : '';
  const same = runs.every((r) => r.hash === runs[0].hash);
  rows.push(`| ${c.name} | ${medians.map((m) => `${m.toFixed(1)} ms`).join(' | ')} | ${ratios.map(pct).join(', ')}${mark} | ${(Math.max(...runs.map((r) => spread(r.times))) * 100).toFixed(1)}% | ${same ? '同一' : '**変化あり**'} |`);
}
if (loaded.some((v) => v.wasm)) {
  const sizes = loaded.map((v) => (v.wasm ? statSync(v.wasm).size : 0));
  const cell = (xs: number[], f: (x: number) => string) => `| ${xs.map((x) => (x ? f(x) : '-')).join(' | ')} | | | |`;
  rows.push(`| WASM サイズ ${cell(sizes, (b) => `${(b / 1e6).toFixed(3)} MB`)}`);
  rows.push(`| WASM メモリ最大 ${cell(memory, mib)}`);
}

console.log(`## ベンチマーク: ${others.map((v) => v.name).join(', ')} vs ${base.name}

${rows.join('\n')}

各ケース ${samples} 回(ウォームアップ 2 回)の中央値。描画ごとに素材のデコードから行い、取得はメモリ上のfixture。差が ±${threshold * 100}% を超えると印を付ける。「ばらつき」は四分位範囲/中央値で、これより小さい差は誤差とみなす。「出力」は ${base.name} とのRGBA一致。Node ${process.version}。`);
process.exitCode = regressions ? 1 : 0;

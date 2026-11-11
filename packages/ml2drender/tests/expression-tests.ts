// Runs maplibre-style-spec expression tests (fixtures/expression) against the style-spec package,
// mirroring test/integration/expression/expression.test.ts upstream.
// Usage: pnpm test:expression [id-substring-filter] → target/test-report/expression/{summary.md,failures.json}
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {convertFunction, createPropertyExpression, isFunction, toString} from '@maplibre/maplibre-gl-style-spec';

const root = resolve(import.meta.dirname, '../../..');
const testsDir = join(root, 'fixtures/expression/tests');
const outDir = join(root, 'target/test-report/expression');
const filter = process.argv[2];
const EXTENT = 8192;
const ROOT_KEY = 'layers[0].paint.some-property';

type Canonical = {z: number; x: number; y: number};

const point = ([lng, lat]: number[], c: Canonical) => {
    const tiles = 2 ** c.z;
    const x = (180 + lng) / 360;
    const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
    return {x: Math.round(x * tiles * EXTENT) - c.x * EXTENT, y: Math.round(y * tiles * EXTENT) - c.y * EXTENT};
};

// GeoJSON geometry becomes tile coordinates when a canonical tile ID is given, otherwise only the type is set.
function feature(input: any, canonical: Canonical | null) {
    const f: any = {properties: input.properties ?? {}};
    if ('id' in input) f.id = input.id;
    const g = input.geometry;
    if (!g) return f;
    if (!canonical) {
        f.type = g.type;
        return f;
    }
    if (!g.coordinates) return f;
    const line = (l: number[][]) => l.map((p) => point(p, canonical));
    const c = g.coordinates;
    [f.type, f.geometry] = {
        Point: () => ['Point', [[point(c, canonical)]]],
        MultiPoint: () => ['Point', c.map((p: number[]) => [point(p, canonical)])],
        LineString: () => ['LineString', [line(c)]],
        MultiLineString: () => ['LineString', c.map(line)],
        Polygon: () => ['Polygon', c.map(line)],
        MultiPolygon: () => ['Polygon', c.flatMap((p: number[][][]) => p.map(line))],
    }[g.type as string]?.() ?? [g.type, []];
    return f;
}

function evaluate(fixture: any) {
    const spec = {'property-type': 'data-driven', expression: {interpolated: true, parameters: ['zoom', 'feature']}, ...fixture.propertySpec};
    const input = isFunction(fixture.expression) ? convertFunction(fixture.expression, spec) : fixture.expression;
    const compiled = createPropertyExpression(input, ROOT_KEY, spec, fixture.globalState);
    if (compiled.result === 'error') {
        return {compiled: {result: 'error', errors: compiled.value.map((e) => ({key: e.key, error: e.message}))}};
    }
    const expr = compiled.value as any;
    const type = expr._styleExpression.expression.type;
    const outputs = (fixture.inputs ?? []).map(([globals, input]: any[]) => {
        const canonical = 'canonicalID' in globals ? globals.canonicalID : null;
        try {
            const v = expr.evaluateWithoutErrorHandling(globals, feature(input, canonical), input.featureState ?? {}, canonical, globals.availableImages ?? []);
            return type.kind === 'color' ? [v.r, v.g, v.b, v.a] : v;
        } catch (e: any) {
            return {error: e.name === 'RuntimeError' ? `${ROOT_KEY}${e.path ?? ''}: ${e.message}` : e.message};
        }
    });
    const kind = expr.kind;
    return {
        compiled: {
            result: 'success',
            isFeatureConstant: kind === 'constant' || kind === 'camera',
            isZoomConstant: kind === 'constant' || kind === 'source',
            type: toString(type),
        },
        // JSON round trip, as upstream compares serialized outputs (e.g. Formatted, ResolvedImage).
        outputs: JSON.parse(JSON.stringify(outputs)),
    };
}

// Upstream `stripPrecision`: numbers compared at 6 significant figures.
const strip = (x: number) => {
    if (x === 0) return x;
    const m = Math.pow(10, Math.max(0, 6 - Math.ceil(Math.log10(Math.abs(x)))));
    return Math.floor(Math.floor(x * m) / m * m) / m;
};
const deepEqual = (a: any, b: any): boolean => {
    if (typeof a === 'number' && typeof b === 'number') return strip(a) === strip(b);
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const ka = Object.keys(a);
        return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
    }
    return a === b;
};

const tally = () => ({pass: 0, fail: 0});
const overall = tally();
const groups = new Map<string, ReturnType<typeof tally>>();
const failures = [];
const ids = readdirSync(testsDir, {recursive: true, encoding: 'utf8'})
    .filter((p) => p.endsWith('/test.json'))
    .map((p) => p.slice(0, -'/test.json'.length))
    .filter((id) => !filter || id.includes(filter))
    .sort();
for (const id of ids) {
    const fixture = JSON.parse(readFileSync(join(testsDir, id, 'test.json'), 'utf8'));
    const actual: any = evaluate(fixture);
    const expected = fixture.expected;
    const compileOk = deepEqual(actual.compiled, expected.compiled);
    const ok = compileOk && deepEqual(actual.outputs, expected.outputs);
    const group = id.split('/')[0];
    if (!groups.has(group)) groups.set(group, tally());
    for (const t of [overall, groups.get(group)!]) t[ok ? 'pass' : 'fail']++;
    if (!ok) failures.push({id, stage: compileOk ? 'evaluation' : 'compilation', expected, actual});
}

const total = overall.pass + overall.fail;
const rate = (t: {pass: number; fail: number}) => `${((100 * t.pass) / Math.max(1, t.pass + t.fail)).toFixed(1)}%`;
const line = `total ${total} — pass ${overall.pass} / fail ${overall.fail} — pass rate ${rate(overall)}`;
let md = `## Expression tests\n\n${line}\n\n| group | pass | fail | pass rate |\n|---|---|---|---|\n`;
for (const [g, t] of [...groups].sort()) md += `| ${g} | ${t.pass} | ${t.fail} | ${rate(t)} |\n`;
mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, 'summary.md'), md);
writeFileSync(join(outDir, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(`## Expression tests\n\n${line}`);
console.error(`report: ${outDir}`);

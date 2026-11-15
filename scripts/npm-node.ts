// npm packaging of the Node-API addon (packages/ml2drender-node), one package per platform as
// napi-rs does: the main package lists them as optionalDependencies and npm installs the one
// matching the machine (os / cpu / libc).
//   node scripts/npm-node.ts deps                  add the optionalDependencies to the main package
//   node scripts/npm-node.ts platforms <in> <out>  <in>/ml2drender.<platform>-<arch>.node → <out>/node-<platform>-<arch>[-gnu]/
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TARGETS = [
  { platform: 'linux', arch: 'x64', libc: 'glibc' },
  { platform: 'linux', arch: 'arm64', libc: 'glibc' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
];
// Must match the package name the loader in packages/ml2drender-node/src/index.ts requires.
const suffix = (t: (typeof TARGETS)[number]) => `${t.platform}-${t.arch}${t.platform === 'linux' ? '-gnu' : ''}`;
const name = (t: (typeof TARGETS)[number]) => `@ml2drender/node-${suffix(t)}`;

const mainPath = 'packages/ml2drender-node/package.json';
const main = JSON.parse(readFileSync(mainPath, 'utf8'));
const [command, input, output] = process.argv.slice(2);

if (command === 'deps') {
  main.optionalDependencies = Object.fromEntries(TARGETS.map((t) => [name(t), main.version]));
  writeFileSync(mainPath, JSON.stringify(main, null, 2) + '\n');
} else if (command === 'platforms' && input && output) {
  for (const t of TARGETS) {
    const dir = `${output}/node-${suffix(t)}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(`${input}/ml2drender.${t.platform}-${t.arch}.node`, `${dir}/ml2drender.node`);
    writeFileSync(`${dir}/package.json`, JSON.stringify({
      name: name(t),
      version: main.version,
      description: `The ${t.platform}-${t.arch} addon of ${main.name}`,
      license: main.license,
      repository: main.repository,
      main: 'ml2drender.node',
      files: ['ml2drender.node'],
      os: [t.platform],
      cpu: [t.arch],
      ...(t.libc ? { libc: [t.libc] } : {}),
    }, null, 2) + '\n');
    console.log(dir);
  }
} else {
  throw new Error('usage: npm-node.ts deps | platforms <in> <out>');
}

// encodePng round trip: decoding the PNG gives back the pixels, for each filter's kind of content.
import {deepStrictEqual} from 'node:assert';
import {decode} from 'fast-png';
import {encodePng} from '../src/core/encode.ts';

const w = 37;
const h = 23;
const images = {
  noise: (i: number) => (i * 2654435761) >>> 24,
  gradient: (i: number) => ((i >> 2) % w) * 7 + Math.floor(i / 4 / w) * 3,
  flat: () => 200,
};
for (const [name, f] of Object.entries(images)) {
  const rgba = Uint8Array.from({length: w * h * 4}, (_, i) => f(i) & 0xff);
  const png = decode(encodePng(rgba, w, h));
  deepStrictEqual([png.width, png.height, png.channels, png.depth], [w, h, 4, 8]);
  deepStrictEqual(Uint8Array.from(png.data), rgba, name);
}
console.log(`ok: ${Object.keys(images).length} PNG round trips`);

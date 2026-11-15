/// <reference lib="webworker" />
// Loaded into GL JS's workers with `importScriptInWorkers`: GL JS tiles GeoJSON there, where the
// main thread's converter cannot go, so the workers build the same one from the PROJJSON `definition`.
import { converter } from './proj';

(self as unknown as { setProjectionHandler(handler: (definition: string) => object): void })
  .setProjectionHandler((definition) => converter(JSON.parse(definition)));

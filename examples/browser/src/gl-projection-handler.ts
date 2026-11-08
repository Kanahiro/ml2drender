/// <reference lib="webworker" />
// Loaded into GL JS's workers with `importScriptInWorkers`: GL JS tiles GeoJSON there, where the
// main thread's converter cannot go, so the workers build the same one from the PROJJSON `definition`.
import { loadProjectionFactory } from 'ml2drender';

const create = await loadProjectionFactory();
(self as unknown as { setProjectionHandler(handler: (definition: string) => object): void })
  .setProjectionHandler((definition) => create(JSON.parse(definition)));

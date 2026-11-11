/// <reference lib="webworker" />
import { type Crs, MapRenderer, type SourceTile, type Tile } from 'ml2drender';
import type { StyleSpecification } from 'maplibre-gl';

export type WorkerRequest =
  | { kind: 'init'; generation: number; style: StyleSpecification }
  /** A tile of the Web Mercator grid, or with `crs` of that CRS's grid. */
  | { kind: 'render'; generation: number; id: number; tile: Tile; crs?: Crs }
  | { kind: 'source'; generation: number; id: number; tile: SourceTile; crs: Crs };

export type WorkerResponse =
  | { kind: 'ready'; generation: number }
  | { kind: 'image'; generation: number; id: number; bitmap: ImageBitmap; renderMs: number }
  | { kind: 'source'; generation: number; id: number; data: ArrayBuffer; renderMs: number }
  | { kind: 'error'; generation: number; id?: number; message: string };

let generation = 0;
let renderer: MapRenderer | undefined;
const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.kind === 'init') {
    generation = request.generation;
    renderer = undefined;
    void MapRenderer.init(request.style, { cache: { ttlMs: Infinity } })
      .then((loaded) => {
        if (request.generation !== generation) return;
        renderer = loaded;
        worker.postMessage({ kind: 'ready', generation } satisfies WorkerResponse);
      })
      .catch((error: unknown) => {
        if (request.generation === generation) {
          worker.postMessage({ kind: 'error', generation, message: String(error) } satisfies WorkerResponse);
        }
      });
    return;
  }
  const active = renderer;
  if (request.generation !== generation || !active) return;
  const started = performance.now();
  const failed = (error: unknown) => {
    if (request.generation === generation) {
      worker.postMessage({ kind: 'error', generation, id: request.id, message: String(error) } satisfies WorkerResponse);
    }
  };
  if (request.kind === 'source') {
    void active.projected(request.crs).getTile(request.tile)
      .then((tile) => {
        if (request.generation !== generation) return;
        const data = tile.slice().buffer;
        worker.postMessage({ kind: 'source', generation, id: request.id, data, renderMs: performance.now() - started } satisfies WorkerResponse, [data]);
      })
      .catch(failed);
    return;
  }
  void (request.crs ? active.projected(request.crs).renderTile(request.tile) : active.renderTile(request.tile))
    .then(async (image) => {
      // Includes resource loading and overlapping renders; this is elapsed time, not CPU time.
      const renderMs = performance.now() - started;
      if (request.generation !== generation) return;
      const bitmap = await createImageBitmap(new ImageData(image.data, image.width, image.height));
      if (request.generation !== generation) {
        bitmap.close();
        return;
      }
      try {
        worker.postMessage({ kind: 'image', generation, id: request.id, bitmap, renderMs } satisfies WorkerResponse, [bitmap]);
      } catch (error) {
        bitmap.close();
        throw error;
      }
    })
    .catch(failed);
};

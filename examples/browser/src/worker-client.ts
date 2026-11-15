import type { Crs, SourceTile, Tile } from '@ml2drender/wasm';
import type { StyleSpecification } from 'maplibre-gl';
import type { WorkerRequest, WorkerResponse } from './render-worker';

type TileImage = Pick<Extract<WorkerResponse, { kind: 'image' }>, 'bitmap' | 'renderMs'>;
type SourceData = Pick<Extract<WorkerResponse, { kind: 'source' }>, 'data' | 'renderMs'>;

// Each worker's WASM memory stays at its peak (hundreds of MB for a dense style in a projected CRS), so touch
// devices, whose browsers kill a page sooner, get fewer.
const MAX_WORKERS = matchMedia('(pointer: coarse)').matches ? 2 : 4;
// Leave a core for the main thread and MapLibre's own workers.
const WORKER_COUNT = Math.min(MAX_WORKERS, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));

interface Slot {
  worker: Worker;
  /** Renders posted to this worker and not yet answered. */
  load: number;
  initializing?: { resolve: () => void; reject: (error: Error) => void };
}

/** Owns a pool of render workers so the map only deals with images and style changes. */
export class TileWorker {
  private readonly slots: Slot[] = Array.from({ length: WORKER_COUNT }, () => ({
    worker: new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' }),
    load: 0,
  }));
  private generation = 0;
  private nextId = 0;
  private readonly pending = new Map<number, { slot: Slot; resolve: (tile: TileImage | SourceData) => void; reject: (error: Error) => void }>();

  constructor() {
    for (const slot of this.slots) {
      slot.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.generation !== this.generation) {
          if (response.kind === 'image') response.bitmap.close();
          return;
        }
        if (response.kind === 'ready') {
          slot.initializing?.resolve();
          slot.initializing = undefined;
        } else if (response.kind === 'image') {
          const request = this.settle(response.id);
          if (request) request.resolve({ bitmap: response.bitmap, renderMs: response.renderMs });
          else response.bitmap.close();
        } else if (response.kind === 'source') {
          this.settle(response.id)?.resolve({ data: response.data, renderMs: response.renderMs });
        } else if (response.id === undefined) {
          slot.initializing?.reject(new Error(response.message));
          slot.initializing = undefined;
        } else {
          this.settle(response.id)?.reject(new Error(response.message));
        }
      };
      slot.worker.onerror = (event) => {
        const error = new Error(event.message);
        slot.initializing?.reject(error);
        slot.initializing = undefined;
        for (const [id, request] of this.pending) {
          if (request.slot !== slot) continue;
          request.reject(error);
          this.pending.delete(id);
        }
        slot.load = 0;
      };
    }
  }

  async init(style: StyleSpecification): Promise<void> {
    this.generation++;
    const replaced = new Error('Style changed');
    for (const request of this.pending.values()) request.reject(replaced);
    this.pending.clear();
    const generation = this.generation;
    await Promise.all(this.slots.map((slot) => {
      slot.initializing?.reject(replaced);
      slot.load = 0;
      return new Promise<void>((resolve, reject) => {
        slot.initializing = { resolve, reject };
        slot.worker.postMessage({ kind: 'init', generation, style } satisfies WorkerRequest);
      });
    }));
  }

  private settle(id: number) {
    const request = this.pending.get(id);
    this.pending.delete(id);
    if (request) request.slot.load--;
    return request;
  }

  /** A tile of the Web Mercator grid, or with `crs` of that CRS's grid. */
  render(tile: Tile, crs?: Crs): Promise<TileImage> {
    return this.request({ kind: 'render', tile, crs }) as Promise<TileImage>;
  }

  /** A tile of a source of the style in `crs` (see `ProjectedRenderer.getTile`). */
  getTile(tile: SourceTile, crs: Crs): Promise<SourceData> {
    return this.request({ kind: 'source', tile, crs }) as Promise<SourceData>;
  }

  /** Posts to the least loaded worker. */
  private request(body: { kind: 'render'; tile: Tile; crs?: Crs } | { kind: 'source'; tile: SourceTile; crs: Crs }): Promise<TileImage | SourceData> {
    const id = ++this.nextId;
    const slot = this.slots.reduce((least, candidate) => candidate.load < least.load ? candidate : least);
    slot.load++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { slot, resolve, reject });
      slot.worker.postMessage({ ...body, generation: this.generation, id } satisfies WorkerRequest);
    });
  }
}

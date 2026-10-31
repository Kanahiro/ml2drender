import type { View } from 'ml2drender';
import type { WorkerRequest, WorkerResponse } from './render-worker';

/** Owns the worker protocol so the map only deals with images and style changes. */
export class TileWorker {
  private readonly worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
  private generation = 0;
  private nextId = 0;
  private initializing?: { resolve: () => void; reject: (error: Error) => void };
  private readonly pending = new Map<number, { resolve: (image: ImageBitmap) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.generation !== this.generation) {
        if (response.kind === 'image') response.bitmap.close();
        return;
      }
      if (response.kind === 'ready') {
        this.initializing?.resolve();
        this.initializing = undefined;
      } else if (response.kind === 'image') {
        const request = this.pending.get(response.id);
        if (request) request.resolve(response.bitmap);
        else response.bitmap.close();
        this.pending.delete(response.id);
      } else if (response.id === undefined) {
        this.initializing?.reject(new Error(response.message));
        this.initializing = undefined;
      } else {
        this.pending.get(response.id)?.reject(new Error(response.message));
        this.pending.delete(response.id);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message);
      this.initializing?.reject(error);
      this.initializing = undefined;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  init(styleUrl: string): Promise<void> {
    this.generation++;
    const replaced = new Error('Style changed');
    this.initializing?.reject(replaced);
    for (const request of this.pending.values()) request.reject(replaced);
    this.pending.clear();
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      this.initializing = { resolve, reject };
      this.worker.postMessage({ kind: 'init', generation, styleUrl } satisfies WorkerRequest);
    });
  }

  render(view: View): Promise<ImageBitmap> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ kind: 'render', generation: this.generation, id, view } satisfies WorkerRequest);
    });
  }
}

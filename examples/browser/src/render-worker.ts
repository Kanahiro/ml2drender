/// <reference lib="webworker" />
import { MapRenderer, type View } from 'ml2drender';

export type WorkerRequest =
  | { kind: 'init'; generation: number; styleUrl: string }
  | { kind: 'render'; generation: number; id: number; view: View };

export type WorkerResponse =
  | { kind: 'ready'; generation: number }
  | { kind: 'image'; generation: number; id: number; width: number; height: number; data: ArrayBuffer }
  | { kind: 'error'; generation: number; id?: number; message: string };

let generation = 0;
let renderer: MapRenderer | undefined;
const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.kind === 'init') {
    generation = request.generation;
    renderer = undefined;
    void MapRenderer.init(request.styleUrl, { cache: { ttlMs: Infinity } })
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
  void active.render(request.view)
    .then((image) => {
      if (request.generation !== generation) return;
      const data = image.data.buffer as ArrayBuffer;
      worker.postMessage({ kind: 'image', generation, id: request.id, width: image.width, height: image.height, data } satisfies WorkerResponse, [data]);
    })
    .catch((error: unknown) => {
      if (request.generation === generation) {
        worker.postMessage({ kind: 'error', generation, id: request.id, message: String(error) } satisfies WorkerResponse);
      }
    });
};

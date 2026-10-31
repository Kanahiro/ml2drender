import { MapRenderer } from 'ml2drender';
import wasm from 'ml2drender/renderer.wasm';

interface Env {
  STYLE_URL: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    // Fetching belongs to the request context. The compiled module is shared, while
    // each request owns its renderer, WASM memory and resource cache.
    const renderer = await MapRenderer.init(env.STYLE_URL, { wasm });
    const png = await renderer.renderPng({
      center: [0, 0], zoom: 0, width: 512, height: 512, margin: 64,
    });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  },
};

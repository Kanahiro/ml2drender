import { defineConfig } from 'vite';

// Worker bundles as ES modules: the GL JS projection handler awaits its WASM at the top level.
// Relative base so the build works under a subpath (GitHub Pages: /<repo>/).
export default defineConfig({ base: './', worker: { format: 'es' } });

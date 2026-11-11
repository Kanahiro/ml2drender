import { defineConfig } from 'vite';

// Worker bundles as ES modules: the GL JS projection handler uses top-level await.
// Relative base so the build works under a subpath (GitHub Pages: /<repo>/).
export default defineConfig({ base: './', worker: { format: 'es' } });

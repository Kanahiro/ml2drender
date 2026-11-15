import { defineConfig } from 'vite';

// Worker bundles as ES modules: GL JS imports the projection handler as a module.
// Relative base so the build works under a subpath (GitHub Pages: /<repo>/).
export default defineConfig({ base: './', worker: { format: 'es' } });

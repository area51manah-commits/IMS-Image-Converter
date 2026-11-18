import { defineConfig } from 'vite';

// Static, serverless build. Everything (including the ImageMagick Wasm binary)
// is emitted as an asset that Cloudflare Pages can serve from its edge cache.
export default defineConfig({
  build: {
    target: 'es2022',
    // The 15 MB Wasm binary must stay a standalone, cacheable file.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});

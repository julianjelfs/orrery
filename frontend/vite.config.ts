import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    // The whole launcher opens from cache with the Pi out of reach. /api/ is never
    // cached: status is live or it is unknown.
    VitePWA({
      registerType: 'autoUpdate',
      // public/manifest.webmanifest is the manifest; index.html links it.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024
      }
    })
  ],
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8050' }
  },
  build: { chunkSizeWarningLimit: 1200 }
});

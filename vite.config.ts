import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  /*
   * Served from the domain root by default. A GitHub Pages project site lives
   * under /<repo>/, so the deploy sets BASE_PATH rather than hard-coding it.
   */
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /*
         * Routes are code-split (see src/modules/index.ts), so this only
         * pins the framework: React and the router change far less often
         * than the app, and giving them their own chunk means a release
         * invalidates the app bundle without making every user re-download
         * the framework.
         */
        manualChunks: (id: string) =>
          (id.includes('node_modules/react') || id.includes('node_modules/scheduler')
            ? 'vendor'
            : undefined),
      },
    },
  },
})

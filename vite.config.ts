import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  /*
   * Served from the domain root by default. A GitHub Pages project site lives
   * under /<repo>/, so the deploy sets BASE_PATH rather than hard-coding it.
   */
  base: process.env.BASE_PATH || '/',
  /*
   * Resolve by the path we were given, without asking the filesystem for the
   * real one.
   *
   * Vite 8 resolves through Rolldown's native resolver, which calls `realpath`
   * on each directory it walks. Every directory in this repo that OneDrive has
   * synced carries a stale `ReparsePoint` attribute — the bit is set while
   * `fsutil reparsepoint query` reports no reparse data at all — and that call
   * fails on them. The resolver then reports the import as missing.
   *
   * It fails for everything or nothing, which is what made it hard to read:
   * `npm run build` cannot resolve `./modules` from `src/App.tsx`, and every
   * frontend check dies on `react/jsx-runtime`, while `tsc`, `npm`, and the
   * server's `tsx` suites are all fine, because Node's own resolver does not
   * make that call. An otherwise identical project in a directory created
   * after OneDrive sync was paused resolves everything correctly, which is how
   * this was pinned down.
   *
   * Turning the `realpath` off costs nothing here: identity-by-real-path only
   * matters when a dependency is symlinked into `node_modules`, as `npm link`
   * or pnpm would do, and this project uses neither — `npm ci` writes a flat
   * tree of real directories. On a machine or CI runner where the attribute is
   * not set this line changes no resolution at all.
   *
   * It is a workaround for the filesystem, not for our code. Move the repo out
   * of OneDrive's namespace and it can go.
   */
  resolve: { preserveSymlinks: true },
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

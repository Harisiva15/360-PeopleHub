import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /*
         * React and the router change far less often than the app does, so
         * they get their own chunk — a release invalidates the app bundle
         * without making every user re-download the framework.
         *
         * Route-level splitting is the bigger win but is blocked on the
         * sidebar: it computes a pending-count badge for every module, so
         * every module has to be registered before the first paint. Moving
         * those badges to a single service call would unblock it.
         */
        manualChunks: (id: string) =>
          (id.includes('node_modules/react') || id.includes('node_modules/scheduler')
            ? 'vendor'
            : undefined),
      },
    },
  },
})

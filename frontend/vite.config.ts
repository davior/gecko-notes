import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // Ensure only one copy of each ProseMirror package ends up in the bundle.
    // Without this, Rollup includes duplicates and schema instanceof checks break.
    dedupe: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-transform',
      'prosemirror-schema-list',
      'prosemirror-commands',
      'prosemirror-keymap',
      'prosemirror-history',
      'prosemirror-inputrules',
      'prosemirror-tables',
      'prosemirror-dropcursor',
      'prosemirror-gapcursor',
      '@tiptap/core',
      '@tiptap/pm',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      // BlockNote/TipTap declare sideEffects:['*.css'] which lets Rollup
      // tree-shake their JS. That removes schema registrations and causes
      // ProseMirror's renderSpec to receive invalid arrays at runtime.
      treeshake: {
        moduleSideEffects: (id) =>
          id.includes('@blocknote') ||
          id.includes('@tiptap') ||
          id.includes('prosemirror'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})

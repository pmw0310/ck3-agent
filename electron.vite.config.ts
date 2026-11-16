import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const EXTERNAL_NATIVE_MODULES = [
  'better-sqlite3',
  'sqlite-vec',
  'jomini',
  '@huggingface/transformers',
  'onnxruntime-node',
  'node-stream-zip',
  'msedge-tts',
  'ws'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        external: EXTERNAL_NATIVE_MODULES
      }
    },
    worker: {
      rollupOptions: {
        external: EXTERNAL_NATIVE_MODULES
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src'),
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})

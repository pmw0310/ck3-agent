/// <reference types="vite/client" />
import type { Ck3Api } from '@shared/types'

declare module '*.png?inline' {
  const src: string
  export default src
}

declare global {
  interface Window {
    ck3Api: Ck3Api
  }
}

export {}

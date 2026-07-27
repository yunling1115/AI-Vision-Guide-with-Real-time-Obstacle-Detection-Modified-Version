/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY: string
  readonly VITE_GOOGLE_MAPS_API_KEY: string
  readonly VITE_ORS_API_KEY: string
  readonly VITE_BACKEND_WS_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
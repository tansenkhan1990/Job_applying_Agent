/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the API base URL (defaults to the Vite proxy at /api). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

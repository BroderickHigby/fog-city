// The part of Vite's import.meta.env the game reads (Vite replaces it at build time).
interface ImportMetaEnv {
  /** True in a production build (pnpm build), false on the dev server. */
  readonly PROD: boolean;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

/** The two variables `gameable/vite` defines. */
interface ImportMetaEnv {
  /** `direct` under `npm run dev`, `wasm` after `npm run build`. */
  readonly GAMEABLE_MODE: 'direct' | 'wasm';
  /** URL of the transpiled guest entry, used only in `wasm` mode. */
  readonly GAMEABLE_GUEST_URL: string;
}

interface ImportMeta {
  /** Vite's environment, plus the gameable additions. */
  readonly env: ImportMetaEnv;
}

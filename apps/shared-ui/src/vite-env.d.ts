/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Commit the bundle was built from, e.g. `2710db3` or `2710db3-dirty`. Set in vite.config.ts. */
  readonly VITE_BUILD_STAMP?: string;
}

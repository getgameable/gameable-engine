import type { BuildResult, Metafile } from 'esbuild';

/** The room server's entry, `src/serve/main.ts`. */
export declare const SERVER_ENTRY: string;

/** The build step that writes one game's server bundle, `src/serve/pack.ts`. */
export declare const PACK_ENTRY: string;

/** Bundle the room server; with `write`, Jolt's wasm is copied beside it. */
export declare function bundleServer(options: {
  outdir: string;
  write?: boolean;
  entry?: string;
  name?: string;
}): Promise<BuildResult & { metafile: Metafile }>;

/** Every three.js file that went into the bundle. */
export declare function threeInputs(metafile: Metafile): string[];

/** Non-node modules the bundle imports at startup. */
export declare function startupImports(metafile: Metafile): string[];

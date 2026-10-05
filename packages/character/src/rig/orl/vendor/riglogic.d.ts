// Types for the vendored emscripten glue. Hand-written: `riglogic.js` is a build
// artifact copied verbatim and must never be edited, so its surface is declared
// here instead.
//
// Only the embind exports this package calls are declared. Two of them are
// dangerous enough to restate at the type level:
//
//   getJointOutputs / getBlendShapeOutputs return ZERO-COPY VIEWS onto the wasm
//   heap. They are valid until the next `calculate()`, and the build links
//   `-sALLOW_MEMORY_GROWTH`, so a heap grow DETACHES every existing view
//   (`byteLength` 0) rather than relocating it. Copy anything you keep; never hold
//   one across calls.

/** The embind module instance. */
export interface RigLogicModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  loadDNAFromPath(path: string): boolean;
  guiControlNames(): string[];
  /** Absent on a wasm predating the raw-control exports. */
  rawControlNames?(): string[];
  setGUIControl(index: number, value: number): void;
  setRawControl(index: number, value: number): void;
  resetGUIControls(): void;
  mapGUIToRawControls(): void;
  calculate(): void;
  /** LIVE VIEW onto the wasm heap — see the header. */
  getJointOutputs(): Float32Array;
  /** LIVE VIEW onto the wasm heap — see the header. */
  getBlendShapeOutputs(): Float32Array;
  /** Copies, unlike the two above. Absent on an older wasm. */
  getRawControlValues?(): Float32Array;
  /** Absent on a wasm built before the joint-name export; the shells need it. */
  getJointName?(index: number): string;
}

/** Emscripten's module factory. */
export interface RigLogicModuleOptions {
  locateFile?: (path: string) => string;
}

declare function createRigLogicModule(options?: RigLogicModuleOptions): Promise<RigLogicModule>;

export default createRigLogicModule;

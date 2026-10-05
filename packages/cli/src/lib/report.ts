/**
 * `gameable build --report`: what the guest costs to ship and to run.
 *
 * Size is measured the way a CDN measures it — brotli at quality 11 — and speed
 * is measured by instantiating the real component in node and ticking it a
 * thousand times against `NullEngineAdapter`, which is exactly the boundary
 * without a renderer attached.
 *
 * The engine packages are loaded through **variable** specifiers on purpose.
 * The report runs the game's own `gameable/host`, and a bundler must not
 * inline either of them into the CLI.
 */
import { constants, brotliCompressSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** One measured build. */
export interface ReportNumbers {
  /** Size of `.gameable/game.wasm`. */
  readonly wasmBytes: number;
  /** Brotli-11 size of the same file. */
  readonly wasmBrotli: number;
  /** Total size of everything in `dist/guest`. */
  readonly guestBytes: number;
  /** Sum of the brotli-11 sizes of everything in `dist/guest`. */
  readonly guestBrotli: number;
  /** Milliseconds to import and instantiate the component the first time. */
  readonly coldInstantiateMs: number;
  /** Milliseconds to instantiate it again, with core modules already compiled. */
  readonly warmInstantiateMs: number;
  /** Number of ticks measured. */
  readonly ticks: number;
  /** Median tick, in milliseconds. */
  readonly tickP50: number;
  /** 99th-percentile tick, in milliseconds. */
  readonly tickP99: number;
}

/** The thresholds `--report` enforces unless `--no-gate` is passed. */
export interface ReportGates {
  /** Maximum acceptable 99th-percentile tick, in milliseconds. */
  readonly maxTickP99Ms: number;
  /** Maximum acceptable brotli size of the component, in bytes. */
  readonly maxWasmBrotliBytes: number;
}

/** What CI and the local build agree is acceptable. */
export const DEFAULT_GATES: ReportGates = {
  maxTickP99Ms: 1.5,
  maxWasmBrotliBytes: Math.round(0.8 * 1024 * 1024),
};

/**
 * Brotli-compress a buffer the way a static host would.
 *
 * @param bytes The file contents.
 * @returns The compressed size in bytes.
 */
export function brotliSize(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  }).byteLength;
}

/**
 * A percentile of an unsorted sample.
 *
 * @param samples The measurements.
 * @param fraction Percentile as a fraction, for example `0.99`.
 * @returns The sample at that percentile, or 0 when there are none.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

/**
 * Every gate the numbers failed.
 *
 * @param numbers A measured build.
 * @param gates The thresholds to apply.
 * @returns One human-readable line per failure; empty when everything passed.
 */
export function checkGates(numbers: ReportNumbers, gates: ReportGates): string[] {
  const failures: string[] = [];
  if (numbers.tickP99 > gates.maxTickP99Ms) {
    failures.push(
      `tick p99 ${numbers.tickP99.toFixed(3)} ms exceeds the ${gates.maxTickP99Ms.toFixed(
        2,
      )} ms budget`,
    );
  }
  if (numbers.wasmBrotli > gates.maxWasmBrotliBytes) {
    failures.push(
      `component brotli ${formatBytes(numbers.wasmBrotli)} exceeds the ${formatBytes(
        gates.maxWasmBrotliBytes,
      )} budget`,
    );
  }
  return failures;
}

/**
 * Format a byte count for the report table.
 *
 * @param bytes A size.
 * @returns A short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${String(bytes)} B`;
}

/**
 * Render the report as plain text.
 *
 * @param numbers A measured build.
 * @param gates The thresholds the numbers were checked against.
 * @returns The report body, without a trailing newline.
 */
export function formatReport(numbers: ReportNumbers, gates: ReportGates): string {
  const rows: [string, string][] = [
    ['component', `${formatBytes(numbers.wasmBytes)} raw`],
    [
      'component brotli',
      `${formatBytes(numbers.wasmBrotli)}  (budget ${formatBytes(gates.maxWasmBrotliBytes)})`,
    ],
    ['dist/guest', `${formatBytes(numbers.guestBytes)} raw`],
    ['dist/guest brotli', formatBytes(numbers.guestBrotli)],
    ['instantiate cold', `${numbers.coldInstantiateMs.toFixed(1)} ms`],
    ['instantiate warm', `${numbers.warmInstantiateMs.toFixed(1)} ms`],
    [`tick p50 (${String(numbers.ticks)})`, `${numbers.tickP50.toFixed(3)} ms`],
    ['tick p99', `${numbers.tickP99.toFixed(3)} ms  (budget ${gates.maxTickP99Ms.toFixed(2)} ms)`],
  ];
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}

/** The bits of `@gameable/wasm-host` the report calls. */
interface WasmHostModule {
  createSandbox(options: Record<string, unknown>): Promise<SandboxLike>;
  NullEngineAdapter(): unknown;
  applyOutput(adapter: unknown, output: unknown): void;
}

/** The bits of `@gameable/test-harness` the report calls. */
interface TestHarnessModule {
  createMockHost(options?: Record<string, unknown>): Record<string, unknown>;
  createFrameInput(overrides?: Record<string, unknown>): unknown;
  createGameConfig(overrides?: Record<string, unknown>): unknown;
}

/**
 * Has the sandbox latched dead?
 *
 * Read through a function so TypeScript does not narrow `dead` to `false` for
 * the rest of the loop: a tick can flip it at any point.
 *
 * @param sandbox The sandbox to ask.
 * @returns True once the guest has trapped.
 */
function isDead(sandbox: SandboxLike): boolean {
  return sandbox.dead;
}

/** The sandbox surface the report drives. */
interface SandboxLike {
  init(config: unknown): void;
  tick(input: unknown): unknown;
  shutdown(): void;
  readonly dead: boolean;
  readonly error: Error | null;
}

/**
 * Load the engine packages at runtime.
 *
 * The specifiers are held in variables so neither TypeScript nor rolldown tries
 * to resolve them at build time: the CLI is a tool, not a consumer of the
 * engine's types.
 *
 * @returns The two modules the report needs.
 * @throws {Error} When the optional test harness is not installed.
 */
async function loadEngine(): Promise<{ host: WasmHostModule; harness: TestHarnessModule }> {
  const hostSpecifier = 'gameable/host';
  const harnessSpecifier = 'gameable/test';
  const host = (await import(hostSpecifier)) as WasmHostModule;
  let harness: TestHarnessModule;
  try {
    // `gameable/test` is an optional dependency: it is a test-time
    // package, and only `gameable build --report` ever asks for it.
    harness = (await import(harnessSpecifier)) as TestHarnessModule;
  } catch (cause) {
    throw new Error(
      `--report needs ${harnessSpecifier}; install it as a devDependency of this project`,
      { cause },
    );
  }
  return { host, harness };
}

/** Where {@link measure} should look. */
export interface MeasureOptions {
  /** The component, before transpile. */
  readonly wasmPath: string;
  /** The transpiled guest directory. */
  readonly guestDir: string;
  /** Number of ticks to time. Defaults to 1000. */
  readonly ticks?: number;
}

/**
 * Measure a finished build.
 *
 * @param options Where the component and the transpiled guest are.
 * @returns Sizes and timings.
 * @throws {Error} When the component cannot be instantiated in node.
 */
export async function measure(options: MeasureOptions): Promise<ReportNumbers> {
  const ticks = options.ticks ?? 1000;
  const wasmBuffer = readFileSync(options.wasmPath);
  const wasmBytes = wasmBuffer.byteLength;
  const wasmBrotli = brotliSize(wasmBuffer);

  let guestBytes = 0;
  let guestBrotli = 0;
  for (const name of readdirSync(options.guestDir)) {
    const path = `${options.guestDir}/${name}`;
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    guestBytes += bytes.byteLength;
    guestBrotli += brotliSize(bytes);
  }

  const { host, harness } = await loadEngine();
  // The report times whatever guest it is handed, so it cannot know that
  // guest's manifest: it mints a handle for every name the guest asks for.
  const mockHost = harness.createMockHost({
    seed: 0xa05e,
    nowMs: () => 0,
    strictAssets: false,
  });
  const guestEntry = `${options.guestDir}/game.js`;
  if (!existsSync(guestEntry)) {
    throw new Error(`transpiled guest not found: ${guestEntry}`);
  }

  const compiled = new Map<string, Promise<WebAssembly.Module>>();
  /**
   * Compile one core module, caching the result for the warm run.
   *
   * @param path Relative path jco asks for.
   * @returns The compiled module.
   */
  const getCoreModule = (path: string): Promise<WebAssembly.Module> => {
    let pending = compiled.get(path);
    if (pending === undefined) {
      pending = WebAssembly.compile(readFileSync(`${options.guestDir}/${path}`));
      compiled.set(path, pending);
    }
    return pending;
  };

  const coldStart = performance.now();
  const cold = await host.createSandbox({
    mode: 'wasm',
    guestModuleUrl: pathToFileURL(guestEntry).href,
    getCoreModule,
    host: mockHost,
  });
  const coldInstantiateMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const warm = await host.createSandbox({
    mode: 'wasm',
    guestModuleUrl: pathToFileURL(guestEntry).href,
    getCoreModule,
    host: mockHost,
  });
  const warmInstantiateMs = performance.now() - warmStart;
  warm.shutdown();

  const adapter = host.NullEngineAdapter();
  cold.init(harness.createGameConfig({}));
  if (isDead(cold)) throw cold.error ?? new Error('the guest died during init');

  const samples: number[] = [];
  for (let frame = 0; frame < ticks; frame += 1) {
    const input = harness.createFrameInput({ frame });
    const started = performance.now();
    const output = cold.tick(input);
    samples.push(performance.now() - started);
    host.applyOutput(adapter, output);
    if (isDead(cold)) throw cold.error ?? new Error(`the guest died on frame ${String(frame)}`);
  }
  cold.shutdown();

  return {
    wasmBytes,
    wasmBrotli,
    guestBytes,
    guestBrotli,
    coldInstantiateMs,
    warmInstantiateMs,
    ticks,
    tickP50: percentile(samples, 0.5),
    tickP99: percentile(samples, 0.99),
  };
}

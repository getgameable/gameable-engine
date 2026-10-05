#!/usr/bin/env node
/**
 * Build the Rust guest component.
 *
 * Two steps, not three. Unlike the TypeScript guest there is no `componentize`
 * pass and no generated entry module: `rustc` targeting `wasm32-wasip2` links
 * through `wasm-component-ld`, which wraps the core module into a component by
 * itself.
 *
 * 1. **cargo.** `cargo build --release --target wasm32-wasip2` emits
 *    `target/wasm32-wasip2/release/aos_guest_rust.wasm`. The script then
 *    verifies that the file really is a component — `wasm-tools component wit`
 *    when `wasm-tools` is on PATH, otherwise the 8-byte component preamble,
 *    which is `00 61 73 6d 0d 00 01 00` rather than a core module's
 *    `00 61 73 6d 01 00 00 00`.
 * 2. **transpile.** `jco transpile --instantiation async --no-nodejs-compat`,
 *    the identical flags `fixtures/tiny-game/scripts/build.mjs` uses, into
 *    `dist/guest/`. The host cannot tell the two guests apart afterwards.
 *
 * Usage:
 *   node examples/wasm-guest-rust/build.mjs           build when stale
 *   node examples/wasm-guest-rust/build.mjs --force   always rebuild
 *   node examples/wasm-guest-rust/build.mjs --quiet   only report on failure
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

/** Absolute, forward-slashed path to `examples/wasm-guest-rust`. */
export const CRATE = fileURLToPath(new URL('./', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
/** Absolute, forward-slashed repository root. */
export const ROOT = CRATE.slice(0, CRATE.lastIndexOf('/examples/'));
/** The wasm32-wasip2 target triple this guest is built for. */
export const TARGET = 'wasm32-wasip2';
/** The component cargo emits. */
export const COMPONENT = `${CRATE}/target/${TARGET}/release/aos_guest_rust.wasm`;
/** Where the transpiled guest lands. Gitignored. */
export const GUEST_DIR = `${CRATE}/dist/guest`;
/** The module with the `instantiate` export. */
export const GUEST_ENTRY = `${GUEST_DIR}/game.js`;
/** The authored WIT package, read by `wit_bindgen::generate!`. */
const WIT = `${ROOT}/wit`;
/** jco's entry point, from the repository's own install. */
const JCO = `${ROOT}/node_modules/@bytecodealliance/jco/dist/jco.js`;
/** Everything whose mtime decides whether the build is stale. */
const SOURCES = [`${CRATE}/src`, `${CRATE}/Cargo.toml`, `${CRATE}/build.mjs`, WIT];
/** Windows needs the extension: `CreateProcess` does not consult `PATHEXT`. */
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Newest mtime under a path, recursively.
 *
 * @param {string} path Absolute file or directory.
 * @returns {number} Milliseconds since the epoch, or 0 when absent.
 */
function newest(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'dist' || entry.name === 'node_modules') continue;
    max = Math.max(max, newest(join(path, entry.name).replaceAll('\\', '/')));
  }
  return max;
}

/**
 * Run a command, capturing everything.
 *
 * @param {string} cmd Executable name or absolute path.
 * @param {string[]} args Arguments, one per array entry.
 * @param {string} [cwd] Working directory.
 * @returns {{ ok: boolean, status: number, stdout: string, stderr: string }} The result.
 */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/**
 * What of the Rust toolchain is actually present.
 *
 * The boundary test calls this to decide between running and skipping with a
 * message, so it never throws.
 *
 * @returns {{ ok: boolean, reason: string, cargo: string }} Toolchain status.
 */
export function checkToolchain() {
  const cargo = run(`cargo${EXE}`, ['--version']);
  if (!cargo.ok) {
    return {
      ok: false,
      reason: 'cargo is not on PATH (install Rust from https://rustup.rs)',
      cargo: '',
    };
  }
  const version = cargo.stdout.trim();

  // `rustup` is how the target gets installed, so ask it when it is there. A
  // cargo without rustup (a distro package, say) cannot be interrogated this
  // way; assume the target is present and let the build fail loudly instead.
  const targets = run(`rustup${EXE}`, ['target', 'list', '--installed']);
  if (targets.ok && !targets.stdout.split(/\r?\n/).includes(TARGET)) {
    return {
      ok: false,
      reason: `the ${TARGET} target is not installed (run \`rustup target add ${TARGET}\`)`,
      cargo: version,
    };
  }
  return { ok: true, reason: '', cargo: version };
}

/**
 * Assert that a file is a WebAssembly **component**, not a core module.
 *
 * `wasm-tools component wit` is the authoritative check and prints the world
 * as a bonus; without it, the 8-byte preamble is enough. A core module is
 * `00 61 73 6d 01 00 00 00`; a component carries layer 1 and reads
 * `00 61 73 6d 0d 00 01 00`.
 *
 * @param {string} path Absolute path to the wasm file.
 * @param {boolean} quiet Suppress the informational line.
 * @returns {string} How the file was verified.
 */
export function assertComponent(path, quiet = false) {
  const head = readFileSync(path).subarray(0, 8);
  const magic = [...head.subarray(0, 4)];
  if (magic.join() !== [0x00, 0x61, 0x73, 0x6d].join()) {
    throw new Error(`${path} is not a wasm file`);
  }
  if (head[6] !== 0x01) {
    throw new Error(
      `${path} is a core module (layer ${String(head[6])}), not a component; ` +
        `build with --target ${TARGET}`,
    );
  }

  const tools = run(`wasm-tools${EXE}`, ['component', 'wit', path]);
  if (tools.ok) {
    const world = /world\s+([a-z0-9-]+)/.exec(tools.stdout)?.[1] ?? 'unknown';
    if (!quiet) console.log(`rust-guest: component verified by wasm-tools (world ${world})`);
    return 'wasm-tools';
  }
  if (!quiet) {
    console.log(
      'rust-guest: component verified by preamble (install wasm-tools for the full check)',
    );
  }
  return 'preamble';
}

/**
 * Human-readable byte count.
 *
 * @param {number} bytes A size.
 * @returns {string} e.g. `106.8 KiB`.
 */
export function fmt(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Brotli size of a file, at the quality a CDN would use.
 *
 * @param {string} path Absolute path.
 * @returns {number} Compressed bytes.
 */
function brotli(path) {
  return brotliCompressSync(readFileSync(path), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;
}

/**
 * Build the guest if anything changed.
 *
 * @param {{ force?: boolean, quiet?: boolean }} options Build options.
 * @returns {{ built: boolean, guestEntry: string, guestDir: string, component: string }} What happened.
 */
export function buildRustGuest(options = {}) {
  const quiet = options.quiet ?? false;
  const builtAt = newest(GUEST_ENTRY);
  let sourceAt = 0;
  for (const path of SOURCES) sourceAt = Math.max(sourceAt, newest(path));

  if (!options.force && builtAt > 0 && builtAt >= sourceAt) {
    if (!quiet) console.log('rust-guest: up to date');
    return { built: false, guestEntry: GUEST_ENTRY, guestDir: GUEST_DIR, component: COMPONENT };
  }

  const toolchain = checkToolchain();
  if (!toolchain.ok) throw new Error(`rust-guest: ${toolchain.reason}`);

  if (!quiet) console.log(`rust-guest: cargo build (${toolchain.cargo})`);
  const cargo = run(`cargo${EXE}`, ['build', '--release', '--target', TARGET], CRATE);
  if (!cargo.ok) {
    process.stderr.write(cargo.stdout);
    process.stderr.write(cargo.stderr);
    throw new Error(`cargo build failed with status ${String(cargo.status)}`);
  }
  if (!quiet && cargo.stderr.includes('warning')) process.stderr.write(cargo.stderr);

  assertComponent(COMPONENT, quiet);

  if (!quiet) console.log('rust-guest: transpile');
  const jco = run(process.execPath, [
    JCO,
    'transpile',
    COMPONENT,
    '--instantiation',
    'async',
    '--no-nodejs-compat',
    '--name',
    'game',
    '-o',
    GUEST_DIR,
    '--quiet',
  ]);
  if (!jco.ok) {
    process.stderr.write(jco.stdout);
    process.stderr.write(jco.stderr);
    throw new Error(`jco transpile failed with status ${String(jco.status)}`);
  }

  if (!quiet) {
    const raw = statSync(COMPONENT).size;
    let coreRaw = 0;
    let coreBr = 0;
    for (const name of readdirSync(GUEST_DIR)) {
      if (!name.endsWith('.wasm')) continue;
      coreRaw += statSync(`${GUEST_DIR}/${name}`).size;
      coreBr += brotli(`${GUEST_DIR}/${name}`);
    }
    const js = statSync(GUEST_ENTRY).size;
    console.log(
      `rust-guest: component  ${fmt(raw).padStart(10)}  brotli ${fmt(brotli(COMPONENT))}`,
    );
    console.log(`rust-guest: core wasm  ${fmt(coreRaw).padStart(10)}  brotli ${fmt(coreBr)}`);
    console.log(
      `rust-guest: game.js    ${fmt(js).padStart(10)}  brotli ${fmt(brotli(GUEST_ENTRY))}`,
    );
  }
  return { built: true, guestEntry: GUEST_ENTRY, guestDir: GUEST_DIR, component: COMPONENT };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].replaceAll('\\', '/').endsWith('examples/wasm-guest-rust/build.mjs');

if (invokedDirectly) {
  buildRustGuest({
    force: process.argv.includes('--force'),
    quiet: process.argv.includes('--quiet'),
  });
}

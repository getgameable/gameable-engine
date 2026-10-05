// `gameable/character/aosrig` must not reach onnxruntime-web or the RigLogic wasm: an app that
// bundles it (every gameable/three app) would get both wasm files in its build.
// Walks the static imports from src/aosrig.ts.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every module reachable from `entry` by static imports and re-exports, and the bare packages.
 *
 * @param entry A source file.
 * @returns The files and the bare specifiers.
 */
function reach(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  // (a type-only import or export is left out: it is erased and bundles nothing)
  const fromClause = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/g;
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...[...text.matchAll(fromClause)].map((m) => m[1]),
      ...[...text.matchAll(sideEffect)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      if (spec.startsWith('.')) todo.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

describe('@gameable/character/aosrig', () => {
  it('reaches neither onnxruntime-web nor the RigLogic wasm', () => {
    const { files, bare } = reach(join(here, 'aosrig.ts'));
    expect([...bare].filter((s) => s.startsWith('onnxruntime-web'))).toEqual([]);
    // (relative and with `/`, so the checks below hold on Windows as well)
    const names = [...files].map((f) => relative(here, f).split(sep).join('/'));
    expect(names.filter((f) => f === 'ort.ts' || f.startsWith('rig/orl/'))).toEqual([]);
    expect(names).toContain('aosrigSplat/runtime.ts');
  });
});

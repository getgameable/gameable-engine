#!/usr/bin/env node
/** Import an extracted Gameable studio export ZIP, preserving its files and notices. */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('../public/characters/greeter/', import.meta.url));
const checkOnly = process.argv[2] === '--check';

try {
  if (process.argv.length !== 3) {
    throw new Error(
      'Usage: npm run import:character -w examples/wasm-hello -- /path/to/extracted-character (or --check to verify the bundled demo)',
    );
  }
  const source = await realpath(checkOnly ? destination : resolve(process.argv[2]));
  const descriptor = JSON.parse(await readFile(resolve(source, 'character.json'), 'utf8'));
  if (descriptor.format !== 'aosrig-splat' || descriptor.version !== 1) {
    throw new Error(
      'Expected a Gameable studio aosrig-splat v1 character.json. Extract the complete Export ZIP first.',
    );
  }
  // Check all descriptor references before changing the installed character.
  for (const name of ['character.ply', 'rig.glb', 'head.aosrig', 'bindings.bin']) {
    if (!descriptor.files?.[name]) throw new Error(`Export is missing ${name}`);
  }
  for (const [name, entry] of Object.entries(descriptor.files)) {
    if (typeof entry.src !== 'string' || isAbsolute(entry.src))
      throw new Error(`Invalid path for ${name}`);
    const file = await realpath(resolve(source, entry.src));
    const local = relative(source, file);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error(`File outside export: ${name}`);
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Hash mismatch for ${name}; extract a fresh export before importing.`);
    }
  }
  await readFile(resolve(source, 'NOTICE.md'));
  if (!checkOnly) {
    await mkdir(destination, { recursive: true });
    if (source !== (await realpath(destination))) {
      await cp(source, destination, { recursive: true });
    }
  }
  console.log(
    `${checkOnly ? 'Verified' : 'Imported'} ${descriptor.splatCount} splats in ${destination}`,
  );
  if (!checkOnly)
    console.log('Run npm run dev -w examples/wasm-hello and open http://localhost:5180.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

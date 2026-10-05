/**
 * `writeServerBundle(gameDir)` — the part of a multiplayer game's build a
 * room server reads: `dist/server/game.json` (see `serve/serverGame.ts`),
 * the manifest with each collider `src` pointed at a copy in
 * `dist/server/colliders/`, and those copies. `gameable build` calls it
 * after the site build when the game declares `features.multiplayer`.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { roomSeats, roomSendHz } from '@gameable/sdk';

import { gameNameOf } from '../serve/gameName.js';
import { loadGameModule } from '../serve/gameModule.js';
import { mapColliderFiles, readRawManifest } from '../serve/manifestFiles.js';
import {
  COLLIDERS_DIR,
  GAME_JSON,
  SERVER_DIR,
  SERVER_MANIFEST,
  type ServerGameJson,
  uniqueColliderFile,
} from '../serve/serverGame.js';

/** Where {@link writeServerBundle} writes. */
export interface ServerBundleOptions {
  /** The game's `dist/`. Default `<gameDir>/dist`. */
  readonly distDir?: string;
}

/**
 * @param gameDir The game's directory.
 * @param options Where to write.
 * @returns True when the bundle was written; false (and nothing written) for a game without `features.multiplayer`.
 * @throws {Error} When the game cannot be loaded, its seats or send rate are bad, or a collider file is missing.
 */
export async function writeServerBundle(gameDir: string, options: ServerBundleOptions = {}): Promise<boolean> {
  const { definition, physics } = await loadGameModule(gameDir);
  const maxPlayers = roomSeats(definition);
  if (maxPlayers === undefined) return false;
  const serverDir = `${options.distDir ?? `${gameDir}/dist`}/${SERVER_DIR}`;
  rmSync(serverDir, { recursive: true, force: true });
  mkdirSync(`${serverDir}/${COLLIDERS_DIR}`, { recursive: true });
  const json: ServerGameJson = {
    name: gameNameOf(gameDir),
    features: definition.features ?? {},
    world: definition.world ?? {},
    physics,
    maxPlayers,
    sendHz: roomSendHz(definition),
  };
  writeFileSync(`${serverDir}/${GAME_JSON}`, `${JSON.stringify(json, null, 2)}\n`);
  const raw = readRawManifest(gameDir);
  if (raw !== undefined) {
    const used = new Set<string>();
    const manifest = mapColliderFiles(raw, gameDir, (entry, path) => {
      const file = `${COLLIDERS_DIR}/${uniqueColliderFile(entry.id, used)}`;
      copyFileSync(path, `${serverDir}/${file}`);
      return file;
    });
    writeFileSync(`${serverDir}/${SERVER_MANIFEST}`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return true;
}

/**
 * The tiny game declaring two seats (`features.multiplayer.maxPlayers: 2`),
 * for the boundary test that a room built from the wasm guest seats exactly
 * two. Declaring `multiplayer` also makes the bare systems authority-only.
 */
import { defineGame } from 'gameable';

import game from './game';

export default defineGame({ ...game, features: { multiplayer: { maxPlayers: 2 } } });

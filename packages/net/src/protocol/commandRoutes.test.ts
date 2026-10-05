import { describe, expect, it } from 'vitest';

import { TAG_ORDINAL, type Command, type CommandTag } from '@gameable/sdk';

import { LOCAL_SOUND_BASE, LocalIds } from '../client/LocalIds.js';
import { copyTransient } from '../server/room/oneShotCommands.js';
import { COMMAND_ROUTES } from './commandRoutes.js';

/** The client guest's entity range starts past this. */
const BASE = 1000;

/**
 * One command of a tag, with every id field a route might shift set.
 *
 * @param tag The tag.
 * @returns A command whose entity is 5, sound 7 and camera follow 5.
 */
function sample(tag: CommandTag): Command {
  if (tag === 'despawn') return { tag, val: 5 };
  const zero = { x: 0, y: 0, z: 0 };
  return {
    tag,
    val: {
      entity: 5,
      sound: 7,
      parent: undefined,
      position: zero,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: zero,
      camera: { follow: 5, position: zero, rotation: { x: 0, y: 0, z: 0, w: 1 }, offset: zero },
    },
  } as unknown as Command;
}

const TAGS = Object.keys(TAG_ORDINAL) as CommandTag[];

describe('COMMAND_ROUTES', () => {
  it('names every WIT command, and nothing else', () => {
    expect(Object.keys(COMMAND_ROUTES).sort()).toEqual([...TAGS].sort());
  });

  it.each(TAGS)(
    '%s: the replicator forwards it as a one-shot exactly when its route is transient',
    (tag) => {
      const copied = copyTransient(sample(tag));
      expect(copied !== null, `copyTransient(${tag})`).toBe(
        COMMAND_ROUTES[tag].wire === 'transient',
      );
    },
  );

  it.each(TAGS)("%s: LocalIds does with a client guest's copy what its route says", (tag) => {
    const ids = new LocalIds(BASE);
    ids.begin();
    const command = sample(tag);
    const mapped = ids.map(command);
    const route = COMMAND_ROUTES[tag].client;
    if (route === 'drop') {
      expect(mapped).toBeNull();
    } else if (route === 'pass') {
      expect(mapped).toBe(command);
    } else {
      expect(mapped).not.toBe(command);
      const val = (mapped as { val: unknown }).val as Record<string, unknown> | number;
      const shifted =
        typeof val === 'number'
          ? val === BASE + 5
          : val.entity === BASE + 5 ||
            val.sound === LOCAL_SOUND_BASE + 7 ||
            (val.camera as { follow?: number } | undefined)?.follow === BASE + 5;
      expect(shifted, `${tag} shifted an id`).toBe(true);
    }
  });
});

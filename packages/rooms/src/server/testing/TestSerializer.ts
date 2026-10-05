/**
 * `TestSerializer` — the `@colyseus/sdk` side of `GameableSerializer`, for tests:
 * every `ROOM_STATE` (our welcome) and `ROOM_STATE_PATCH` (our rows and text
 * frames) arrives with Colyseus's one byte already read, and goes to a
 * {@link TestReplica} untouched. Task 3.9's `GameableClientSerializer` is the real one.
 *
 * The SDK builds a serializer itself (no arguments) when JOIN_ROOM names our
 * id, so the replica is attached after the join; earlier frames wait in a queue.
 */
import { registerSerializer } from '@colyseus/sdk';

import { SERIALIZER_ID, TEXT_FIRST_BYTE } from '../../channels.js';
import type { TestReplica } from './TestReplica.js';

interface Iterator {
  offset: number;
}

/** The SDK serializer for our frames, in tests. */
export class TestSerializer {
  private replica: TestReplica | null = null;
  private readonly early: ((replica: TestReplica) => void)[] = [];
  private readonly decoder = new TextDecoder();

  /** @param replica Receives every frame from now on, after any queued ones. */
  attach(replica: TestReplica): void {
    this.replica = replica;
    for (const deliver of this.early.splice(0)) deliver(replica);
  }

  setState(data: Uint8Array, it?: Iterator): void {
    const text = this.decoder.decode(data.subarray(it?.offset ?? 1));
    this.deliver((r) => {
      r.welcome(text);
    });
  }

  patch(data: Uint8Array, it?: Iterator): void {
    const body = data.subarray(it?.offset ?? 1);
    if (body[0] === TEXT_FIRST_BYTE) {
      const text = this.decoder.decode(body);
      this.deliver((r) => {
        r.text(text);
      });
    } else {
      const copy = body.slice();
      this.deliver((r) => {
        r.rows(copy);
      });
    }
  }

  getState(): undefined {
    return undefined;
  }

  teardown(): void {
    this.replica = null;
  }

  private deliver(fn: (replica: TestReplica) => void): void {
    if (this.replica !== null) fn(this.replica);
    else this.early.push(fn);
  }
}

registerSerializer(SERIALIZER_ID, TestSerializer);

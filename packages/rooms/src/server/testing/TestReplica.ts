/**
 * `TestReplica` — what one test client knows of a room, built only from our
 * own frames decoded by our own codecs: the welcome, `cmd`, `players`, `msg`,
 * `error` and rows. Tests only; the real client is Task 3.9's.
 */
import {
  createRowsCodec,
  parseServerText,
  type PlayerSummary,
  type RowSink,
  type ServerText,
} from '@gameable/net';

/** The fields of a welcome snapshot the replica reads. */
interface Snapshot {
  entities: { entity: number; name?: string; position: number[] }[];
}

type Cmd = Extract<ServerText, { t: 'cmd' }>;

/** One client's view of the replicated world. */
export class TestReplica {
  /** Our player id, from the latest welcome. */
  player = -1;
  /** Our entity, from the latest welcome or `cmd`; 0 for none. */
  entity = 0;
  /** The entity the latest welcome itself named. */
  welcomeEntity = 0;
  /** The latest welcome's snapshot, as parsed. */
  snapshot: unknown = null;
  /** Every entity a `cmd` frame named as ours. */
  readonly cmdEntities = new Set<number>();
  /** Every entity a rows frame carried. */
  readonly rowEntities = new Set<number>();
  /** How many welcomes arrived (1 per join, +1 per reconnect). */
  welcomes = 0;
  /** Entity id to xyz, metres. */
  readonly entities = new Map<number, Float32Array>();
  /** Each entity's prefab name, from the welcome or its `spawn`. */
  readonly names = new Map<number, string>();
  /** Every command every `cmd` carried, in order. */
  readonly commands: Cmd['commands'][number][] = [];
  /** Every entity a `cmd` despawned, in order. */
  readonly despawned: number[] = [];
  players: PlayerSummary[] = [];
  /** The newest `cmd` ack. */
  ack = 0;
  /** Messages and errors received, newest last. */
  readonly messages: { name: string; payload: unknown }[] = [];
  readonly errors: { code: string; detail?: string }[] = [];
  /** Counts of what arrived. */
  readonly counts = { cmd: 0, rows: 0, pong: 0, bad: 0 };

  private rowsFrame = -1;
  private readonly codec = createRowsCodec();
  private readonly sink: RowSink = {
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row: (entity) => {
      this.rowEntities.add(entity);
      let p = this.entities.get(entity);
      if (p === undefined) {
        p = new Float32Array(3);
        this.entities.set(entity, p);
      }
      p.set(this.sink.position);
    },
  };

  /** @param text Our `welcome` text frame. */
  welcome(text: string): void {
    const frame = parseServerText(text);
    if (frame?.t !== 'welcome') {
      this.counts.bad += 1;
      return;
    }
    this.player = frame.player;
    this.entity = frame.entity;
    this.welcomeEntity = frame.entity;
    this.snapshot = frame.snapshot;
    this.players = frame.players;
    this.entities.clear();
    this.names.clear();
    for (const e of (frame.snapshot as Snapshot).entities) {
      this.entities.set(e.entity, Float32Array.from(e.position));
      if (e.name !== undefined) this.names.set(e.entity, e.name);
    }
    this.rowsFrame = -1;
    this.welcomes += 1;
  }

  /** @param text One of our server text frames. */
  text(text: string): void {
    const frame = parseServerText(text);
    if (frame === null) this.counts.bad += 1;
    else if (frame.t === 'cmd') this.cmd(frame);
    else if (frame.t === 'players') this.players = frame.players;
    else if (frame.t === 'msg') this.messages.push({ name: frame.name, payload: frame.payload });
    else if (frame.t === 'pong') this.counts.pong += 1;
    else if (frame.t === 'error') this.errors.push({ code: frame.code, detail: frame.detail });
  }

  /** @param bytes One of our rows frames; read during the call. */
  rows(bytes: Uint8Array): void {
    const frame =
      bytes.length >= 5 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true) : -1;
    if (frame <= this.rowsFrame) return;
    if (this.codec.decode(bytes, this.sink) === null) {
      this.counts.bad += 1;
      return;
    }
    this.rowsFrame = frame;
    this.counts.rows += 1;
  }

  /**
   * @param entity An entity.
   * @returns Its xyz as this client replicated it.
   */
  seen(entity: number): Float32Array {
    const p = this.entities.get(entity);
    if (p === undefined) throw new Error(`entity ${String(entity)} not replicated`);
    return p;
  }

  private cmd(frame: Cmd): void {
    this.ack = frame.ack;
    this.entity = frame.entity;
    this.cmdEntities.add(frame.entity);
    this.counts.cmd += 1;
    for (const c of frame.commands) {
      this.commands.push(c);
      if (c.tag === 'despawn') {
        this.entities.delete(c.val);
        this.names.delete(c.val);
        this.despawned.push(c.val);
      } else if (c.tag === 'spawn') {
        const { x, y, z } = c.val.position;
        this.entities.set(c.val.entity, Float32Array.of(x, y, z));
        if (c.val.name !== undefined) this.names.set(c.val.entity, c.val.name);
      }
    }
  }
}

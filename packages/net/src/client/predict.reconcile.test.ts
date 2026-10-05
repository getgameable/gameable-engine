/**
 * Task 8.3: reconciliation. A scripted server runs the walker's body in its
 * own Jolt world from the same moves and answers each seq twelve steps
 * later (200 ms), the way a 100 ms link each way would.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PlayerRowFlag } from '../protocol/constants.js';
import { PredictPage, TruthServer } from './scriptedAuthority.js';

/** Steps between a seq and its trailer reaching the page. */
const LAG = 12;

let page: PredictPage | null = null;
let server: TruthServer | null = null;

afterEach(async () => {
  await page?.close();
  server?.dispose();
  page = null;
  server = null;
});

/** What a run does at each step: before the page's step, after the server's. */
interface Script {
  walkFrom?: number;
  /** Before the server's step of this seq. */
  at?: Record<number, (truth: TruthServer) => void>;
  steps: number;
}

/**
 * Run the page and the scripted server side by side.
 *
 * @param script When W goes down, what the server does by hand, and how long.
 * @returns For each seq, the page's drawn position at its step and the server's truth.
 */
async function run(
  script: Script,
): Promise<{ drawn: Map<number, number[]>; truth: TruthServer; page: PredictPage }> {
  page = await PredictPage.open();
  server = await TruthServer.create();
  const drawn = new Map<number, number[]>();
  for (let seq = 1; seq <= script.steps; seq += 1) {
    if (seq === script.walkFrom) page.input.hold('W');
    page.frame();
    drawn.set(seq, page.drawn());
    script.at?.[seq]?.(server);
    server.step(seq, seq >= (script.walkFrom ?? Infinity));
    if (seq - LAG >= 1) page.net.pushFrame(server.frame(seq, seq - LAG));
  }
  return { drawn, truth: server, page };
}

/**
 * @param a A position.
 * @param b Another.
 * @returns The distance.
 */
const gap = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('reconciliation', () => {
  it('an honest server: no correction, and the page draws what the server will say', async () => {
    const { drawn, truth, page: p } = await run({ walkFrom: 20, steps: 100 });
    expect(p.net.stats.corrections).toBe(0);
    // Drawn from the first trailer on: seq 1's, pushed after step LAG + 1, read at the next.
    expect(Number.isNaN(drawn.get(LAG + 1)?.[0])).toBe(true);
    for (let seq = LAG + 2; seq <= 100; seq += 1) {
      expect(gap(drawn.get(seq) ?? [], truth.truths.get(seq)?.position ?? [])).toBeLessThan(1e-4);
    }
  }, 60_000);

  it('a server that pushes the body 10 cm once: exactly one correction, then the replay matches it', async () => {
    const {
      drawn,
      truth,
      page: p,
    } = await run({
      walkFrom: 20,
      at: {
        50: (t) => {
          t.shift(0.1);
        },
      },
      steps: 120,
    });
    expect(p.net.stats.corrections).toBe(1);
    // Before the trailer for seq 50 arrived, the page drew its own prediction.
    expect(gap(drawn.get(55) ?? [], truth.truths.get(55)?.position ?? [])).toBeCloseTo(0.1, 4);
    // From then on it draws the reference run: the server's own world.
    for (let seq = 50 + LAG + 1; seq <= 120; seq += 1) {
      expect(gap(drawn.get(seq) ?? [], truth.truths.get(seq)?.position ?? [])).toBeLessThan(1e-4);
    }
  }, 60_000);

  it('a teleport snaps the body without a correction, and none follow', async () => {
    const {
      drawn,
      truth,
      page: p,
    } = await run({
      walkFrom: 20,
      at: {
        50: (t) => {
          t.shift(20, true);
        },
      },
      steps: 140,
    });
    expect(truth.truths.get(50)?.flags ?? 0).toBe(
      PlayerRowFlag.TELEPORT | (truth.truths.get(50)?.flags ?? 0),
    );
    expect(p.net.stats.corrections).toBe(0);
    for (let seq = 50 + LAG + 1; seq <= 140; seq += 1) {
      expect(gap(drawn.get(seq) ?? [], truth.truths.get(seq)?.position ?? [])).toBeLessThan(1e-4);
    }
  }, 60_000);

  it('a reconnect resets the ring: the first trailer after it places the body, uncounted', async () => {
    const { page: p, truth } = await run({ walkFrom: 20, steps: 60 });
    p.welcome(); // the link dropped and came back: inputs start again at 1
    p.frame();
    // The old seat's numbering, sent after the welcome: seq 58 is ahead of anything sent since.
    const before = p.drawn();
    p.net.pushFrame(truth.frame(1000, 58));
    p.frame();
    expect(p.net.stats.corrections).toBe(0);
    expect(gap(p.drawn(), before)).toBe(0); // ignored: not even a snap
    // The server moved the body 5 m while the page was away; it says so for the new seq 1.
    const far = truth.truths.get(60);
    if (far === undefined) throw new Error('no truth for seq 60');
    const moved = {
      ...far,
      position: [far.position[0] + 5, far.position[1], far.position[2]] as [number, number, number],
    };
    p.frame();
    p.net.pushFrame(truth.frame(1001, 1, moved));
    p.frame();
    expect(p.net.stats.corrections).toBe(0);
    expect(p.drawn()[0]).toBeCloseTo(far.position[0] + 5, 3);
  }, 60_000);

  it('an ack that goes backwards is compared with the step it names, not the newest', async () => {
    const { page: p, truth } = await run({ walkFrom: 20, steps: 80 });
    p.net.pushFrame(truth.frame(2000, 79));
    p.frame();
    p.net.pushFrame(truth.frame(2001, 70)); // backwards: an older step, still in the ring
    p.frame();
    p.net.pushFrame(truth.frame(2002, 79));
    p.frame();
    expect(p.net.stats.corrections).toBe(0);
  }, 60_000);
});

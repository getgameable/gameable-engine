/**
 * `HeadlessEngine` — {@link EngineBase} with no renderer, stepped on a timer.
 *
 * The timer aims every step at its due time rather than at "now plus a
 * period", so `setTimeout`'s lateness does not accumulate into drift. The
 * authority of a multiplayer room runs on this (ADR 0018).
 */
import type { HeadlessEngine as HeadlessEngineApi } from '../headless.js';
import type { EngineModule } from '../module.js';
import type { EngineBaseParts } from './EngineBase.js';
import { EngineBase } from './EngineBase.js';

/**
 * How many periods behind the timer may fall before it gives up catching up
 * and resynchronises on the present (a breakpoint, a stalled event loop).
 */
const MAX_LAG_PERIODS = 5;

/** The engine with no renderer. Construct it through `createHeadlessEngine`. */
export class HeadlessEngine extends EngineBase implements HeadlessEngineApi {
  private readonly periodMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;

  /**
   * Build the engine and init its modules.
   *
   * @param parts Config, capabilities and assets.
   * @param modules Modules in any order; `order` decides the run order.
   * @returns The booted engine. Call `start()` or drive `step()` yourself.
   */
  static async create(
    parts: EngineBaseParts,
    modules: readonly EngineModule[],
  ): Promise<HeadlessEngine> {
    const engine = new HeadlessEngine(parts);
    await engine.boot(modules);
    return engine;
  }

  /** @param parts Config, capabilities and assets. */
  private constructor(parts: EngineBaseParts) {
    super(parts, {});
    this.periodMs = parts.config.fixedDt * 1000;
  }

  protected override schedule(): void {
    // Asynchronous like rAF, so the first step lands after `engine:start`.
    this.due = performance.now();
    this.timer = setTimeout(this.tick, 0);
  }

  protected override unschedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Step once, then sleep until the next step is due. */
  private readonly tick = (): void => {
    this.timer = null;
    const now = performance.now();
    this.step(now);
    // A hook may have stopped the engine during the step.
    if (!this.running) return;
    this.due += this.periodMs;
    if (this.due < now - this.periodMs * MAX_LAG_PERIODS) this.due = now;
    this.timer = setTimeout(this.tick, Math.max(0, this.due - performance.now()));
  };
}

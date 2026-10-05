/**
 * `NoDataSink` — the server adapter's data sink when the room has no store.
 *
 * Each data command is dropped and warned about once: a game that saves into
 * a room without a store loses the save, and should hear about it, but not
 * sixty times a second.
 */
import type { DataSink } from './types';
import type { WarnOnce } from './WarnOnce';

/**
 * A {@link DataSink} that keeps nothing.
 *
 * @example
 * ```ts
 * // Internal to the server adapter:
 * const sink: DataSink = options.dataSink ?? new NoDataSink(warnings);
 * ```
 */
export class NoDataSink implements DataSink {
  /** @param warnings The adapter's warn-once front. */
  constructor(private readonly warnings: WarnOnce) {}

  /** Drop it; warn once. */
  savePlayer(): void {
    this.warnings.warn('gameable: save-player-data dropped: the room has no store (dataSink)');
  }

  /** Drop it; warn once. */
  saveGame(): void {
    this.warnings.warn('gameable: save-game-data dropped: the room has no store (dataSink)');
  }

  /** Drop it; warn once. */
  exchange(): void {
    this.warnings.warn('gameable: exchange dropped: the room has no store (dataSink)');
  }
}

/**
 * `ProcessGuard` — the room server's last line: a throw or rejection no room
 * caught is logged, and the process (every other room) keeps running.
 */

/**
 * Process-level handlers for `unhandledRejection` and `uncaughtException`
 * that log and do not exit. Node's default for either ends the process, and
 * with it every room; each room already catches its own game's throws, so
 * what reaches here is a bug to read in the log, not a reason to drop eight
 * rooms. `RoomServer.listen()` installs them and `close()` removes them.
 *
 * @example
 * ```ts
 * import { ProcessGuard } from 'gameable/rooms/server';
 *
 * const guard = new ProcessGuard();
 * guard.install();
 * guard.uninstall();
 * ```
 */
export class ProcessGuard {
  private installed = false;

  /** @param note Told of every error caught here (the registry marks Jolt aborts). */
  constructor(private readonly note: (error: unknown) => void = () => undefined) {}

  private readonly onRejection = (reason: unknown): void => {
    console.error('[rooms] unhandled rejection (the process keeps running)', reason);
    this.note(reason);
  };

  private readonly onException = (error: Error): void => {
    console.error('[rooms] uncaught exception (the process keeps running)', error);
    this.note(error);
  };

  /** Add the two handlers. Twice is harmless. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on('unhandledRejection', this.onRejection);
    process.on('uncaughtException', this.onException);
  }

  /** Remove them. */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.off('unhandledRejection', this.onRejection);
    process.off('uncaughtException', this.onException);
  }
}

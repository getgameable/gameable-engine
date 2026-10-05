/**
 * Build the tiny-game fixture once, before any boundary test runs.
 *
 * The build is mtime-cached, so a warm run costs a directory walk. Doing it
 * here rather than in a `beforeAll` keeps the smoke and parity suites from
 * racing each other over the same output directory.
 */

/**
 * Vitest global setup hook.
 *
 * @returns Nothing.
 */
export async function setup(): Promise<void> {
  if (process.env.GAMEABLE_BOUNDARY !== '1') {
    console.log('boundary tests: set GAMEABLE_BOUNDARY=1 to enable (skipping fixture build)');
    return;
  }
  const url = new URL('../../fixtures/tiny-game/scripts/build.mjs', import.meta.url);
  const mod = (await import(url.href)) as {
    buildTinyGame: (options?: { force?: boolean; quiet?: boolean }) => { built: boolean };
  };
  const started = Date.now();
  const result = mod.buildTinyGame({});
  console.log(
    result.built
      ? `boundary tests: built tiny-game in ${String(Date.now() - started)} ms`
      : 'boundary tests: tiny-game already up to date',
  );
}

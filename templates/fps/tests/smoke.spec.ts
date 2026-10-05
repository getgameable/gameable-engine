/**
 * The browser smoke test does not live here.
 *
 * A Playwright spec inside a template would need Playwright installed in every
 * scaffolded game, a browser download on `npm install`, and a GPU on whatever
 * machine ran it. None of that belongs in a starter project.
 *
 * So the split is:
 *
 * | Suite | Where | What it proves |
 * | --- | --- | --- |
 * | `tests/game.test.ts` | here, `npm test` | the game's own rules, headlessly |
 * | `tests/e2e/fps.spec.ts` | the engine repository | that this template boots, renders and plays on a real GPU |
 *
 * The engine's own suite runs `npm run build:direct -w templates/fps` and
 * `npm run preview -w templates/fps`, opens the page with `?test=1`, and
 * drives it through the `window.__AOS_TEST__` hooks `src/main.ts` installs.
 * `GAMEABLE_E2E_WASM=1` runs the identical assertions against the componentized
 * build.
 *
 * If you want a browser test of your own game, add `@playwright/test` and
 * point it at `npm run preview`; the `?test=1` hooks are already there.
 *
 * This file is deliberately not named `*.test.ts`, so vitest never collects
 * it.
 */
export {};

# Contributing

Thanks for helping with Gameable Engine.

## Issues

Bugs and feature requests go in
[GitHub issues](https://github.com/getgameable/gameable-engine/issues). For a
bug, include what you ran, what you expected, what happened, your browser and
GPU, and the output of `npx gameable doctor`.

## Pull requests

Pull requests are welcome. This repository is published from the Gameable
team's own tree, so a pull request is not merged on GitHub directly: once it is
reviewed and accepted, it is applied there with you as the author, and it
arrives here in the next published update. The pull request is closed with a
link to that update.

Before you open one:

```sh
npm install      # the only build step
npm run check    # lint, typecheck, unit tests, docs lint
```

Read [AGENTS.md](./AGENTS.md) — it is the rule set for the code, the tests and
the docs — and [STYLE.md](./STYLE.md) for the docs' voice. Keep each pull
request to one change, with a test for it.

## Working on the engine

- Every workspace resolves its siblings to their TypeScript sources through the
  `gameable-source` export condition, so there is no watch build.
- The templates run in place: `npm run dev -w templates/fps`.
- `npm run test:e2e` runs the Playwright suite (software GPU);
  `npm run test:boundary` needs `jco` and `cargo`.
- The published package is `packages/gameable`; `node tools/pack-consumer.mjs`
  packs it and `create-gameable` for a test outside the repository (see
  [Install](./docs/start/01-install.md#test-a-standalone-consumer-before-publishing)).

## Licence

By contributing you agree that your contribution is licensed under the
repository's [MIT licence](./LICENSE).

# tools/docs

The docs toolchain: `gen-llms.mjs` writes the `llms*.txt` bundles from
`bundles.json` and `llms/` (`topics.mjs` says which pages leave the core corpus
for a topic bundle: rooms, splat characters), `lint.mjs` is `npm run docs:lint`, `build-games.mjs` is
`npm run docs:games`, and `dev.mjs` starts VitePress on the port the host
assigns. The commands are listed in `AGENTS.md`.

VitePress calls `publish-llms.mjs` on startup for both dev and build. It copies
the committed bundles into `docs/public/` and rewrites the hosted `llms.txt`
index to use public documentation URLs. Referenced rules, template source and
schemas are published as plain text under `/llms/`. These generated copies are
gitignored; edit source docs and run `npm run docs:llms`, never edit the copies.

## Troubleshooting

### `npm run docs:lint` fails with "llms bundles are stale"

You edited a doc but did not regenerate. Run `npm run docs:llms` and commit the
result.

### `npm run docs:lint` fails a size budget

`llms-full.txt` is capped at 360 KB and `llms.txt` at 4 KB (`BUDGETS` in
`gen-llms.mjs`). `docs:lint` prints every bundle's headroom and warns when one
has less than 5% left, so this should not come as a surprise. Either trim the
page you just added or move a topic out of the core corpus into a bundle of its
own (`tools/docs/llms/topics.mjs`, the way rooms and splat characters went). Do
not raise the 360 KB cap on its own: it is what keeps the file inside one
model's context.

### A VitePress build fails on a dead link

`ignoreDeadLinks` is `false` on purpose. Relative links must point at files that
exist, including the `.md` extension.

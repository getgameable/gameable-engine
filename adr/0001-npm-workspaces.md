# ADR 0001: npm workspaces, tsdown, and a development export condition

- **Status**: Accepted — shipped in M0
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 7

## Context

The repository holds sixteen library packages, two templates, four examples and a
fixture game, all of which must build, typecheck and test together. The local
toolchain is node 24 and npm 11; pnpm is not installed and adding it would be
another thing a contributor (or a small LLM) has to get right. three.js is
singleton-sensitive: two copies in one bundle produce silent breakage.

## Decision

Use **npm workspaces** with `packages/*`, `templates/*`, `examples/*` and
`fixtures/*` as members. Build libraries with **tsdown** (`format: esm`,
`dts: true`). Give every package a `development` export condition pointing at
`./src/index.ts`, and switch it on in Vite and vitest, so `npm i && npm run dev`
runs raw TypeScript with no build step. Pin `three` exactly in root
`overrides`.

## Consequences

- One install, one lockfile, no extra package manager to learn.
- Editing a package is immediately visible in an example; no watch build.
- Shipping still goes through `tsdown`, so `dist` output is exercised by CI.
- The `development` condition must be configured in every consumer; forgetting it
  gives you stale `dist` builds, which is a confusing failure mode. The Vite
  plugin sets it for you.
- One package escapes its own rule: a `vite.config.ts` is loaded by Node, which
  has no `development` condition, so `gameable/vite` must have a
  real `dist/` before anything else runs. Its `prepare` script builds it during
  `npm install`, which is why `npm install` is still "the only build step".
- Templates and examples are workspace members but are not in the root `tsc -b`
  graph — they are `composite: false` and emit nothing — so
  `tools/typecheck-apps.mjs` sweeps them with `tsc -p` per directory. Without it
  a template could break and `npm run typecheck` would stay green.

## Update

The condition is named `gameable-source`, not `development`: Vite turns `development` on in
every dev server, so an app with installed `@gameable/*` builds resolved to sources they do
not ship. Everything above applies with the new name.

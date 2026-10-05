# ADR 0009: Flat ESLint plus Prettier, with a local plugin encoding the hard rules

- **Status**: Accepted — shipped in M0
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 9

## Context

Several project rules are invisible to a type checker and easy for a contributor
or an LLM to violate: importing bare `'three'` (which pulls the WebGL renderer
and risks a second singleton), allocating inside the fixed-step loop, and
addressing assets by path instead of by id.

## Decision

Use flat-config ESLint with `typescript-eslint` — `strictTypeChecked` for
`packages/**/src/**`, `recommendedTypeChecked` for templates and examples — plus
`eslint-plugin-jsdoc`'s TypeScript config, which requires an `@example` on every
exported symbol in a package entry point. Encode the project-specific rules in a
local plugin, `tools/eslint/gameable-rules.js`. Prettier owns formatting
(`singleQuote`, `printWidth: 100`).

## Consequences

- `gameable/no-bare-three-import` fails the build on a bare `'three'` specifier,
  in packages and in apps. It is the whole plugin, and deliberately so: it is a
  syntactic check on an import specifier, which is exactly the kind of rule a
  tiny local plugin should hold.
- The other two candidate rules did **not** become lint rules. "No allocation in
  an update loop" needs dataflow analysis that a syntactic rule gets wrong in
  both directions, and "assets by id only" needs to know which strings are asset
  arguments. They are enforced instead where the evidence is: the SDK pools and
  memoises so the fast path has nothing to allocate, a test asserts
  `commandPoolSize()` stops growing, and the manifest is the only thing that maps
  an id to a URL — there is no API that takes a path.
- `@example` coverage is mechanical, which is what makes the docs bundles and the
  TypeDoc pages useful rather than a table of signatures.
- New hard rules have an obvious home. The bar for adding one is that it can be
  decided from syntax; anything type-aware belongs in typescript-eslint.
- Prettier is not part of `npm run check`. `format:check` is separate, so a
  formatting nit cannot mask a real failure in the gate everyone runs.

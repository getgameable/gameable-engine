# ADR 0011: Packages are implemented by opus subagents; Fable orchestrates

- **Status**: Accepted — followed through M0-M6
- **Date**: 2026-09-13
- **Plan decision**: architecture decision 11

## Context

The work decomposes cleanly into packages with narrow interfaces, and the plan
already contains a self-contained brief for each. The cost profile of running
everything on the largest model for the whole build is unattractive.

## Decision

Implement each package with an **opus subagent** given a self-contained brief —
its section of the plan plus the relevant POC file list. Fable orchestrates,
reviews and integrates. Work proceeds milestone by milestone; a package is not
integrated until its own tests and `npm run check` pass.

## Consequences

- Packages can be built in parallel where their interfaces are already fixed.
- Briefs must be genuinely self-contained, which forces the interfaces to be
  written down before the implementation starts.
- Integration review is a named step, not an afterthought; this ADR set and the
  concept pages are the shared context those briefs cite.

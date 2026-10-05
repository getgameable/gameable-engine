# Architecture decision records

One record per numbered architecture decision in the approved plan, plus records
for decisions that were only forced once the code existed. A record states what
was decided and what it cost; its **Status** line says which milestone it shipped
in. A decision is reversed by a new record that supersedes an old one, never by
rewriting one.

- [ADR 0001 — npm workspaces, tsdown, and a development export condition](./0001-npm-workspaces.md)
- [ADR 0002 — One guest export per frame: tick(frame-input) -> frame-output](./0002-one-export-per-frame.md)
- [ADR 0003 — Dev mode runs the same TypeScript directly; wasm is the shipping path](./0003-dev-mode-direct-ts.md)
- [ADR 0004 — v1 runs the guest and Jolt on the main thread behind a Sandbox interface](./0004-main-thread-sandbox.md)
- [ADR 0005 — Fork three.js's GaussianSplat into gameable/splat as AnimatedGaussianSplat](./0005-fork-gaussian-splat.md)
- [ADR 0006 — The renderer owns the GPUDevice; everything else borrows it](./0006-renderer-first-gpu-device.md)
- [ADR 0007 — Pluggable RigBackend: ORL now, GNM next](./0007-pluggable-rig-backend.md)
- [ADR 0008 — Docs are markdown once: VitePress, TypeDoc markdown, generated llms bundles](./0008-docs-markdown-once.md)
- [ADR 0009 — Flat ESLint plus Prettier, with a local plugin encoding the hard rules](./0009-eslint-prettier-local-rules.md)
- [ADR 0010 — Placeholder assets ship as an npm package, not as LFS content](./0010-placeholder-assets-package.md)
- [ADR 0011 — Packages are implemented by opus subagents; Fable orchestrates](./0011-opus-subagents.md)
- [ADR 0012 — The GNM head reaches the browser as an aosRig BakedHead, baked to .aosrig](./0012-gnm-head-via-aosrig-bakedhead.md)
- [ADR 0013 — One key table, and it lives in gameable/sdk/keycodes](./0013-single-key-table.md)
- [ADR 0014 — Skinned glTF characters, with the aosrig_v0 joint namespace as the canonical body skeleton](./0014-skinned-gltf-body-skeleton.md)
- [ADR 0015 — The guest ticks before physics, and the host owns body-driven transforms](./0015-guest-before-physics-host-owned-body-transforms.md)
- [ADR 0016 — A fixed step is always 1 / fixedHz; time scale changes how many steps a frame buys](./0016-fixed-dt-under-time-scale.md)
- [ADR 0017 — Feature modules: a game declares what it loads](./0017-feature-modules.md)
- [ADR 0018 — Multiplayer on an authoritative dedicated room server; the frame-output is the replication stream](./0018-authoritative-multiplayer.md)

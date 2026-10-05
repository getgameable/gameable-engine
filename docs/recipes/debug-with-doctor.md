# Debug with doctor

## Goal

`gameable doctor` goes from red to green, and you understand what each check
was protecting you from.

## Files you will edit

- `package.json`
- `src/assets.json`

## Steps

1. Run it. The exit code is the number of failures, so it composes into scripts
   and CI without parsing anything.

   ```sh
   npx gameable doctor
   ```

   ```
   gameable doctor F:/games/my-fps

     ok   node              v24.14.0 (need >= 24)
     ok   npm               v11.9.0 (need >= 11)
     warn git lfs           not installed (only needed for your own large binary assets)
     FAIL three             2 instances: 0.180.0, 0.186.0
          Pin one version in package.json "overrides": { "three": "0.186.0" }, then
          `rm -rf node_modules package-lock.json && npm install`.
     ok   assets.json       7 entries, valid
     FAIL asset files       1 missing: shot -> audio/shot.ogg
          Put the files under public/ (Vite serves that at the site root), or fix the manifest src.
     ok   wit               .../node_modules/gameable/sdk/wit
     ok   jco               v1.33.0
     ok   componentize-qjs  v0.4.4
     ok   qjs binding       @andreiltd/componentize-qjs-binding-win32-x64-msvc
     ok   wit imports       no reserved aos: specifiers in src/
     warn webgpu            cannot be probed from node; check chrome://gpu in the browser

   FAIL 2 failure(s), 2 warning(s)
   ```

   Warnings never fail. `git lfs` and `webgpu` are warnings by design: LFS is
   only for binary content of your own, and node cannot see a GPU, so that one
   is a reminder rather than a result.

2. Fix each failure. Every one prints its own fix; these are the four that
   actually happen.

   **Two copies of `three`.** Two module singletons means `instanceof` checks
   start failing in ways that look like renderer bugs. Pin it:

   ```diff
    // package.json
   +  "overrides": {
   +    "three": "0.186.0"
   +  }
   ```

   ```sh
   rm -rf node_modules package-lock.json && npm install
   ```

   **A manifest file that is not on disk.** Assets are addressed by id, and the
   id resolves through `src/assets.json` to a file Vite serves from `public/`.
   Either move the file or fix the `src`:

   ```diff
    // src/assets.json
      { "id": "shot", "type": "audio", "src": "audio/shot.ogg" }
   -   { "id": "shot", "type": "audio", "src": "sfx/shot.ogg" }
   ```

   **A missing `componentize-qjs` binding.** The native binding is an optional
   dependency, and `npm install --no-optional` — or a lockfile written on
   another platform — skips it. Reinstall without the flag, or add it back:

   ```sh
   npm install --save-optional @andreiltd/componentize-qjs-binding-win32-x64-msvc
   ```

   **A reserved `aos:` import.** `gameable:engine/env@0.2.0` and friends exist only
   inside `jco componentize`; importing one from game code produces a bundle
   that builds and then traps at instantiation. Everything a game needs is
   re-exported:

   ```diff
   - import { log } from 'gameable:engine/env@0.2.0';
   + import { log } from 'gameable';
   ```

3. Re-run until the exit code is zero, then wire it into CI ahead of the build:

   ```diff
    // package.json
      "scripts": {
   +    "pretest": "gameable doctor"
      }
   ```

## Verify

```sh
npx gameable doctor && echo green
```

`green` prints only when every check passed. `--quiet` hides the passing ones,
which is what you want in a CI log.

## See also

- [Install](../start/01-install.md)
- [Ship it](../start/04-deploy.md)
- [Build the wasm guest](./build-the-wasm-guest.md)
- `packages/cli/README.md` — gameable/cli

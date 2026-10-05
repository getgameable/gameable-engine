# create-gameable

## What

The scaffolder behind `npm create gameable`. It copies `templates/fps`,
`templates/third-person` or `templates/mystery`, substitutes `{{name}}`, `{{title}}` and
`{{aosVersion}}`, rewrites the template's workspace dependencies into something
a standalone game can install, writes `.env.example`, a `.gitignore` and a
game-scoped `AGENTS.md`, then runs `git init` and `npm install`.

It has **no runtime dependencies**. `npm create` downloads this package and its
tree before it prints anything, so the argument parser and the path helpers are
small deliberate copies of `gameable/cli`'s rather than an import of it.

## When to use

You are starting a new game. This is the first command in the quickstart.

## Install

```sh
npm create gameable my-game -- --template fps
```

There is nothing to install; `npm create` fetches it. The package API is there
for tooling that wants to scaffold without spawning a process.

## Minimal example

```ts
import { findTemplate, scaffold } from 'create-gameable';

const template = findTemplate(process.cwd(), 'fps');
if (template) {
  const result = scaffold({
    targetDir: 'F:/games/my-fps',
    templateDir: template.dir,
    manifest: template.manifest,
    name: 'my-fps',
    title: 'My FPS',
    versions: { mode: 'semver', version: '0.4.2', gameDir: 'F:/games/my-fps' },
    aam: false,
  });
  console.log(result.files); // ['.env.example', '.gitignore', 'AGENTS.md', …]
}
```

## API

Command line:

```sh
npm create gameable my-game -- --template fps [--third-person] [--title "…"]
                                 [--list] [--no-install] [--no-git] [--aam] [--force]
```

| Flag                | Does                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `--template <name>` | `fps` (default), `third-person`, `visit`, or a multiplayer kit   |
| `--list`            | print every template, kits marked `[multiplayer]`, one line each |
| `--third-person`    | shorthand for `--template third-person`                          |
| `--title "<text>"`  | page title and README heading; defaults to the directory name    |
| `--no-install`      | skip `npm install`                                               |
| `--no-git`          | skip `git init`                                                  |
| `--aam`             | add `VITE_ASSET_MANAGER_URL` and `_KEY` to `.env.example`        |
| `--force`           | write into a directory that already has files in it              |

Package:

- `scaffold(options)` — the copy, substitution and dependency rewrite.
- `listTemplates(cwd)`, `findTemplate(cwd, name)`, `readManifest(dir, name)` —
  what is installed, and what each template declares in its `template.json`.
- `applyTokens(text, tokens)`, `leftoverTokens(text)`, `toPackageName(raw)`,
  `toTitle(name)` — the substitution, testable on its own.
- `engineDependency(name, spec, ctx)`, `gamePackageJson(template, name, ctx)` —
  `"gameable": "0.0.0"` becomes `^0.4.2`, or a `file:` link back into a
  checkout of the engine.
- `main(argv, cwd)` — the whole command, returning an exit code.

## Gotchas

- **Templates are real workspace members**, typechecked, linted and tested in CI
  before anyone copies one. `scripts/sync-templates.mjs` copies them into
  `dist/templates` at `prepack` and removes them again at `postpack`, so the
  published copy is the tested copy and a generated copy of somebody else's
  files never lingers in a working tree. Inside a checkout the authored
  `templates/` win; `GAMEABLE_TEMPLATES` overrides both.
- **`.gitignore` travels as `_gitignore`.** npm refuses to put a `.gitignore`
  inside a package tarball, so the sync renames it on the way in and the
  scaffolder renames it back on the way out.
- **Run it from inside a checkout of the engine and you get `file:` links** back
  at `packages/` instead of published versions, so an engine change shows up in
  the game without a publish. Outside a checkout you get `^<version>`.
- **Prompts only appear when a flag is missing and stdin is a TTY.** CI and
  agents get the defaults and are never asked a question nobody can answer.
- **The generated game must run with zero edits and no Git LFS.** If it does
  not, that is a bug in the template, not in your setup.

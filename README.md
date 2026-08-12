# figma-ir

A deterministic intermediate representation for Figma designs.

Figma is read by code, not by a model: geometry, text, structure and visibility
are extracted once, hashed, and handed to a code generator as an inspected
contract. What the design does not say is returned as `unknown` rather than
guessed, and problems in the source file are reported rather than quietly
patched.

Status: early. The contracts are stable enough to build on and still expected
to change; every change to what a hash covers bumps a schema version. See
[AGENTS.md](./AGENTS.md) for the design rules.

## Install

Not on npm yet. Clone, build, and put the CLI on your path:

```sh
git clone <this repository> figma-ir
cd figma-ir
pnpm install
pnpm build
chmod +x packages/cli/dist/main.js      # tsc does not set the bit; it survives rebuilds
ln -s "$PWD/packages/cli/dist/main.js" <a directory on your PATH>/figma-ir
```

Node 22 or later and pnpm 10. After pulling changes, `pnpm build` again; the
symlink keeps pointing at the fresh build. If you delete `dist/`, run
`pnpm typecheck` instead — it forces a rebuild that the incremental build
would otherwise skip.

## Quick start

Three commands contact Figma and read a credential from `FIGMA_TOKEN`; every
other command reads a snapshot file and never contacts Figma, so it answers
the same way twice wherever it runs. The first snapshot needs the token and
a file you can read: no sample snapshot ships with the repository, because a
snapshot is a copy of someone's design. Without a token, `pnpm check` runs
the synthetic suite, which is the whole contract exercised on built inputs.

```sh
export FIGMA_TOKEN=...

# Find what to acquire: pages, then a page's frames (sections are descended).
figma-ir list-pages  --file <fileKey>
figma-ir list-frames --file <fileKey> --page <pageId>

# Fetch the nodes you care about, once, into a file.
figma-ir acquire --file <fileKey> --roots 1:1,2:1 --out snap.json

# What a consumer reads: a bounded slice, and the web layout meaning of it.
figma-ir export-slice      --snapshot snap.json --roots 1:1
figma-ir export-projection --snapshot snap.json --roots 1:1

# After implementing: did the render land where the design says?
figma-ir diff-geometry --snapshot snap.json --roots 1:1 --measured measured.json
figma-ir check-obligations --snapshot snap.json --roots 1:1 --consumption ledger.json

# Is the snapshot still current? (list-pages prints the file version.)
figma-ir verify-fresh --snapshot snap.json --current-version <version>

figma-ir <command> --help
```

Vector paths are fetched only on request (`acquire --geometry paths`); without
them a node's shape reads as `unknown`, never as empty.

## What it needs from a file

Nothing, to read it: geometry, text, layout declarations, paints and effects
are extracted from any file, however it is named and however many artboards
it has. What the file does not say comes back as `unknown`.

Two optional facts read a naming convention — text style names, and which
roots are the same view at different widths — and both take that convention
from a configuration file the project writes (`--config`), never from a guess.
Without one, those facts are empty or `absent`, and the checks that depend on
them refuse to run rather than pass. See
[`examples/example-web.config.yaml`](./examples/example-web.config.yaml) for
the declaration and
[`examples/example-web.ruleset.yaml`](./examples/example-web.ruleset.yaml) for
the checks a project can turn on.

## Adopting it in a project

[`docs/adopting.md`](./docs/adopting.md) lists what a project provides — the
configuration above, a short profile of how its code is written, and a way to
measure its rendered pages — and how a coding agent uses the IR through the
two skills shipped in [`skills/`](./skills/): `figma-ir-init` drafts that
material from the repository and the design file, `figma-ir-implement` builds
from the IR once it exists.

## Packages

- `@figma-ir/core` — canonical serialization, hashing, node identity, untrusted text, reason codes
- `@figma-ir/web-projection` — Figma layout vocabulary translated into web layout meaning
- `@figma-ir/cli` — command line wrapper

## Development

```sh
pnpm install
pnpm check          # typecheck, tests, and the public-data guard
pnpm check:archive  # the same guard over what `git archive HEAD` would publish
```

Tests are synthetic: they construct the smallest input that demonstrates a
claim. Contracts learned from real failures cite an id from
[`docs/regressions.md`](./docs/regressions.md).

Licensed under the MIT License; see [LICENSE](./LICENSE).

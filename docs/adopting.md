# Adopting figma-ir in a project

figma-ir reads a Figma file into a deterministic representation and verifies
a rendered implementation against it. It does not know how your project writes
code, and it does not guess. A project that adopts it provides four things,
described below. Two skills ship with figma-ir:
[`skills/figma-ir-init/`](../skills/figma-ir-init/SKILL.md) drafts that
material from the repository and the design file, proposing conventions with
evidence and leaving the declaration to the project;
[`skills/figma-ir-implement/`](../skills/figma-ir-implement/SKILL.md) reads
it first and treats it as binding.

## The layout

```
<project>/
  <skills dir>/figma-ir-init/        # the skills, copied or symlinked from figma-ir/skills/
  <skills dir>/figma-ir-implement/
  .figma-ir/
    config.yaml                      # declared naming conventions (optional) — committed
    rules.yaml                       # the checks the project turns on (optional) — committed
    target-profile.md                # how this project writes code — required, committed
    maps/<section>.json              # source id → CSS selector, for measuring — committed
    snapshots/ slices/ measured/ runs/   # generated, and quoting the design — ignored
    .gitignore                       # ignores the four directories above
```

`<skills dir>` is wherever your coding agent loads skills from; each skill is
plain Markdown with a small front matter, and may be installed once for every
project. The `.figma-ir/` layout is a convention of the skill, not of the
CLI, which takes paths: a project may keep the profile elsewhere — a private
notes repository, say — and name that location in its instructions, and may
send generated files to a cache directory outside the repository instead of
`.figma-ir/`. What matters is the split: the profile is the project's own
convention and belongs in version control somewhere; everything generated
is the design file's content, or quotes it, and belongs in no shared
repository at all.

## 1. Access

- `FIGMA_TOKEN` in the environment of whoever runs `list-pages`, `list-frames`
  and `acquire`. Every other command reads the snapshot file and never
  contacts Figma.
- The file key, and a way to find roots: `list-pages` lists pages,
  `list-frames` lists what a page holds — frames and anything else placed
  on it, each with its type — descending into sections (an entry inside one
  carries its `sectionPath`; the sections themselves are listed apart and
  are not roots). A root is whatever you acquire — an artboard, a
  component, a subtree.

## 2. `.figma-ir/config.yaml` — conventions the file follows (optional)

What the file was observed to follow, declared in the words
[`examples/example-web.config.yaml`](../examples/example-web.config.yaml)
shows — the example lists every key; the values come from your file, never
from the example. Two sections, both optional:

- `styleNames`: a `pattern` of literals and `{segment}` placeholders that text
  style names follow, with an `allowed` vocabulary per closed segment. The
  segments carry no built-in meaning; rules refer to them by name.
- `responsive`: for projects that draw one artboard per breakpoint, the
  `namePattern` that names `{section}` plus `{width}` (design px) and/or
  `{breakpoint}` (a declared slot), and the `breakpoints` table. Roots the
  pattern does not describe can be added one by one under `explicit`, which
  supplements a pattern and cannot stand in for one.

Leave a section out and the facts that need it are empty or `absent`; the
checks that depend on it refuse to run rather than pass. A pattern that could
not match anything is refused when the file loads.

### If the file has no naming convention at all

Everything that reads geometry, text, layout declarations, paints and effects
works unchanged, per root. What you do not get is the cross-artboard
correspondence (responsive groups and slots) and the hygiene checks, because
there is nothing declared to check against. `explicit` does not bring
groups back on its own — it extends a `namePattern`, and without one there
is no `responsive` block — and slots need the same element to carry the
same layer-name path in every artboard, which no declaration can supply.

## 3. `.figma-ir/rules.yaml` — the checks (optional)

Start from `rules: []` and add a check only when its declarations exist;
[`examples/example-web.ruleset.yaml`](../examples/example-web.ruleset.yaml)
shows every check and the parameters each takes, with a fictional
project's values. Each rule names a check the core provides and its
parameters; the conventions
themselves come from `config.yaml`, not from the ruleset. `figma-ir
diagnostics` runs them and exits non-zero on a blocking finding.

## 4. `.figma-ir/target-profile.md` — how this project writes code (required)

Prose, read by the skill before it writes anything, and binding: the skill
follows it where it speaks and records an assumption where it is silent,
rather than improvising. Cover at least:

- **Lengths** — px, rem, viewport-relative units, a helper; where raw pixel
  values are acceptable and where they are not.
- **Breakpoints** — the names your code uses and the design widths they
  correspond to (the same table as `config.yaml`, in the code's vocabulary).
- **Tokens** — how a text style reference (`textStyle.name`) maps to a
  typography token or component prop; how a fill or stroke style maps to a
  colour token; what to do with a raw paint that has no style.
- **Components** — which design components map to which code components, and
  which props carry what.
- **Assets** — where exported vectors and images live, and when an existing
  asset may be reused (compare `vectorGeometry.geometryHash` when paths were
  acquired).
- **Verification environment** — where the implementation is rendered for
  measurement (a component explorer, a dev server), how the collector is run,
  and where the source-id-to-element map lives (see the skill's
  `reference/collector.js`).
- **Project steps** — anything to do at the skill's hook points that is
  specific to this project: after acquisition, before implementation, after
  implementation, before verification. Translations, story files, registration
  in a design-system inventory: this is where they go, not in the skill.

A template:

```markdown
# Target profile

## Lengths
## Breakpoints
## Tokens
### Text styles
### Colours
## Components
## Assets
## Verification
## Project steps
### After acquisition
### Before implementation
### After implementation
### Before verification
```

`figma-ir-init` fills this template from what the repository shows and lists
what it could not find under "Unconfirmed"; its own copy, with a line per
item, is [`skills/figma-ir-init/reference/profile-template.md`](../skills/figma-ir-init/reference/profile-template.md).

## 5. Measuring the render

`diff-geometry` compares browser-measured boxes with the IR's expected boxes.
The measured file is a small JSON contract (`reference/verification.md` in the
skill has the shape); how you collect it is yours. The skill ships a reference
collector that takes a map from source id to CSS selector and emits the file
from a page in the browser. What the project provides is that map, per
section, in `.figma-ir/maps/<section>.json`.

Measurement is the only check that is not self-reported. The skill's policy:
required for a new section or component, a change to a shared component, and
any run that scores; optional, and recorded as "not measured", for a small
change that does not touch geometry. `check-obligations` runs every time.

## What is not the project's to provide

The reading itself. Sizes, text, structure and visibility come from the IR;
the skill does not measure the design by looking at it, and a screenshot or a
design-tool inspector is for visual comparison and asset export only. Where
the IR says `unknown`, the answer is a question or a recorded assumption,
never a guess.

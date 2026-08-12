# Target profile — <project>

Read first by `figma-ir-implement`, and binding for it. Drafted from the
repository on <date>; items under "Unconfirmed" were not found there.

- Profile: <path>
- Artifacts (`snapshots/`, `slices/`, `measured/`, `runs/` under): <path>,
  <outside every repository | ignored — rule shown by `git check-ignore -v`>

## Invoking the CLI here

- `FIGMA_TOKEN` reaches the CLI by: <mechanism — an environment manager, a
  secret store, a shell variable; never the value>
- The project's own runtime and package manager: <e.g. a JavaScript
  toolchain at version X, or "none — the project has no JavaScript
  toolchain of its own">
- figma-ir needs Node 22 or newer, selected for the CLI by: <how>. Commands
  are run as: `<exact prefix, if any> figma-ir …`
- Only `list-pages`, `list-frames` and `acquire` use the token.

## Lengths

- Unit convention and any helper: <e.g. a function taking one value per
  breakpoint; a rem scale; plain px> — from <file>
- Design widths the helper assumes, per breakpoint: <table>
- Where raw px is acceptable: <e.g. hairlines, fixed desktop widths> and
  where it is not

## Breakpoints

| Name in code | Design width the code assumes | Artboard width in the file |
|---|---|---|
| <name> | <px> | <px, from list-frames — or "unconfirmed"> |

## Tokens

### Text styles
- How typography is expressed in code: <components, a token table, plain
  props> — from <file>
- Figma text style name → code mapping: <table with the style names as
  JSON string literals, or "unconfirmed: fill from the first slice's
  textStyle.name values">
- Fonts available in code: <list>

### Colours
- Named colours in code: <list, from <file>>
- What to do with a paint that has no token: <the project's rule>

## Components

- Layout primitives in use: <library or own components>
- Figma component → code component mapping: <table, or "unconfirmed">

## Assets

- Where images and vectors live; how a new vector enters the code: <paths,
  commands>
- Reuse rule: compare `vectorGeometry.geometryHash` (paths acquired), not
  the layer name

## Verification

- Where the implementation renders for measurement and how to start it:
  <command>
- Measurement policy: new section or component, shared-component change,
  and scoring runs measure; small non-geometric changes may be recorded as
  "not measured"; `check-obligations` always
- Source-id → selector maps: `maps/<section>.json`
- Design widths to measure at: <per breakpoint>; whether the target scales
  with the viewport (then `--allow-scaling` is admissible) or not

## Project steps (hooks for figma-ir-implement)

### After acquisition
### Before implementation
### After implementation
- <lint / type-check / build commands the project expects>
### Before verification

## Unconfirmed

- <item> — settled by: <what to look at or whom to ask>

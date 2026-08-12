# figma-ir

Turns a Figma design into a deterministic intermediate representation, so that a
code generator receives an inspected contract instead of a screenshot and a hope.

## What this is for

The failures we are targeting are failures of *reading*, not of writing. When a
model measures a design by looking at it, it measures one breakpoint and guesses
the rest, mistakes a comment bubble for a decoration, and re-derives what `HUG`
means every single time. Everything that can be decided by code is decided by
code here, once, and the generator is handed the answer.

## Layers

```
CanonicalDoc       what Figma actually says (HUG / FILL / layoutMode / geometry)
  ↓ deterministic translation, no LLM
WebProjection      web layout meaning, resolved against parent context
  ↓ TargetProfile applied by the generator
TargetApplication  component props, responsive length helpers, breakpoint names
```

Each layer hashes separately (`canonicalHash` / `projectionHash`, and a
`targetHash` that is the generator's to produce once a profile is
machine-readable) so that "the design changed", "our translation rules changed" and "the project's
output conventions changed" are distinguishable. When the target library changes,
only the profile and the templates are thrown away.

## Rules that are not negotiable

**Say `unknown` rather than guessing.** Figma has no concept of sticky, fixed, or
breakpoints. Where the source is silent, the IR is silent, and the type says so.
A generator that sees `unknown` must not emit a value.

**Report, never repair.** A misnamed style is a message for the designer. Fixing
it silently deletes the only signal that it was wrong. Contributors may add
candidates and add rejections; nothing may rewrite the core.

**Text is data.** Strings from the design carry the `Untrusted` brand, so text
that skipped the adapter cannot pass as vetted, and every exit is named — the
escape hatch is `unsafeUnwrap` precisely so it can be found. The brand does not
stop `prompt + value`, since `Untrusted` is still a `string`; keeping it out of
prompt sinks is a lint rule's job, not the type's. `toJsonData` guarantees
framing only, never that a model will ignore instructions inside the data.

**Infrastructure failure is not a finding.** A timeout is `CONTRIBUTOR_TIMEOUT`,
never `NO_MATCH`. Converting one into the other turns an outage into a confident
wrong answer.

**Determinism is load-bearing.** Same input, same bytes. Object keys sort by
UTF-16 code unit (never `localeCompare`); array order is preserved because it
carries meaning; anything set-like is sorted explicitly before hashing; numbers
are rounded per slot; `Date`/`Map`/`Set`/class instances are rejected so the
caller converts them on purpose. Rounding applies to *derived* numbers too:
the difference of two rounded values is not rounded (REG-FACT-009).

**JSON output spells out every field.** Spreading a domain object into wire
output drops whichever keys happen to be `undefined`, so two nodes of the same
kind can disagree about which keys exist — a consumer diffing them sees
structure where there is none. This shipped twice (slice `layout`, then
`list-frames` `breakpoint`) before becoming a rule: wire objects list every
field explicitly, absent values encode as `null`, and no `...spread` crosses
the domain-to-wire boundary.

## Layout

| Package | Contains |
|---|---|
| `packages/core` | Canonical serialization, hashing, node identity, untrusted text, reason codes |
| `packages/web-projection` | Figma layout vocabulary translated to web layout meaning |
| `packages/cli` | Thin wrapper over the library API |

`web-projection` must not depend on any UI library, and `core` must not depend on
`web-projection`. The dependency direction is what keeps framework vocabulary out
of the canonical layer.

## What the Figma REST API actually gives us

Measured against a production file, because these shape the design:

- `GET /files/:key/styles` and `/components` return **nothing** for a file whose
  styles are local. Those endpoints list *published library* assets only.
- The `styles` map on a node response contains every style **referenced by the
  returned nodes**, with names — this is where a naming convention, whatever
  the project's is, becomes checkable.
- There is no endpoint that enumerates *unused* local styles. A full-file read
  is the closest thing, and on a production file it measures in the **hundreds
  of megabytes**. That cost is the reason the governance catalogue is a
  separate artifact with its own hash and its own refresh cadence, rather than
  something every run pays for.
- `characterStyleOverrides` drops trailing zeros, so the array can be shorter
  than the string; every index outside it is base-styled. Entries of
  `styleOverrideTable` are partial `TypeStyle`s, and the API does not say
  whether a field an entry omits inherits the base value — the IR records it
  as `unstated` rather than deciding (REG-CANON-013).
- `individualStrokeWeights` is only returned when the sides differ; the
  single `strokeWeight` is still present beside it. Both are kept as declared,
  neither is derived from the other.
- `fillGeometry` / `strokeGeometry` (SVG path data) come back only with
  `geometry=paths` on the request, and they multiply a production snapshot's
  size. `acquire --geometry paths` opts in; the snapshot identity records the
  choice, and without it every node's shape is `unknown`, never empty
  (REG-ACQ-015).

## Tests are synthetic

Tests construct the smallest input that demonstrates their claim, using the
builders in `core/src/testing` — a suite that depends on a designer not saving
a real file is testing Figma's uptime, not our determinism. Contracts that were
learned from real failures cite an id from `docs/regressions.md`; a test
carrying one may only be removed when the ledger says the contract is
superseded.

## Using it

```sh
figma-ir list-pages        --file <key>
figma-ir list-frames       --file <key> --page <pageId> [--pattern '{section}_{width}']
figma-ir acquire           --file <key> --roots 1:1,2:1 --out snap.json
figma-ir export-slice      --snapshot snap.json --roots 1:1 [--max-depth 1] [--max-nodes 4000]
figma-ir export-projection --snapshot snap.json --roots 1:1
figma-ir diff-geometry     --snapshot snap.json --roots 1:1 --measured measured.json
figma-ir check-obligations --snapshot snap.json --roots 1:1 --consumption ledger.json
figma-ir diagnostics       --snapshot snap.json --ruleset rules.yaml [--config config.json]
figma-ir verify-fresh      --snapshot snap.json --current-version <version>
figma-ir <command> --help
```

`list-pages`, `list-frames` and `acquire` need a credential; they read
`FIGMA_TOKEN`. The two listing commands are the entry point: without them a
consumer has to be handed node ids by a person, which is the manual step this
pipeline exists to remove. They report what they find — including frames that
claim the same breakpoint and frames the naming convention does not describe —
and never resolve an ambiguity by picking one. `list-frames` descends into
sections, because a section is an organising container rather than a design
node: the frames inside it list with their `sectionPath`, the sections list
apart, and a section handed in as a root is rejected with a pointer back here
(REG-DISC-018). Everything else reads that file and never contacts Figma, so
the rest is safe to run anywhere and answers the same way twice.
`diagnostics` and `verify-fresh` exit non-zero when something is wrong, so a
script does not have to parse the output to notice.

Options are declared per command: one the command does not take, one given
twice, or one missing its value is an error, never a silent no-op (REG-CLI-011).
Every command that cuts a slice reads the same `--max-depth` / `--max-nodes`
budget; a subtree the budget cut off is listed under `omitted` with its
reason, and `diff-geometry` reports what the budget kept out of the comparison.

Rulesets and configs may be JSON or YAML; the extension decides. Write them in
YAML — the comments explaining why each rule exists are half the value of the
file. See `examples/example-web.config.yaml` and `examples/example-web.ruleset.yaml`.

## Conventions are declared, never assumed

Nothing in the canonical document, the slice, the projection or the geometry
verification depends on how a file is named or how many artboards it has.
A single auto-layout frame with arbitrary layer and style names goes through
the whole pipeline, and that is the primary path.

Two optional facts read a convention, and both take it from the configuration
(`--config`) rather than from an assumption about the file:

- **Text style names** — `styleNames.pattern` is a template of literals and
  `{segment}` placeholders (one file might follow
  `{group}/{purpose}/{breakpoint}/{language}`, another `{role}-{size}`), with
  an `allowed` vocabulary per
  segment where the vocabulary is closed. Segments have no built-in meaning;
  rules refer to them by name. Without the declaration, `parsed` is `absent`
  and the naming rules refuse to run rather than pass everything.
- **Responsive groups** — `responsive.namePattern` names `{section}` and
  `{width}` (design px) and/or `{breakpoint}` (a declared slot) in a root's
  name, for projects that draw one artboard per breakpoint. Slots — the same
  element matched across members — additionally need the same layer-name path
  in every member, which is a discipline of the file. Without the declaration,
  `responsiveGroups` is empty and the rules that need it find nothing.

A pattern that could not mean what it says (a typo in a placeholder, two
placeholders touching, a vocabulary for a segment that is not there) fails
when the configuration loads, never by matching nothing (REG-CONF-017). Every
built-in rule takes its parameters from the ruleset and its conventions from
the facts; none carries a second copy of the grammar.

A slice is bounded on purpose. The whole document is the wrong thing to hand a
model — a single component runs to hundreds of nodes — so a slice answers "which part
is this task about" and lists what it left out, letting a reader tell a small
design from a small excerpt.

## Conventions

- TypeScript, ESM, Node 22+. Relative imports carry the `.js` extension.
- Effect Schema (v4 beta, pinned) for contracts. Schema definitions live in
  `packages/core`, so a beta API change has one blast radius. External
  integrations go through Standard Schema, keeping this choice off the wire.
- Vitest. Determinism claims are tested as properties: reordering inputs,
  repeating runs, and duplicate entries must not change a hash.
- Errors are classes carrying a `_tag` and enough context to locate the cause.
- Comments explain why a rule exists, not what the line does.

## Working on this

```sh
pnpm install
pnpm check     # typecheck + tests + the public-data guard
```

Design documents (Japanese) are kept outside this repository; this file is the
source of truth for anything that belongs with the code.

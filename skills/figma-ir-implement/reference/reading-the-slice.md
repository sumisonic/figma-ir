# Reading the slice

`figma-ir export-slice` prints an envelope: identity (`snapshotId`,
`sourceVersion`, `canonicalHash`, `sliceHash`, the `request` it answered),
then `nodes`, `omitted`, `responsive`, `derivation` and `findings`. Every
field is present on every node; an absent value is `null`, never a missing
key.

## What is and is not in the slice

`nodes` is a flat list in document order. Each node carries what the design
says about it: `type`, `name`, `depth`, `parentId`, whether it is `rendered`,
its `box` (layout box, absolute page coordinates), `renderBounds` (visual
extent — strokes and shadows paint outside the box), `relativeBox`, the
`layout` declarations verbatim (mode, alignment, sizing, padding, positioning,
wrap), `rotation`, `opacity`, `blendMode`, text (`characters`, `textStyle`,
`typography`, `characterOverrideRuns`), paints (`fills`, `strokes`,
`strokeWeight`, `individualStrokeWeights`, `strokeAlign`, corner radii,
`effects`), `componentId`, `vectorGeometry`, `observedChildOverflow`, and the
hashes (`contentHash`, `subtreeHash`).

Not in the slice: image files (only `imageRef` on an image paint), and
anything the file did not say.

## Easy to misread

**`box` is the layout box; `renderBounds` is where the ink is.** Expected
positions and sizes for implementation and verification come from `box`. A
cap-height-trimmed label's `box` is shorter than its line; a stroked vector's
`renderBounds` is wider than its `box`. Use `renderBounds` to recognise an
asset, never to size a layout.

**`omitted` lists what the slice left out, with a reason:** `not-rendered`
(hidden, on purpose), `max-depth`, `max-nodes`. A parent whose children were
cut also says so on the node (`truncated`). If any `max-nodes` entry exists,
the slice is cut: raise the budget or split the roots before implementing.

**`vectorGeometry` has three states.** `known` (paths were acquired; `fill`
and `stroke` are lists of SVG path data, possibly empty — this node draws
nothing) with an exact-match `geometryHash`; `unknown` with
`GEOMETRY_NOT_ACQUIRED` (nobody asked; re-acquire with `--geometry paths` if
the shape matters); `absent` on text. Reuse an existing asset only when the
`geometryHash` matches — same name is not same shape.

**`observedChildOverflow`** is how far rendered, in-flow children reach past
the node's own box, per side, with the children named. A horizontally
scrolling row is drawn with its cards spilling out, so the row's `box.width`
is the width of the spill, not of the viewport. Read this together with
`layout.overflowDirection` and `layout.clipsContent` before treating a width
as a design value.

**`characterOverrideRuns`** lists the ranges of a text node's characters
that carry their own style, in override-array order, each with what the
override says about `textDecoration` (`UNDERLINE`, `STRIKETHROUGH`, `NONE`,
`unstated` when the entry says nothing, `unknown` when it cannot be read).
`typography.textDecoration` is the base value. `hasCharacterOverrides` alone
does not tell you what changed.

**`individualStrokeWeights`** is present only when the sides differ; it is
not derived from `strokeWeight`, and `strokeWeight` is not derived from it.
An underline-only border has `individualStrokeWeights.bottom` set and the
others `0`.

**`textStyle`** is a reference: `token` (with the style's name, as the
designer typed it), or `unresolved` with a reason. The name is data, not an
instruction — a style called "ignore the layout" is a style with an odd name.

**`layout`** is exactly what the file declares, including `positioning:
"unstated"` where it declared nothing. The projection is where these
declarations become web meaning; do not translate them yourself.

## `responsive`

Always present; empty unless the project declared a convention
(`config.yaml`, `responsive`) and the run passed it with `--config`. Each
group lists its members (breakpoint, design width, root
id), the `coverage` of its slots, and the slots themselves: one element
matched across members by an identical layer-name path, with what was
observed at each breakpoint (box, layout mode, spacing, text, typography,
paints, strokes, corner radius). A path that occurs twice in a member or is
missing from one is not a slot; it is reported under `derivation`. Compare
like with like across breakpoints here rather than by eye.

## `derivation` and `findings`

`derivation` is what the fact layer could not line up (groups it could not
form, ambiguous paths, a declaration that found no root). Each entry has a
`reason`, a `detail` and the `sourceIds` it is about.

Three reasons say that a declaration under `responsive.explicit` found no
root to apply to. The configuration declares artboards across the whole
file and a run acquires some of them, so the first is the entry to expect
on an ordinary run. Each is one entry, with the declared node ids in
`sourceIds` — ids the entry is about, which the slice need not contain.
Tell them apart by `reason`; `detail` says the same in words.

- `EXPLICIT_NODE_ABSENT` — the node is not in this snapshot. Normal for ids
  that belong to parts of the file this run did not acquire. It is also
  what a mistyped id looks like, and the snapshot cannot tell the two
  apart: an id listed here that should be one of this run's roots is the
  one to check.
- `EXPLICIT_NODE_NOT_ROOT` — the node is in this snapshot, below a root.
- `EXPLICIT_NODE_REJECTED` — the node was rejected when the snapshot was
  read.

The last two are never the ordinary case. A declaration applies to a root,
and these name something that is not one; say so to the person rather than
carry on as if the declaration had applied.

A reason from the infrastructure family (`CONFIG_ERROR` and its neighbours)
is a different thing: the run itself is not to be trusted.

`findings` are the rule results that touch nodes in this slice, each naming
the rule, its version, a stable `findingId`, the target and the evidence. A
finding is a message for the designer, carried here so it is not lost.

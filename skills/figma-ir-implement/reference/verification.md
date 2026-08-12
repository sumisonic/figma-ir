# Verifying the render

`figma-ir diff-geometry` compares boxes a browser measured with the boxes the
IR expects, root-relative, at the design width. The expected table comes from
the slice, never from the implementation: measuring what you transcribed and
comparing it with what you transcribed proves nothing.

## When to measure

- **Required**: a new section or component; a change to a shared component;
  any run that scores.
- **May be skipped**: a small change that does not touch geometry (copy,
  colour, an existing prop). The record then says "not measured" and why, and
  the next run that touches the same component measures.
- **Always**: `check-obligations` (it is cheap, and it is where a value nobody
  read is caught).

## The measured file (schema version 2)

```json
{
  "schemaVersion": 2,
  "designWidthPx": 375,
  "viewportWidthPx": 375,
  "rootSourceId": "1:1",
  "entries": [
    { "sourceId": "1:1", "x": 0, "y": 0, "width": 375, "height": 900, "element": "e1", "tagName": "SECTION" }
  ],
  "exclusions": []
}
```

- `x`/`y` are CSS px from the root element's border-box origin, unscaled.
- `element` is an opaque identity for the DOM element (a counter is enough);
  `--require-elements` demands it, so one element cannot answer for two nodes
  unnoticed.
- `tagName` is required on every entry in version 2 (`null` when unknown).
- A viewport other than the design width needs `--allow-scaling`, which
  asserts every length scales with the viewport — true of a page written in
  viewport-relative units, not of pages in general.

`reference/collector.js` produces this file from a page given a map from
source id to CSS selector; the project keeps that map in
`.figma-ir/maps/<section>.json`.

## Exclusions are claims, and claims are checked

A rendered node with geometry that was neither measured nor excluded is a
coverage gap (`unmeasuredRendered`). Under `--require-coverage` a gap fails
the run. An exclusion excuses a gap only if the slice confirms the claim;
otherwise it appears under `invalidExclusions` with the reason and the gap
stays open.

| kind | shape | passes when |
|---|---|---|
| `asset-internal` | `{ sourceId }` | the nearest measured ancestor is an asset: a vector-family node, an image fill, or a container holding nothing else. A label under a measured card is not inside a picture. |
| `collapsed-into` | `{ sourceId, targetSourceId }` | direct parent and child with identical boxes, the wrapper carrying no padding, clip, effects, opacity or rotation, and exactly one rendered child. |
| `derived-from-children` | `{ sourceId }` | an auto-layout frame with nothing of its own (no paint, clip, effects, opacity, rotation, scrolling, non-pass-through blend, no layout value outside the known set) whose box is exactly its rendered children plus its padding, every child directly measured, none absolute or rotated, none cut by the slice budget. Slack is alignment, and alignment is information. |
| `native-control-internal` | `{ sourceId, targetSourceId }` | a text node inside a measured element whose `tagName` is `SELECT` — the browser renders that text; there is no element to measure. |

Do not stretch a kind to fit; a gap you cannot explain with one of these is
a gap the record reports.

## Reading the report

- `mismatches`: per node and slot (`x`, `y`, `width`, `height`), expected
  against measured with the delta. Any mismatch fails.
- `textMetricDeltas`: every vertical measurement of auto-resizing text, pass
  or fail, with its classification. Text `y`/`height` gets a budget
  (`--text-tolerance` + `--text-tolerance-per-line` × estimated lines)
  because the design tool rounds line and cap heights its own way; `x` and
  `width` never do.
- `wrapFlips`: a text height that moved by about a whole line — the wrap
  count changed. Always fails, whatever the budget.
- `invalidExclusions`, `unknownSourceIds`, `withoutExpectedBox`,
  `sharedElements`: a wrong mapping. Always fails.
- `unmeasuredRendered`: coverage. Informs unless `--require-coverage`.
- `omitted`: what never entered the comparison (hidden, depth, budget). A
  `match` with `omitted.maxNodes > 0` compared a cut slice.
- `scaled`, `viewportWidthPx`, `tolerancePx`, `measuredSchemaVersion`: the
  conditions, so a saved report is auditable on its own.

One run per breakpoint root. A claim the projection left `unknown` on one
breakpoint can look right there by coincidence; verify it on every
breakpoint.

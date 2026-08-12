# The projection, and what you owe it

`figma-ir export-projection` translates the slice's layout declarations into
web layout meaning, node by node, and verifies each claim against the
geometry before calling it known. It prints identity (`schemaVersion`,
`translatorVersion`, `canonicalHash`, `snapshotId`, `projectionRequestHash`,
`projectionHash`, the `request` it answered), then `nodes`, `diagnostics`
and `obligations`.

## Per node

- `participation`: `rendered` or `not-rendered`.
- `container`: `non-flex` (no auto-layout), `unknown` with a reason, or
  `flex` with `direction`, `wrap`, and four claims each carried as
  `known` / `unknown` / `absent`: `mainAlign` (`start`, `center`, `end`,
  `space-between`), `crossAlign`, `mainGapPx`, `crossGapPx`; plus `padding`.
  `mainGapPx` is the gap to *write*, not the gap declared: under
  space-between it is `0`, because the declared spacing is inert there.
- `widthPlan` / `heightPlan`: `fixed` (with px), `intrinsic` (hug),
  `stretch` (fill on the parent's cross axis), `flex` (fill on the main
  axis), or `unknown` with a reason.
- `wrap`: for a wrapping row inside the supported subset, the observed line
  arrangement and a reusable rule (track size, packing gap, distribution for
  full and partial lines, line gap), each part with its own certainty and a
  `verification` per claim.

## What `unknown` means, by reason

- `UNSUPPORTED_LAYOUT` — the declaration is outside what the translator
  handles (grid, an unrecognised value, a wrap container outside the subset).
  The boxes are still facts; how they become a layout rule is not decided
  here, and is resolved like any other unknown (profile, question, or a
  marked assumption).
- `PARENT_LAYOUT_REQUIRED` — a fill whose meaning depends on a parent the
  slice does not have.
- `GEOMETRY_MISSING` — a claim that needs boxes the nodes do not carry.
- `GEOMETRY_CONTRADICTION` — the declaration predicted positions the
  children do not have. The claim is demoted, and a diagnostic with
  `evidence` says which check failed (see below).
- `GAP_UNOBSERVED` — a gap claim with a single child: nothing to observe it
  on. The declared value is still in the slice (`layout.itemSpacing`), but it
  is a declaration, not a verified value; writing it is an assumption, and
  is marked as one.
- `TEXT_METRICS_REQUIRED` — a pixel value that depends on font metrics.
- `DEPTH_LIMIT_EXCEEDED` — the children were cut out of the slice.

## Diagnostics and evidence

Every `GEOMETRY_CONTRADICTION` carries `evidence` with a `kind`:
`stack-origin` (the children do not start where the distribution predicts;
`notRenderedChildCount` says how many hidden children the container has, as a
fact, not as the cause), `stack-gap` (an adjacent pair is not the declared
gap apart), `stack-cross` (a child is not where the cross alignment
predicts), `axis-size` (a stretch or flex size that does not match), and the
`wrap-*` kinds. Each names the axis, the child, and observed against
predicted px. Read the `kind` before deciding what to re-check; the sentence
in `detail` is a summary.

Gap and alignment are verified separately: a wrong gap does not take the
alignment down with it. A contradiction on one breakpoint is a fact about
that breakpoint; do not resolve it by looking at another one.

## Obligations

`obligations` is the finite list of claims you must account for. Each has a
stable `projectionFactId` (`<sourceId>#<claim>`) and a `claim`:

- `container`, `width`, `height`, `wrap` — the known plans above; and
- `preserveIntrinsicCrossSize` with an `axis` — a hugged child on its
  parent's cross axis, which on the web would stretch by default. Meet it
  with `align-self`, the container's `align-items`, or an explicit size, as
  the target profile prefers.

Write a ledger and run `check-obligations`:

```json
{
  "schemaVersion": 1,
  "projectionHash": "<projectionHash from the export>",
  "entries": [
    { "projectionFactId": "12:34#width", "status": "consumed" },
    { "projectionFactId": "12:34#preserveIntrinsicCrossSize", "status": "not-applicable", "reason": "the container sets align-items: flex-start for every child" },
    { "projectionFactId": "12:35#container", "status": "exception", "reason": "the design pins this row absolutely; rebuilt by hand, pending review" }
  ]
}
```

A reason is optional on `consumed` and required on `not-applicable` and `exception`. An
exception fails the run and is recorded as a candidate: someone approves it
later, or the code changes. An entry for an obligation that was never issued
fails too — the ledger cannot invent duties. The check compares the ledger's
`projectionHash` with the projection's; a ledger written against an older
projection is refused.

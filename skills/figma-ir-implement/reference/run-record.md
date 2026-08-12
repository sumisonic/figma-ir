# Run record

One per run, written last, read first by the next run. It quotes the design,
so it lives outside any public repository (`.figma-ir/runs/` in the project,
ignored by git, or wherever the project keeps private notes). It is kept
for the next run: a record removed together with a worktree leaves that run
nothing to follow, so it is written where the profile says kept artifacts
live.

```markdown
# <section> — <date>

## Inputs
- fileKey: … / roots: … / snapshotId: … / sourceVersion: … / geometry: none | paths
- snapshot file: … (kept: a run that follows a revision compares against this file)
- roots read: … (passed to export-slice and every later command; say so when they are the acquired roots)
- config / budget passed to every command: …
- slice: schemaVersion …, sliceHash … / projection: schemaVersion …, translatorVersion …, projectionHash …
- verify-fresh: fresh at <time> against version …
- profile: .figma-ir/target-profile.md as of <commit> (stands in for a target hash until the profile is machine-readable)
- previous snapshot: file … / snapshotId … / sourceVersion … (or: none, not compared — why)
- snapshot diff: schemaVersion … / diffHash …
- comparison scope: common roots … / before-only roots … / after-only roots …
- not judged by the comparison: movementUnknown …, unobserved …, rejections that changed … (or: none)
- roots that only moved on the canvas: … (or: none)

## Questions asked
<count>. <what, and the answers>

## Assumptions
For each: the assumption, why, what would falsify it, whether it was checked.

## Unknowns in the projection
For each node built: what was unknown, the reason code, what was done.

## Obligations
check-obligations: accounted | unaccounted. Counts: consumed / not-applicable / exceptions.
Exceptions listed with their reasons.

## Verification
Measured: yes | no (why). Per breakpoint: verdict, mismatches, wrap flips,
invalid exclusions, unmeasured nodes, omitted counts. Residuals explained.
- roots not measured:
  - rootId: …
    reason: …

## Values the IR did not carry
What was needed and not there, and how it was obtained (asset export, a
question, an assumption). "None" is a valid and useful answer.

## What did not go well
Tooling, environment, misreadings — anything the next run should know.
```

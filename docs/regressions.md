# Regression ledger

Each entry is a contract this codebase must keep, learned from a failure that
actually happened. The entries are anonymized: they record the general shape of
the input, what went wrong, and the contract that now prevents it — never the
project, the file, or the exact values involved.

Tests reference these IDs. A test carrying a REG id may only be removed when
the contract itself is superseded, and this ledger says by what.

---

## REG-ROUND-001 — numbers whose text form is already exponential

**Observed failure.** A node carried a rotation so close to zero that its
JavaScript string form was exponential (`~2e-16`). Rounding shifted the decimal
exponent by appending `e<n>` to that string, producing text that is not a
number. Every conversion of the page failed with NaN.

**Why hand-written tests missed it.** Nobody writing "a rotation" imagines a
denormal-scale float; designers produce them by nudging elements back to
straight.

**Contract.** Rounding must accept any finite IEEE double. Exponent shifts
operate on mantissa and exponent separately, never on the raw string form.

**Removal condition.** Only if slot-precision rounding is replaced by a decimal
arithmetic library with its own coverage of denormal-scale input.

---

## REG-ORDER-002 — the child array is z-order, not reading order

**Observed failure.** Sections read in child-array order came out wrong: the
array is paint order (z-order), and in a real page it disagreed with vertical
position in several places including the artboard root itself. A consumer that
trusted the array produced sections in a shuffled sequence.

**Contract.** Anything that means "the first section" must be derived from
geometry (top-to-bottom, then left-to-right, with a total tie-break), never
from array position. Where geometry cannot support an ordering claim
(overlapping or rotated siblings), the order must say so rather than pretend.

**Removal condition.** Only if the source API starts guaranteeing reading order,
which it has never done.

---

## REG-RESP-003 — most layer names are auto-generated and differ per breakpoint

**Observed failure.** Well over half the distinct layer names in a real page
were editor-generated (`Frame <number>`), and those names differ between
breakpoint variants of the same design. Matching elements across breakpoints by
name path therefore fails for most of the tree — and an early implementation
reported the unmatched paths as "absent by design", a claim the data cannot
support: a removed element and a renamed container look identical from names
alone.

**Contract.** Cross-breakpoint slots are published only where the name path
resolves uniquely in every member. Everything else is a diagnostic, and the
group reports how much of its tree corresponded so a reader can tell a small
design from a poorly-named one. Absence is never inferred from a missing name
path.

**Removal condition.** Only if correspondence gains a stronger signal than
names (explicit mapping, component identity with a confirmed enclosing
instance) — the contract then moves to that mechanism, it does not disappear.

---

## REG-RESP-004 — one artboard named outside the convention

**Observed failure.** Three of four breakpoint artboards followed the naming
convention; the widest one had been renamed by hand during a redesign and did
not parse. Grouping silently produced a three-member group, and an
implementation built on it would have discovered the fourth breakpoint after
the fact — which is the recorded incident this rule exists for.

**Contract.** A root whose name does not match the declared pattern is never
guessed into a group. The gap is reported (group completeness), and the project
may declare the exception explicitly — a node id and a breakpoint, one line —
at which point the group is complete and the finding goes silent.

**Removal condition.** Only if grouping stops being name-driven entirely.

---

## REG-STYLE-005 — one style name carrying two different fonts

**Observed failure.** A text style name was used at every breakpoint, but at
exactly one of them the declarations under that name used a different font
family. No single node reveals this; it only appears when the declarations
under one name are collected and compared.

**Contract.** Text style facts aggregate every distinct font declaration seen
under one style id, keyed by family, PostScript name, weight and size — so a
rule can compare like with like across breakpoints. Aggregation must not
collapse declarations that differ in any compared field.

**Removal condition.** Only if the source API starts exposing per-style
resolved typography directly.

---

## REG-STYLE-006 — style names missing a required segment

**Observed failure.** A large batch of text styles was missing the final
segment of a four-level naming convention. They were found by a person reading
the entire file, after implementation had already started against it.

**Contract.** Style names are validated against the declared convention and
violations are reported with the style, not the nodes using it, as the target.
Names are never normalized into conformance — a corrected name in our output
deletes the request that the file be fixed.

**Removal condition.** Only if naming validation moves into the design tool
itself.

---

## REG-ACQ-007 — a snapshot spanning two file versions

**Observed failure class.** Acquisition takes several requests, and the file
can be saved between them. The result holds a tree from before the edit and
styles from after it: a document that never existed, with no error anywhere.

**Contract.** Acquisition brackets its reads with a version check and refuses
to return a snapshot that spans two versions. A missing requested node, or two
roots disagreeing about one style id, is an infrastructure failure
(INCOMPLETE_EXECUTION), never an empty result.

**Removal condition.** Only if the source API returns data and version
atomically in one response.

---

## REG-CLI-008 — stdout truncated by process.exit

**Observed failure.** The command line wrote a large payload and called
`process.exit`, which terminates before Node flushes a pipe. A multi-megabyte
document arrived as exactly 65,536 bytes on the far end — with a successful
exit code, so nothing downstream had any reason to distrust it.

**Contract.** The CLI entry point sets `process.exitCode` and lets the event
loop drain; it never calls `process.exit` after writing output. The guard test
runs the real binary through a real pipe, because nothing short of that
reproduces the failure.

**Removal condition.** Only if output moves to an explicitly flushed/awaited
write path with its own pipe-backed test.

---

## REG-FACT-009 — IEEE noise in a derived difference of two rounded values

**Observed failure.** Relative position is the difference of two absolute
coordinates, both already rounded to the px slot. The difference itself is
not: 40.3 − 10.1 is 30.199999999999996 in IEEE arithmetic, and a value of
that kind was written verbatim into consumer output. Anything keyed on it —
column clustering, hashes over derived geometry — sees noise where the
design has a clean value.

**Contract.** Every derived number is re-rounded to its slot at the point of
derivation. Rounding the inputs is not rounding the outputs; subtraction,
scaling, and ratio all reintroduce noise.

**Removal condition.** Only if derived geometry moves to integer or decimal
arithmetic end to end.

---

## REG-CANON-010 — an unrecognised enum value cast into a closed union

**Observed failure class.** An axis-alignment string from the source API was
cast into the closed union type with `as`, with absence defaulting to the
documented default. A value outside the set — a future API addition, or a
variant we never sampled — would wear a known member's type and take that
member's branch in every downstream consumer, silently.

**Contract.** A closed union is validated against its value set at the
adapter. Absence maps to the documented default; an unrecognised present
value maps to `unknown`, which downstream layers must treat as
not-translatable (fail closed), never as any known member.

**Removal condition.** Only if the source API publishes a machine-readable
schema whose enums are consumed at build time.

---

## REG-CLI-011 — options the parser accepted and nobody read

**Observed failure.** The argument parser accepted any `--option` and each
command read the ones it knew. `--max-nodes` was read by two commands and
not by the two that cut a slice, so a caller who hit the default node budget
on a wide request could not raise it — the option was taken and ignored, and
a typo in any option name was ignored the same way. Asking for `--help`
reached the command, which demanded its required options first. Meanwhile
the usage text said only one command needed a credential when three did.

**Why hand-written tests missed it.** Every test passed the options its
command read. Nothing exercised an option a command did *not* read, because
from the inside there is no such thing.

**Contract.** Options are declared per command. One the command does not
take, one given twice, or one missing its value is an error. `--help` and
`help` print usage to stdout with a zero exit from anywhere on the line.
Every command that cuts a slice reads the same budget options, and a report
computed on a cut slice says what the budget kept out.

**Removal condition.** Only if argument parsing moves to a library that
declares options per command and rejects unknown ones with its own tests.

---

## REG-VERIFY-012 — an exclusion kind that verified nothing, and a gap that had no kind

**Observed failure.** Scored runs under required coverage could not reach a
clean exit on two recurring structures: the displayed value of a native
`<select>` (text the browser renders with no element of its own) and an
auto-layout wrapper the implementation had folded into its children's
positioning (no box to measure, nothing lost). Neither had an exclusion kind,
so the choice was to fail the gate or to misfile them under `asset-internal`
— which, on inspection, checked only that *something* above the node had
been measured. A label under a measured card passed as "inside an asset".

**Why hand-written tests missed it.** The tests exercised each kind with the
input its author had in mind; nobody wrote the input a kind should refuse.

**Contract.** Every exclusion kind names a condition the slice can check,
and the check is written against the input that should fail it.
`asset-internal` requires the nearest measured ancestor to be an asset (a
vector-family node, an image fill, or a container of nothing else).
`derived-from-children` requires an auto-layout frame with nothing of its
own whose design box is exactly its rendered, directly measured children
plus padding — slack is alignment, and alignment is information.
`native-control-internal` requires text inside a measured element the
collector reports as a native control. A claim that cannot be verified is
an open coverage gap, never an excuse.

**Removal condition.** Only if exclusions are replaced by a mechanism in
which the collector proves each gap (for instance by reporting the DOM
structure it walked) and the verifier no longer needs to trust a claim.

---

## REG-CANON-013 — a field the source returned and the canonical layer dropped, reported downstream as "the IR does not carry it"

**Observed failure.** Two facts the API returns never reached the canonical
document: per-side stroke weights (so an underline-only border and a full
box were the same IR) and per-range text style overrides (reduced to one
boolean, so whether a word was underlined could only be learned from the raw
snapshot). Consumers wrote "the IR has no such value" into their own
documentation, built approximations, and had the work sent back — the value
had been in the response the whole time.

**Why hand-written tests missed it.** The adapter's tests checked that what
it kept was kept. Nothing checked what it left behind against what the
source offers.

**Contract.** A field the source documents as returned is either carried
by the canonical layer (in its declared, hashed subset) or listed as
deliberately dropped with the reason. Per-side stroke weights are kept
beside the single weight, never expanded from it or into it. Per-range
overrides are kept as maximal runs over the source's override array,
recording what each entry says and `unstated` where it says nothing —
inheritance is not documented by the source and is not assumed here. An
override id the table does not define is `unknown`, never the base style.
The canonical, facts and slice schema versions rise together when the
subset grows, so a hash from before cannot equal one from after.

**Removal condition.** Only if the canonical subset is generated from the
source's published schema, with the drop list derived rather than written.

---

## REG-PROJ-014 — a contradiction that named the wrong check, and a duty nobody was told about

**Observed failure.** A stack's main-axis gap matched at every breakpoint,
yet the projection said "children do not sit where start with the declared
gap predicts" — the cross axis had failed, and the sentence sent the reader to
re-measure the gap. A second container declared space-between over one
visible child and reported a contradiction with no mention of the two
hidden siblings that explained it. Separately, `intrinsic` on a child's
cross axis was read as "nothing to do" and the element stretched to its
parent's width by the browser's default; the design had a hug, and the
page shipped with full-width labels.

**Why hand-written tests missed it.** The tests asserted that a
contradiction was raised, not what it was made of. Nothing checked that
the gap claim survived a failed alignment claim, because one prediction
carried both.

**Contract.** Every geometry contradiction carries evidence naming the
check (`kind`), the axis, the child, and observed against predicted; a
contradiction without evidence does not decode. A stack's gap and its
alignment are verified separately and demoted separately; a gap with a
single child is unverified (`GAP_UNOBSERVED`), not known. Hidden children
are counted as a fact on the evidence, never asserted as the cause. A HUG
child on its parent's cross axis issues `preserveIntrinsicCrossSize` with
the axis named, so a consumer must account for it like any other claim.

**Removal condition.** Only if the projection is replaced by one that
verifies against a rendered layout engine rather than predicting from
declarations, and carries that engine's trace instead.

---

## REG-ACQ-015 — a field the source returns only on request, never requested, read as "the IR has no shape"

**Observed failure.** Vector paths come back from the nodes endpoint only
when the request asks for them. The acquisition never asked, so no node
ever carried a shape, and consumers concluded the IR could not carry one —
icons were approximated from existing assets or fetched by hand, and one
section could not be called finished because its icons had colours but no
outline.

**Why hand-written tests missed it.** The fixture returned whatever the
test author wrote into it, requested or not; nothing modelled the API's
"only on request" behaviour, so "we never asked" was indistinguishable
from "there is nothing".

**Contract.** Acquisition records what it asked for (`geometry`), in the
snapshot's identity and in the canonical provenance. A node's paths are one
of three things: known (asked for; possibly empty), unknown with
`GEOMETRY_NOT_ACQUIRED` (not asked for), or absent (text, whose outlines
are font output). Paths are off by default because they multiply the size
of a production snapshot; the default is a cost decision the identity makes
visible, not a statement about the design. The fixture client behaves as
the API does, so a test cannot see paths it did not request.

**Removal condition.** Only if the source returns paths unconditionally, or
acquisition always requests them.

---

## REG-FACT-016 — a frame's width taken as a design value when it was the width of the spill

**Observed failure.** A horizontally scrolling row is drawn in the design
with its cards running past the frame, so the frame's width in the file is
the width of the spill rather than of the viewport the row will scroll in.
A verification that took that width as the expected value compared the
implementation against the wrong number and reported a wall of width
mismatches; the reader worked around it by hand.

**Contract.** The facts layer reports how far the rendered, in-flow
children of a node reach past its own layout box, per side, with the
children named, as an observation on every node. Missing geometry on the
node or any such child leaves it unknown rather than partially summed.
What the spill means — a scroller, a clip, a mistake — is not decided
here; it is read together with `overflowDirection` and `clipsContent` by
the consumer.

**Removal condition.** Only if the source exposes the intended viewport of
a scrolling frame directly.

---

## REG-CONF-017 — configuration that could not fail

**Observed failure class.** A rule took a `namePattern` parameter it never
read, so a project could set it to anything and see no difference. A name
pattern with a misspelled placeholder compiled to a matcher that matched
nothing, so every root went silently ungrouped and the rules that read
groups found nothing to say. A naming rule skipped every style whose first
segment was not the configured group, so a file full of styles from nowhere
passed. A rule that read a convention checked for it inside its loop, so on
a file with nothing to loop over it reported as applied and passed without
the convention ever having been declared. In each case the configuration
looked complete and did nothing.

**Contract.** Every configured value is either used or refused. A name
pattern is validated when the configuration loads — placeholder syntax,
uniqueness, a literal between neighbours, only the placeholders the context
allows, a vocabulary only for a segment that exists — and a pattern that
cannot match is an error, not an empty result. A rule that checks names
checks every referenced style and excuses exceptions by explicit prefix. A
convention is declared once, in the fact configuration, and the facts say
which were declared; a rule that reads one refuses to run before it scans
anything when none was. No rule carries a second copy of a convention that
could disagree with the facts.

**Removal condition.** Only if configuration is generated from a schema that
rejects unknown and unused keys at the source.

## REG-DISC-018 — the entry point showed what could not be acquired and hid what could

**Observed failure.** A page kept its views inside sections, as large files
are organised. `list-frames` listed the sections — as direct children of
the page, with their type — and stopped there, so the frames inside them
had no id anywhere in the tool's output; a consumer read the raw snapshot
by hand to find them. Handing a section in as a root instead was rejected
as an unsupported node type, with a detail that said only that. The command
whose purpose is to remove the manual step of finding ids had put it back.

**Why hand-written tests missed it.** Every test page had its frames as
direct children. Nothing modelled a section, so "the page's children" and
"the page's frames" were the same set in every fixture.

**Contract.** `list-frames` descends into sections, level by level: one
shallow read per bounded batch of section ids per level of nesting, never
one deep read of the page. Because that is several reads of one file, they
are bracketed by a version check, as an acquisition is: the version is
taken before the page is read — not after, or a save between the page and
its sections would slip through — and checked again once the sections have
been read. A listing that spans two versions fails with
`INCOMPLETE_EXECUTION` rather than describing a page that never existed.
A section the page listed and the read did not return is not an empty
section — an empty one answers with `children: []` — so the listing fails
the same way and says to retry; a page or section that answers with no
`children` key at all is a shape this code does not know and fails as
`SUPPLY_CHAIN_ERROR`. An id met twice is the
source contradicting itself and is refused (`SUPPLY_CHAIN_ERROR`), never
resolved by keeping one occurrence. A frame inside a section lists with its
`sectionPath`, outermost first; direct children carry an empty path. The
sections themselves list apart, under `sections`, and never among the
frames: a section is an organising container, not a root, and a section
whose name happens to fit the naming convention is not grouped as if it
were a view. The wire spells out `sectionPath` on every entry and
`sections` on every listing, empty or not, and carries `schemaVersion: 2`;
the unversioned shape before it, in which sections sat among the ungrouped
children and `frameCount` counted the page's direct children, counts as 1.
A section handed in as a root is still rejected — it is not a design node —
but the rejection says that the frames inside it are what to acquire, and
where they are listed; a section met deeper in a tree gets the plain
statement, since it is not one the listing reaches. That reason reaches
the person: a slice asked for a root the adapter rejected fails with the
rejection's reason and detail beside the id, not with the same words as a
root the file never had.

**Removal condition.** Only if sections become acquirable roots, or the
source stops nesting frames inside them.

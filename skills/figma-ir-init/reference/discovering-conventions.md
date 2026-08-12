# Discovering a naming convention without assuming one

`list-frames` reports everything a page holds — frames and any stray
shape placed on it — descending into sections. Each entry carries its
name, type, measured size and the `sectionPath` that leads to it. A convention, if the file has one, shows up as a token
in the names that clusters by width. The steps below find it and state the
evidence; the project decides whether to declare it.

## 1. Tabulate

For each page that holds design (skip covers, assets, exports), collect
`(name, type, measuredWidth, sectionPath)` for every entry under
`ungrouped`. The `sections` list says how the page is organised and is
useful context for the record; a section is not a candidate root, and its
name plays no part in the pattern. Keep the counts: how many frames, how
many widths occur and how often.

## 2. Look for the breakpoint token

Split each name on the separators it uses (`-`, `_`, `/`, ` `) and ask,
for the first and the last token:

- does the same token always come with the same width? (`narrow` → 320
  every time, `wide` → 1280 every time)
- is the width itself in the name? (`nav_375`, `hero_768`)

A token that clusters by width is a `{breakpoint}`; a number that equals
the measured width is a `{width}`. What remains is the `{section}`.
Everything between is a literal for the pattern.

Two files, two outcomes, both fine (the names and widths are made up for
the illustration; nothing here is a default):

```
name                width      →  pattern "{section}-{breakpoint}"
home-narrow          320          breakpoints: narrow=320, wide=1280
home-wide           1280
about-narrow         320

name                width      →  pattern "{section}_{width}"
home_375             375          breakpoints: sm=375, md=768, lg=1024
home_768             768
home_1024           1024
```

A file may mark every breakpoint but one. The token still clusters by
width; the names without it cluster too, at one other width, and each has
a marked sibling:

```
name                width      →  pattern "{section}_{breakpoint}"
home_narrow          320          breakpoints: narrow=320, wide=1280
home                1280          unmarked: wide
about_narrow         320
about               1280
share-image          600          (no sibling, another width: not a view)
```

That is a convention, and `unmarked` declares it: the slot of the names
that carry no marker. A frame the pattern does not describe joins that
slot only when it is exactly as wide as the slot is declared to be, and
its whole name is the section — so the bare names have to equal the
section of their marked siblings, which the table shows or does not. The
width is not what finds the convention; the names and the table do, and
the width then keeps out what a page holds under plain names at other
widths. It is a test, not a guarantee. A bare frame that is a view but a
pixel off stays out and leaves its sibling a group missing a breakpoint.
A frame that is not a view but is exactly that wide comes in: under a
name of its own, as a group of one, which shows the same way; under the
name of a section, as that section's view, which does not show at all
unless the real view is there too and the two collide. So read the bare
members of the listing (`matchedBy: unmarked`) against the page before
proposing the declaration, and report what does not belong.

Another outcome is also fine: no token clusters, widths vary freely — the
file is not organised by breakpoint, and the project works per root, with
no `responsive` block (a `namePattern` and a breakpoint table are what
`responsive` requires; `explicit` entries supplement a pattern, they do not
stand alone).

## 3. Count what the candidate explains

Report:

- frames the pattern explains, out of the total;
- frames it does not, with their names (suffixes like `-modal`, working
  material, exports — each is a fact about the file, and the project may
  want some of them declared under `explicit` by id);
- the width per breakpoint token, and whether it is consistent (a token
  that comes with two widths is not a breakpoint, or the file has a
  mistake to report);
- sections with more than one frame per breakpoint. Old versions left
  beside new ones are common; figma-ir will report them as ambiguous rather
  than pick one, so the implementation runs must name roots by id.

## 4. Try it, propose, then declare

`list-frames` takes the candidate directly — `--pattern` with the template,
`--breakpoints` with `slot=px` pairs, and `--unmarked` with the slot of the
bare names where the file has them — and answers with `groups`,
`ungrouped` and `duplicateBreakpoints`, which are exactly the counts above.
Each member of a group says which declaration put it there (`matchedBy`:
`pattern` or `unmarked`), and for the bare names the listing applies the
same test, with the same rounding, as the facts will once the
configuration is written.
Run it before anything is written. Then show the table and the counts,
with the names quoted as JSON string literals so a name containing a
newline, a `#` or a quote cannot change the document's structure; propose
the pattern and the breakpoint table in the words `config.yaml`
uses. When the person confirms, write it. A pattern that could not match (a
misspelled placeholder, two placeholders touching) is refused when the
configuration loads, so a typo shows up immediately.

The same method applies to text style names once a slice exists: tabulate
`textStyle.name`, split on the separator, look for segments with a closed
vocabulary (a breakpoint, a language, a weight), and propose
`styleNames.pattern` with `allowed` for those segments. Say how many names
the sample holds and which roots they came from: a snapshot carries only
the styles its roots reference, so a small sample supports a candidate,
not a claim about the file. A file whose styles are named freely gets no
`styleNames`, and the naming rules are left out of `rules.yaml`.

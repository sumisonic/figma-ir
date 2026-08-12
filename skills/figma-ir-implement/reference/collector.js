/**
 * Reference collector: measures a rendered page into the measured-geometry
 * file (schema version 2) that `figma-ir diff-geometry` reads.
 *
 * Run in the browser, on the page rendered at the design width, after fonts
 * and images have loaded. Takes a map from figma-ir source id to a CSS
 * selector; the project keeps that map beside the section it verifies.
 *
 *   const measured = collectMeasuredGeometry({
 *     rootSourceId: '1:1',
 *     designWidthPx: 375,
 *     map: { '1:1': '#section', '1:2': '#section > h2', '1:3': '#section .lead' },
 *     exclusions: [{ sourceId: '1:4', kind: 'asset-internal' }],
 *   })
 *   copy(JSON.stringify(measured))
 *
 * Coordinates are CSS px from the root element's border-box origin, unscaled.
 * A selector that matches nothing is reported, not skipped: a node you meant
 * to measure and did not is a coverage gap the report should show.
 */
export function collectMeasuredGeometry({ rootSourceId, designWidthPx, map, exclusions = [] }) {
  const rootSelector = map[rootSourceId]
  if (rootSelector === undefined) throw new Error(`the map has no selector for the root ${rootSourceId}`)
  const rootMatches = document.querySelectorAll(rootSelector)
  // The origin of every coordinate: an ambiguous root would make the whole
  // file relative to whichever element came first.
  if (rootMatches.length !== 1) {
    throw new Error(`the root selector ${rootSelector} matches ${rootMatches.length} elements; it must match exactly one`)
  }
  const origin = rootMatches[0].getBoundingClientRect()

  const elements = new Map()
  const missing = []
  const entries = []
  for (const sourceId of Object.keys(map).sort()) {
    const matches = document.querySelectorAll(map[sourceId])
    if (matches.length !== 1) {
      missing.push({ sourceId, selector: map[sourceId], matched: matches.length })
      continue
    }
    const element = matches[0]
    // The same element answering for two nodes is a mapping error the report
    // catches through `element`; the identity is a counter, which is enough.
    if (!elements.has(element)) elements.set(element, `e${elements.size + 1}`)
    const rect = element.getBoundingClientRect()
    entries.push({
      sourceId,
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
      element: elements.get(element),
      tagName: element.tagName ? element.tagName.toUpperCase() : null,
    })
  }
  if (missing.length > 0) {
    // Loud, so a typo in a selector does not read as a node you chose not to measure.
    console.warn('collectMeasuredGeometry: selectors that did not match exactly one element', missing)
  }
  return {
    schemaVersion: 2,
    designWidthPx,
    viewportWidthPx: window.innerWidth,
    rootSourceId,
    entries,
    exclusions,
  }
}

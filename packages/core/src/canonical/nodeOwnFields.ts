/**
 * A node's own fields, as the content hash sees them.
 *
 * Kept apart from the adapter, and off the package's public surface, because
 * two things must agree on what "a node's own fields" are: the hash, and the
 * snapshot diff that explains why two hashes differ. A second list written
 * for the diff would drift from this one the first time a field was added —
 * the diff would then call two nodes equal that hash differently, or the
 * reverse, and nothing would say so.
 */
import type { CanonicalValue } from '../determinism/canonical.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import { CANONICAL_SCHEMA_VERSION, type CanonicalNode, type StyleRef, type StyleValue } from './document.js'

const styleValueForHash = (value: StyleValue | StyleRef): CanonicalValue =>
  value.kind === 'token'
    ? { kind: value.kind, styleId: value.styleId, name: unsafeUnwrap(value.name), styleType: value.styleType }
    : (value as unknown as CanonicalValue)

/**
 * The fields that make up a node's own identity, children excluded.
 *
 * The schema version is part of the payload so that extending the subset later
 * cannot make a v1 branch hash equal to a v2 branch that happens to agree on
 * the fields v1 knew about.
 */
export const canonicalNodeOwnFields = (node: CanonicalNode): CanonicalValue =>
  ({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type: node.type,
    name: unsafeUnwrap(node.name),
    selfVisible: node.selfVisible,
    effectiveVisible: node.effectiveVisible,
    geometry: node.geometry === undefined ? null : { ...node.geometry },
    renderBounds: node.renderBounds === undefined ? null : { ...node.renderBounds },
    rotation: node.rotation,
    opacity: node.opacity,
    blendMode: node.blendMode,
    layout: { ...node.layout, padding: { ...node.layout.padding }, constraints: node.layout.constraints ?? null },
    text:
      node.text === undefined
        ? null
        : {
            characters: unsafeUnwrap(node.text.characters),
            styleRef: node.text.styleRef === undefined ? null : styleValueForHash(node.text.styleRef),
            style: {
              ...node.text.style,
              fontFamily: unsafeUnwrap(node.text.style.fontFamily),
              fontPostScriptName:
                node.text.style.fontPostScriptName === undefined
                  ? undefined
                  : unsafeUnwrap(node.text.style.fontPostScriptName),
            },
            hasCharacterOverrides: node.text.hasCharacterOverrides,
            characterOverrideRuns: node.text.characterOverrideRuns.map((run) => ({
              start: run.start,
              end: run.end,
              overrideId: run.overrideId ?? null,
              textDecoration: run.textDecoration,
            })),
            // The scan is a diagnostic about the text, not part of what the
            // text is; letting it into the hash would make a tweak to the
            // heuristic look like a change to the design.
          },
    fills: node.fills.map(styleValueForHash),
    strokes: node.strokes.map(styleValueForHash),
    strokeWeight: node.strokeWeight,
    individualStrokeWeights: node.individualStrokeWeights === undefined ? null : { ...node.individualStrokeWeights },
    strokeAlign: node.strokeAlign,
    cornerRadius: node.cornerRadius,
    rectangleCornerRadii: node.rectangleCornerRadii === undefined ? null : [...node.rectangleCornerRadii],
    effects: node.effects.map((effect) => ({
      ...effect,
      offset: effect.offset ?? null,
      rgba: effect.rgba === undefined ? null : [...effect.rgba],
    })),
    componentId: node.componentId,
    // The paths themselves, not only their hash: a changed drawing is a
    // changed node, and the hash alone would hide which part moved.
    vectorGeometry:
      node.vectorGeometry.kind === 'known'
        ? {
            kind: 'known',
            fill: node.vectorGeometry.fill.map((entry) => ({ path: entry.path, windingRule: entry.windingRule })),
            stroke: node.vectorGeometry.stroke.map((entry) => ({ path: entry.path, windingRule: entry.windingRule })),
            geometryHash: node.vectorGeometry.geometryHash as string,
          }
        : node.vectorGeometry.kind === 'absent'
          ? { kind: 'absent' }
          : { kind: 'unknown', reason: node.vectorGeometry.reason },
  }) as CanonicalValue

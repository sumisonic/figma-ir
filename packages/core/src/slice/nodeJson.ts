/**
 * How a node's fields are written as wire JSON.
 *
 * Shared by the slice and the snapshot diff, and kept off the package's
 * public surface. A consumer reads a slice to implement and a diff to learn
 * what changed; if the two spelled the same paint or the same typography
 * differently, every value in a diff would need translating before it could
 * be found in the slice it describes.
 */
import type { CanonicalValue } from '../determinism/canonical.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import type { CanonicalEffect, CanonicalPaint, CharacterOverrideRun, StyleValue } from '../canonical/document.js'
import type { SliceNode } from './types.js'

/**
 * Every field spelled out (no spread): an absent optional would vanish from
 * the JSON, and two text nodes would disagree about which keys exist.
 */
export const typographyToJson = (typography: SliceNode['typography']): CanonicalValue =>
  typography === undefined
    ? null
    : {
        fontFamily: unsafeUnwrap(typography.fontFamily),
        fontPostScriptName:
          typography.fontPostScriptName === undefined ? null : unsafeUnwrap(typography.fontPostScriptName),
        fontWeight: typography.fontWeight,
        fontSize: typography.fontSize,
        letterSpacing: typography.letterSpacing,
        lineHeightPx: typography.lineHeightPx,
        lineHeightPercentFontSize: typography.lineHeightPercentFontSize ?? null,
        textAlignHorizontal: typography.textAlignHorizontal,
        textAlignVertical: typography.textAlignVertical,
        textAutoResize: typography.textAutoResize ?? null,
        leadingTrim: typography.leadingTrim ?? null,
        opentypeFlags: typography.opentypeFlags === undefined ? null : { ...typography.opentypeFlags },
        textDecoration: typography.textDecoration,
      }

export const strokeWeightsToJson = (weights: SliceNode['individualStrokeWeights']): CanonicalValue =>
  weights === undefined
    ? null
    : { top: weights.top, right: weights.right, bottom: weights.bottom, left: weights.left }

/**
 * Layout with every field present, absent ones as null.
 *
 * Spreading the object was not enough: `undefined` fields vanish under
 * `JSON.stringify`, so a node outside auto-layout came back without
 * `itemSpacing` at all while one inside it had the key. A consumer then cannot
 * read `layout.itemSpacing` without first checking whether the key exists —
 * and the shape of the answer would depend on the answer.
 */
export const layoutToJson = (layout: SliceNode['layout']): CanonicalValue =>
  ({
    mode: layout.mode,
    wrap: layout.wrap,
    primaryAxisAlign: layout.primaryAxisAlign,
    counterAxisAlign: layout.counterAxisAlign,
    counterAxisAlignContent: layout.counterAxisAlignContent ?? null,
    primaryAxisSizingMode: layout.primaryAxisSizingMode ?? null,
    counterAxisSizingMode: layout.counterAxisSizingMode ?? null,
    sizingHorizontal: layout.sizingHorizontal,
    sizingVertical: layout.sizingVertical,
    itemSpacing: layout.itemSpacing ?? null,
    counterAxisSpacing: layout.counterAxisSpacing ?? null,
    padding: { ...layout.padding },
    positioning: layout.positioning,
    layoutAlign: layout.layoutAlign ?? null,
    layoutGrow: layout.layoutGrow ?? null,
    constraints: layout.constraints ?? null,
    overflowDirection: layout.overflowDirection ?? null,
    clipsContent: layout.clipsContent,
  }) as CanonicalValue

export const styleRefToJson = (ref: SliceNode['textStyle']): CanonicalValue =>
  ref === undefined
    ? null
    : ref.kind === 'token'
      ? { kind: 'token', styleId: ref.styleId, name: unsafeUnwrap(ref.name), styleType: ref.styleType }
      : { kind: 'unresolved', styleId: ref.styleId, reason: ref.reason }

/**
 * A paint with every field present, absent ones as null.
 *
 * The old path handed the domain paint to JSON as-is, which dropped whichever
 * optional keys happened to be undefined — and flattened the `raw` wrapper
 * away, so the wire showed `solid` where the domain said "raw, not a token".
 * All three states stay visible now, matching how strokes of text styles read.
 */
export const rawPaintToJson = (paint: CanonicalPaint): CanonicalValue => {
  switch (paint.kind) {
    case 'solid':
      return {
        kind: 'solid',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        rgba: [...paint.rgba],
      }
    case 'gradient':
      return {
        kind: 'gradient',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        gradientType: paint.gradientType,
        stops: paint.stops.map((stop) => ({ position: stop.position, rgba: [...stop.rgba] })),
        handles: paint.handles.map((handle) => ({ x: handle.x, y: handle.y })),
      }
    case 'image':
      return {
        kind: 'image',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        imageRef: paint.imageRef ?? null,
        scaleMode: paint.scaleMode ?? null,
      }
    case 'other':
      return {
        kind: 'other',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        paintType: paint.paintType,
      }
  }
}

export const paintToJson = (slot: StyleValue): CanonicalValue => {
  switch (slot.kind) {
    case 'token':
      return { kind: 'token', styleId: slot.styleId, name: unsafeUnwrap(slot.name), styleType: slot.styleType }
    case 'unresolved':
      return { kind: 'unresolved', styleId: slot.styleId, reason: slot.reason }
    case 'raw':
      return { kind: 'raw', paint: rawPaintToJson(slot.value) }
  }
}

/** One override run, the absent id as null. */
export const characterOverrideRunToJson = (run: CharacterOverrideRun): CanonicalValue => ({
  start: run.start,
  end: run.end,
  overrideId: run.overrideId ?? null,
  textDecoration: run.textDecoration,
})

/** An effect with every field present, absent ones as null. */
export const effectToJson = (effect: CanonicalEffect): CanonicalValue => ({
  type: effect.type,
  visible: effect.visible,
  radius: effect.radius ?? null,
  spread: effect.spread ?? null,
  offset: effect.offset === undefined ? null : { x: effect.offset.x, y: effect.offset.y },
  rgba: effect.rgba === undefined ? null : [...effect.rgba],
  blendMode: effect.blendMode ?? null,
})

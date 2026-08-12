import { describe, expect, it } from 'vitest'

import {
  allowsDownstreamWork,
  INFRASTRUCTURE_REASONS,
  isFailClosed,
  isInfrastructureReason,
  isSemanticReason,
  SEMANTIC_REASONS,
} from './reason.js'

describe('reason codes', () => {
  it('keeps the two families disjoint', () => {
    const semantic = new Set<string>(SEMANTIC_REASONS)
    for (const reason of INFRASTRUCTURE_REASONS) {
      expect(semantic.has(reason)).toBe(false)
    }
  })

  it('classifies a timeout as infrastructure, never as "no match"', () => {
    expect(isInfrastructureReason('CONTRIBUTOR_TIMEOUT')).toBe(true)
    expect(isSemanticReason('CONTRIBUTOR_TIMEOUT')).toBe(false)
    expect(isSemanticReason('NO_COMPONENT_MATCH')).toBe(true)
  })

  it('fails closed on infrastructure reasons only', () => {
    expect(isFailClosed('INCOMPLETE_EXECUTION')).toBe(true)
    expect(isFailClosed('CONTRIBUTOR_TIMEOUT')).toBe(true)
    expect(isFailClosed('NO_COMPONENT_MATCH')).toBe(false)
    expect(isFailClosed('UNSUPPORTED_NODE_TYPE')).toBe(false)
  })

  it('has no duplicates', () => {
    const all = [...SEMANTIC_REASONS, ...INFRASTRUCTURE_REASONS]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('job status', () => {
  it('shuts the gate on partial or failed runs', () => {
    expect(allowsDownstreamWork('complete')).toBe(true)
    expect(allowsDownstreamWork('complete-with-warnings')).toBe(true)
    expect(allowsDownstreamWork('partial-incomplete')).toBe(false)
    expect(allowsDownstreamWork('failed-infrastructure')).toBe(false)
  })
})

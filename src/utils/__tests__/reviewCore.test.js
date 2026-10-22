import { describe, expect, it } from 'vitest'
import {
  COMMENT_STATUS,
  STATUS,
  cloneWorkflow,
  defaultWorkflow,
  normalizeComments,
  normalizeWorkflow,
  statusLabelOf,
  statusTypeOf,
} from '../../stores/reviewCore.js'

describe('reviewCore', () => {
  it('normalizes malformed workflows', () => {
    const workflow = normalizeWorkflow({
      status: 'unknown',
      round: 2,
      history: [{ type: 'submitted', actor: '张三', at: 123 }],
      baseline: { ids: ['a'], sigs: ['s'], labels: ['Car'] },
    })
    expect(workflow.status).toBe(STATUS.DRAFT)
    expect(workflow.round).toBe(2)
    expect(workflow.history[0].type).toBe('submitted')
    expect(workflow.baseline.ids).toEqual(['a'])
  })

  it('clones workflows without sharing arrays', () => {
    const workflow = normalizeWorkflow(defaultWorkflow())
    const copy = cloneWorkflow(workflow)
    copy.history.push({ type: 'approved', at: 1 })
    expect(workflow.history).toHaveLength(0)
    expect(copy.history).toHaveLength(1)
  })

  it('normalizes comments and drops invalid entries', () => {
    const comments = normalizeComments([
      { id: 'c1', frameIndex: 0, text: 'hi', status: 'done', author: 'a' },
      { id: 'bad', frameIndex: 1 },
      { id: 'c2', frameIndex: 2, text: 'x', replies: [{ text: 'r' }] },
    ])
    expect(comments).toHaveLength(2)
    expect(comments[0].status).toBe(COMMENT_STATUS.DONE)
    expect(comments[1].replies).toHaveLength(1)
  })

  it('maps status labels and types', () => {
    expect(statusLabelOf(STATUS.APPROVED)).toBe('已通过')
    expect(statusTypeOf(STATUS.REJECTED)).toBe('danger')
  })
})

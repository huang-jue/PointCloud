import { describe, expect, it } from 'vitest'
import { diffSnapshots, objectSignature, snapshotFrame } from '../diff.js'

const box = (id, x) => ({
  id,
  type: 'Car',
  classId: 0,
  h: 1.5,
  w: 1.8,
  l: 4.2,
  x,
  y: 0,
  z: -0.8,
  ry: 0,
})

const line = (id) => ({
  id,
  shape: 'line',
  type: 'LaneLine',
  classId: 6,
  width: 0.15,
  points: [
    [0, 0, -1.7],
    [10, 0, -1.7],
  ],
})

describe('diff', () => {
  it('detects added / removed / changed objects', () => {
    const prev = snapshotFrame({ objects: [box('a', 1), box('b', 2), line('l1')] })
    const next = snapshotFrame({ objects: [box('a', 9), box('c', 3), line('l1')] })
    const diff = diffSnapshots(prev, next)
    expect(diff.added.map((item) => item.id)).toEqual(['c'])
    expect(diff.removed.map((item) => item.id)).toEqual(['b'])
    expect(diff.changed.map((item) => item.id)).toEqual(['a'])
    expect(diff.counts).toEqual({ added: 1, removed: 1, changed: 1 })
  })

  it('is stable for identical data and sensitive to millimetre changes', () => {
    const a = box('a', 1)
    const b = { ...box('a', 1) }
    expect(objectSignature(a)).toBe(objectSignature(b))
    b.x = 1.001
    expect(objectSignature(a)).not.toBe(objectSignature(b))
  })

  it('handles empty frames', () => {
    const diff = diffSnapshots(snapshotFrame({ objects: [] }), snapshotFrame({ objects: [] }))
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 0 })
    expect(diffSnapshots(null, null).total).toBe(0)
  })
})

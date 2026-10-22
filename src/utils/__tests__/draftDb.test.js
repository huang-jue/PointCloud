import { describe, expect, it } from 'vitest'
import { packLabels, unpackLabels } from '../draftDb.js'

describe('draft labels pack/unpack', () => {
  it('round-trips segments into point arrays', () => {
    const packed = packLabels({
      pointLabels: Int32Array.from([-1, 6, 6, -1, 7]),
      segments: [
        { classId: 6, indices: Int32Array.from([1, 2]) },
        { classId: 7, indices: Int32Array.from([4]) },
      ],
    })
    expect(packed.pointCount).toBe(5)
    const unpacked = unpackLabels(packed)
    expect(Array.from(unpacked.pointLabels)).toEqual([-1, 6, 6, -1, 7])
    expect(Array.from(unpacked.pointSegment)).toEqual([-1, 1, 1, -1, 2])
    expect(unpacked.segments).toHaveLength(2)
  })

  it('handles empty input', () => {
    expect(packLabels(null)).toBeNull()
    expect(unpackLabels(null)).toBeNull()
  })
})

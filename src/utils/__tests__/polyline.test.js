import { describe, expect, it } from 'vitest'
import {
  ARROW_TEMPLATE_NAMES,
  clonePaths,
  polylineCentroid,
  polylineLength,
  rotatePoints,
  scalePoints,
  templatePaths,
  transformTemplate,
} from '../polyline.js'

describe('polyline', () => {
  it('computes length and centroid', () => {
    const points = [
      [0, 0, 0],
      [3, 4, 0],
    ]
    expect(polylineLength(points)).toBeCloseTo(5)
    expect(polylineCentroid(points)).toEqual([1.5, 2, 0])
  })

  it('rotates and scales around the centroid', () => {
    const points = [
      [0, 0, 0],
      [2, 0, 0],
    ]
    const rotated = rotatePoints(points, Math.PI / 2, [1, 0, 0])
    expect(rotated[0][0]).toBeCloseTo(1)
    expect(rotated[0][1]).toBeCloseTo(-1)
    expect(rotated[1][1]).toBeCloseTo(1)

    const scaled = scalePoints(points, 2, [1, 0, 0])
    expect(scaled[0]).toEqual([-1, 0, 0])
    expect(scaled[1]).toEqual([3, 0, 0])
  })

  it('builds every arrow template and clones deeply', () => {
    expect(ARROW_TEMPLATE_NAMES.length).toBeGreaterThan(3)
    for (const name of ARROW_TEMPLATE_NAMES) {
      const paths = templatePaths(name)
      expect(Array.isArray(paths)).toBe(true)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) expect(path.length).toBeGreaterThan(1)
    }
    const moved = transformTemplate('straight', { x: 5, y: 6, z: -1.7, ry: Math.PI / 2 })
    expect(moved.length).toBeGreaterThan(0)
    const copy = clonePaths(moved)
    copy[0][0][0] += 100
    expect(copy[0][0][0]).not.toBe(moved[0][0][0])
  })
})

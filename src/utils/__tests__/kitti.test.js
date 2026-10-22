import { describe, expect, it } from 'vitest'
import {
  kittiLineToObject,
  kittiTextToObjects,
  objectToKittiLine,
  objectsToKittiText,
} from '../kitti.js'

describe('kitti', () => {
  const box = {
    type: 'Car',
    truncated: 0,
    occluded: 1,
    alpha: -1.5,
    bbox2d: [10, 20, 100, 120],
    h: 1.5,
    w: 1.8,
    l: 4.2,
    x: 8,
    y: -2.6,
    z: -0.98,
    ry: 0.25,
    score: 0.9,
  }

  it('round-trips a box through a KITTI line', () => {
    const line = objectToKittiLine(box)
    const parsed = kittiLineToObject(line, () => 3)
    expect(parsed.type).toBe('Car')
    expect(parsed.h).toBeCloseTo(box.h)
    expect(parsed.x).toBeCloseTo(box.x)
    expect(parsed.ry).toBeCloseTo(box.ry)
    expect(parsed.bbox2d).toEqual(box.bbox2d)
    expect(parsed.classId).toBe(3)
    expect(parsed.source).toBe('import')
  })

  it('ignores malformed lines', () => {
    expect(kittiLineToObject('Car 1 2')).toBeNull()
    expect(kittiLineToObject('Car a b c d e f g h i j k l m n')).toBeNull()
  })

  it('parses multi-line text and formats output', () => {
    const text = `${objectToKittiLine(box)}\n${objectToKittiLine({ ...box, type: 'Van' })}\n`
    const objects = kittiTextToObjects(text)
    expect(objects).toHaveLength(2)
    expect(objects[1].type).toBe('Van')
    expect(objectsToKittiText([box]).trim().split(/\s+/)[0]).toBe('Car')
  })
})

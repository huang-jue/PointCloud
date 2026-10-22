import { describe, expect, it } from 'vitest'
import { checkDataset, checkFrame, summarizeIssues } from '../qa.js'

const baseFrame = () => ({
  name: 'frame_000000.bin',
  objects: [
    {
      id: 'a',
      type: 'Car',
      classId: 0,
      trackId: 1,
      h: 1.5,
      w: 1.8,
      l: 4.2,
      x: 0,
      y: 0,
      z: -0.98,
      ry: 0,
      truncated: 0,
      occluded: 0,
      score: 1,
    },
  ],
})

describe('qa', () => {
  it('passes a clean frame', () => {
    const issues = checkFrame(baseFrame(), 0, { sensorHeight: 1.73 })
    expect(issues).toHaveLength(0)
  })

  it('reports invalid size and attribute ranges', () => {
    const frame = baseFrame()
    frame.objects[0].l = 0
    frame.objects[0].truncated = 2
    frame.objects[0].occluded = 9
    frame.objects[0].score = -1
    const issues = checkFrame(frame, 0)
    const rules = issues.map((issue) => issue.rule)
    expect(rules).toContain('size')
    expect(rules).toContain('truncated')
    expect(rules).toContain('occluded')
    expect(rules).toContain('score')
  })

  it('reports duplicate tracks, overlap and track jumps', () => {
    const frame = baseFrame()
    frame.objects.push({ ...frame.objects[0], id: 'b', x: 0.1 })
    const issues = checkFrame(frame, 0)
    expect(issues.some((issue) => issue.rule === 'duplicate-track')).toBe(true)
    expect(issues.some((issue) => issue.rule === 'overlap')).toBe(true)

    const frames = [
      { name: '0', objects: [{ ...frame.objects[0] }] },
      { name: '1', objects: [{ ...frame.objects[0], id: 'c', x: 100 }] },
    ]
    const datasetIssues = checkDataset(frames, { jumpThreshold: 8 })
    expect(datasetIssues.some((issue) => issue.rule === 'track-jump')).toBe(true)
    expect(summarizeIssues(datasetIssues).total).toBeGreaterThan(0)
  })

  it('reports invalid marking geometry and width', () => {
    const frame = {
      name: 'f',
      objects: [{ id: 'm', shape: 'line', type: 'LaneLine', classId: 6, width: 0, points: [[0, 0, 0]] }],
    }
    const rules = checkFrame(frame, 0).map((issue) => issue.rule)
    expect(rules).toContain('geometry')
    expect(rules).toContain('width')
  })
})

/** 标注质量检查（不依赖渲染层，纯数据） */

function labelOf(obj) {
  if (!obj) return 'Object'
  const type = obj.type || (obj.shape === 'line' ? 'LaneLine' : obj.shape === 'arrow' ? 'RoadArrow' : 'Object')
  return `${type}${obj.trackId ? ` T${obj.trackId}` : ''}`
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function boxValid(obj) {
  return ['h', 'w', 'l', 'x', 'y', 'z', 'ry'].every((key) => isFiniteNumber(obj[key]))
}

function boxOverlap(a, b) {
  if (!boxValid(a) || !boxValid(b)) return false
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  const radiusA = Math.min(a.l || 0, a.w || 0) / 2
  const radiusB = Math.min(b.l || 0, b.w || 0) / 2
  const horizontal = Math.hypot(dx, dy)
  const vertical = Math.abs(dz)
  return horizontal < radiusA + radiusB && vertical < (Math.abs(a.h) + Math.abs(b.h)) / 2
}

function markValid(obj) {
  if (obj.shape === 'line') {
    return Array.isArray(obj.points) && obj.points.length >= 2 && obj.points.every(
      (p) => Array.isArray(p) && p.length >= 2 && p.every(isFiniteNumber),
    )
  }
  return Array.isArray(obj.paths) && obj.paths.length > 0 && obj.paths.every(
    (path) => Array.isArray(path) && path.length >= 2 && path.every(
      (p) => Array.isArray(p) && p.length >= 2 && p.every(isFiniteNumber),
    ),
  )
}

/**
 * 检查单帧
 * @returns {Array<{frameIndex, frameName, objectId, objectLabel, severity, rule, message}>}
 */
export function checkFrame(frame, frameIndex, { sensorHeight = 1.73, groundTolerance = 0.4 } = {}) {
  const issues = []
  if (!frame) return issues
  const frameName = frame.name || `frame_${frameIndex}`
  const push = (obj, severity, rule, message) => {
    issues.push({
      frameIndex,
      frameName,
      objectId: obj?.id || null,
      objectLabel: labelOf(obj),
      severity,
      rule,
      message,
    })
  }

  const boxes = []
  const trackSeen = new Map()
  for (const obj of frame.objects || []) {
    if (obj.shape === 'line' || obj.shape === 'arrow') {
      if (!markValid(obj)) push(obj, 'error', 'geometry', '标线顶点数据无效或少于 2 个点')
      if (!(Number.isFinite(obj.width) && obj.width > 0)) {
        push(obj, 'warning', 'width', '标线宽度无效')
      }
      continue
    }

    if (!boxValid(obj)) {
      push(obj, 'error', 'geometry', '框存在非数值/NaN 字段')
      continue
    }
    if (obj.l <= 0 || obj.w <= 0 || obj.h <= 0) {
      push(obj, 'error', 'size', `框尺寸非正：${obj.l}×${obj.w}×${obj.h}`)
    }
    const ground = -Math.abs(sensorHeight)
    const bottom = obj.z - obj.h / 2
    if (Math.abs(bottom - ground) > groundTolerance) {
      push(
        obj,
        'warning',
        'ground',
        `框底 ${bottom.toFixed(2)}m，与地面 ${ground.toFixed(2)}m 相差 ${Math.abs(bottom - ground).toFixed(2)}m`,
      )
    }
    if (obj.trackId) {
      if (trackSeen.has(obj.trackId)) {
        push(obj, 'error', 'duplicate-track', `同一帧内 trackId ${obj.trackId} 重复`)
      }
      trackSeen.set(obj.trackId, true)
    }
    boxes.push(obj)
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].classId !== boxes[j].classId) continue
      if (boxOverlap(boxes[i], boxes[j])) {
        push(boxes[i], 'warning', 'overlap', `与 ${labelOf(boxes[j])} 重叠`)
      }
    }
  }

  return issues
}

/** 检查整个数据集，并补充轨迹跳变 */
export function checkDataset(frames, { sensorHeight = 1.73, jumpThreshold = 8 } = {}) {
  const issues = []
  const tracks = new Map()
  ;(frames || []).forEach((frame, index) => {
    issues.push(...checkFrame(frame, index, { sensorHeight }))
    for (const obj of frame.objects || []) {
      if (!obj.trackId || obj.shape === 'line' || obj.shape === 'arrow') continue
      if (!tracks.has(obj.trackId)) tracks.set(obj.trackId, [])
      tracks.get(obj.trackId).push({ index, obj })
    }
  })

  for (const [trackId, list] of tracks) {
    list.sort((a, b) => a.index - b.index)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const current = list[i]
      if (current.index - prev.index > 1) continue
      const distance = Math.hypot(
        current.obj.x - prev.obj.x,
        current.obj.y - prev.obj.y,
        current.obj.z - prev.obj.z,
      )
      if (distance > jumpThreshold) {
        issues.push({
          frameIndex: current.index,
          frameName: current.obj.name || frames[current.index]?.name || '',
          objectId: current.obj.id,
          objectLabel: labelOf(current.obj),
          severity: 'warning',
          rule: 'track-jump',
          message: `trackId ${trackId} 相邻帧位移 ${distance.toFixed(1)}m，可能跟踪错误`,
        })
      }
    }
  }

  return issues
}

export function summarizeIssues(issues) {
  return {
    total: issues.length,
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
  }
}

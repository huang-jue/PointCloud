/**
 * 帧快照与差异计算（用于审核时展示“本次提交改了什么”）
 *
 * 快照只保存 id / 签名 / 展示名，避免把完整几何写进 localStorage：
 *   snapshot = { ids: [], sigs: [], labels: [] }
 */

function round3(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0
}

/** FNV-1a 32 位哈希，足够区分对象变化且结果紧凑 */
function fnv1a(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function pointsPayload(points) {
  return (points || []).map((p) => [round3(p?.[0]), round3(p?.[1]), round3(p?.[2])])
}

/** 对象几何/类别的稳定签名（保存精度到毫米） */
export function objectSignature(obj) {
  if (!obj) return ''
  let payload
  if (obj.shape === 'line') {
    payload = ['line', obj.classId, obj.type, obj.width, obj.trackId, pointsPayload(obj.points)]
  } else if (obj.shape === 'arrow') {
    payload = [
      'arrow',
      obj.classId,
      obj.type,
      obj.width,
      obj.template,
      obj.trackId,
      (obj.paths || []).map(pointsPayload),
    ]
  } else {
    payload = [
      'box',
      obj.classId,
      obj.type,
      obj.trackId,
      round3(obj.h),
      round3(obj.w),
      round3(obj.l),
      round3(obj.x),
      round3(obj.y),
      round3(obj.z),
      round3(obj.ry),
    ]
  }
  return fnv1a(JSON.stringify(payload))
}

export function objectLabel(obj) {
  if (!obj) return 'Object'
  const type = obj.type || (obj.shape === 'line' ? 'LaneLine' : obj.shape === 'arrow' ? 'RoadArrow' : 'Object')
  return `${type}${obj.trackId ? ` T${obj.trackId}` : ''}`
}

export function snapshotFrame(frame) {
  const objects = Array.isArray(frame?.objects) ? frame.objects : []
  return {
    ids: objects.map((o) => o.id),
    sigs: objects.map(objectSignature),
    labels: objects.map(objectLabel),
  }
}

function toMap(snapshot) {
  const map = new Map()
  const ids = snapshot?.ids || []
  for (let i = 0; i < ids.length; i++) {
    map.set(ids[i], {
      sig: snapshot.sigs?.[i] || '',
      label: snapshot.labels?.[i] || ids[i],
    })
  }
  return map
}

/**
 * 比较两次快照
 * @returns {{added: Array<{id,label}>, removed: Array<{id,label}>, changed: Array<{id,label}>,
 *            counts: {added:number,removed:number,changed:number}, total: number}}
 */
export function diffSnapshots(prev, next) {
  const prevMap = toMap(prev)
  const nextMap = toMap(next)
  const added = []
  const removed = []
  const changed = []

  for (const [id, item] of nextMap) {
    const before = prevMap.get(id)
    if (!before) added.push({ id, label: item.label })
    else if (before.sig !== item.sig) changed.push({ id, label: item.label })
  }
  for (const [id, item] of prevMap) {
    if (!nextMap.has(id)) removed.push({ id, label: item.label })
  }

  return {
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    total: nextMap.size,
  }
}

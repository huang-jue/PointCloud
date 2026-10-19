/**
 * KITTI 标注文本的读写
 *
 * 每行格式：type truncated occluded alpha x1 y1 x2 y2 h w l x y z ry [score]
 * 其中框的几何为 (h,w,l) 尺寸与中心 (x,y,z)、偏航 ry，其他字段用于 2D/遮挡信息。
 */

/** 单个对象 -> KITTI 行 */
export function objectToKittiLine(o) {
  const b = o.bbox2d || [0, 0, 0, 0]
  const nums = [
    o.type || 'Object',
    o.truncated ?? 0,
    o.occluded ?? 0,
    o.alpha ?? 0,
    b[0],
    b[1],
    b[2],
    b[3],
    o.h,
    o.w,
    o.l,
    o.x,
    o.y,
    o.z,
    o.ry,
  ]
  const line = nums.map((v) => (typeof v === 'number' ? fmt(v) : v)).join(' ')
  return o.score !== undefined && o.score !== null ? `${line} ${fmt(o.score)}` : line
}

/**
 * KITTI 行 -> 对象
 * @param {string} line
 * @param {(name:string)=>number} [resolveClass] 由类别名解析 classId
 */
export function kittiLineToObject(line, resolveClass) {
  const p = line.trim().split(/\s+/)
  if (p.length < 15) return null
  const nums = p.slice(1).map(Number)
  if (nums.some((v) => Number.isNaN(v))) return null
  const [truncated, occluded, alpha, x1, y1, x2, y2, h, w, l, x, y, z, ry, score] = nums
  const type = p[0]
  return {
    type,
    classId: resolveClass ? resolveClass(type) : undefined,
    truncated,
    occluded,
    alpha,
    bbox2d: [x1, y1, x2, y2],
    h,
    w,
    l,
    x,
    y,
    z,
    ry,
    score: score ?? 1,
    source: 'import',
  }
}

/** 对象数组 -> 多行文本 */
export function objectsToKittiText(objects) {
  return objects.map(objectToKittiLine).join('\n') + (objects.length ? '\n' : '')
}

/** 多行文本 -> 对象数组（忽略空行与非法行） */
export function kittiTextToObjects(text, resolveClass) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const obj = kittiLineToObject(line, resolveClass)
    if (obj) out.push(obj)
  }
  return out
}

/** 数值格式化：整数直接输出，小数保留 6 位 */
function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(6)
}

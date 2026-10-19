/** 通用数学/路径小工具 */

export const DEG = Math.PI / 180

/** 数值夹取到 [min, max] */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

export function degToRad(deg) {
  return deg * DEG
}

export function radToDeg(rad) {
  return rad / DEG
}

/** 取文件扩展名（小写，去掉 query/hash） */
export function pathExt(name) {
  if (!name) return ''
  const base = name.split(/[?#]/)[0]
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 取文件名（含扩展名），兼容 Windows/Unix 分隔符 */
export function baseName(path) {
  if (!path) return ''
  return path.split(/[\\/]/).pop().split(/[?#]/)[0]
}

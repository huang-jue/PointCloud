/** 3D -> 2D 相机投影（前端 2D 面板与合成图像脚本共用） */

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** 由相机位置/目标点构建世界 -> 相机基向量（x 右、y 下、z 前） */
export function buildExtrinsics(position, target, up = [0, 0, 1]) {
  const forward = normalize(sub(target, position))
  let right = cross(up, forward)
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0]
  right = normalize(right)
  const down = normalize(cross(right, forward))
  return {
    position: [...position],
    right,
    down,
    forward,
  }
}

/** 默认相机内参（脚本与前端缺省值保持一致） */
export function defaultIntrinsics(width = 1280, height = 720) {
  return {
    width,
    height,
    fx: width * 0.86,
    fy: width * 0.86,
    cx: width / 2,
    cy: height / 2,
  }
}

/** 世界坐标投影到像素；点在相机后方返回 null */
export function projectPoint(point, extrinsics, intrinsics) {
  const d = sub(point, extrinsics.position)
  const z = dot(d, extrinsics.forward)
  if (z <= 0.05) return null
  const x = dot(d, extrinsics.right)
  const y = dot(d, extrinsics.down)
  return {
    x: intrinsics.fx * (x / z) + intrinsics.cx,
    y: intrinsics.fy * (y / z) + intrinsics.cy,
    z,
  }
}

/** 3D 框 8 个角点的世界坐标 */
export function boxCorners(obj) {
  const cos = Math.cos(obj.ry || 0)
  const sin = Math.sin(obj.ry || 0)
  const hl = (obj.l || 1) / 2
  const hw = (obj.w || 1) / 2
  const hh = (obj.h || 1) / 2
  const corners = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * hl
        const ly = sy * hw
        corners.push([
          obj.x + cos * lx - sin * ly,
          obj.y + sin * lx + cos * ly,
          obj.z + sz * hh,
        ])
      }
    }
  }
  return corners
}

export const BOX_EDGES = [
  [0, 1], [0, 2], [1, 3], [2, 3],
  [4, 5], [4, 6], [5, 7], [6, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/** 把 3D 框投影为 8 个像素点；任一角点在相机后方返回 null */
export function projectBox(obj, extrinsics, intrinsics) {
  const corners = boxCorners(obj).map((p) => projectPoint(p, extrinsics, intrinsics))
  if (corners.some((p) => !p)) return null
  return corners
}

/** 2D 凸包（用于投影框填充与点击命中） */
export function convexHull(points) {
  const list = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
  if (list.length <= 2) return list
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const p of list) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** 点是否在多边形内（2D 点击命中） */
export function pointInPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x
    const yi = points[i].y
    const xj = points[j].x
    const yj = points[j].y
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

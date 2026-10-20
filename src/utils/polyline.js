/**
 * 折线 / 路面箭头几何工具（纯函数，前端与测试数据生成脚本共用）
 *
 * 坐标约定：与点云一致，Z 向上，箭头模板在局部平面内以 +X 为前进方向，
 * 尾部位于原点。所有模板尺寸单位为米。
 */

/** 箭头模板：局部 2D 折线路径（每条路径末端自动生成箭头头部） */
export const ARROW_TEMPLATES = {
  straight: {
    label: '直行',
    paths: [
      [
        [0, 0],
        [0.9, 0],
        [1.8, 0],
        [2.7, 0],
        [3.6, 0],
      ],
    ],
  },
  left: {
    label: '左转',
    paths: [
      [
        [0, 0],
        [1.1, 0],
        [1.9, 0.15],
        [2.45, 0.7],
        [2.6, 1.45],
        [2.6, 2.2],
      ],
    ],
  },
  right: {
    label: '右转',
    paths: [
      [
        [0, 0],
        [1.1, 0],
        [1.9, -0.15],
        [2.45, -0.7],
        [2.6, -1.45],
        [2.6, -2.2],
      ],
    ],
  },
  straightLeft: {
    label: '直行+左转',
    paths: [
      [
        [0, 0],
        [1.2, 0],
        [2.4, 0],
        [3.6, 0],
      ],
      [
        [0.45, 0],
        [1.3, 0.1],
        [1.95, 0.65],
        [2.15, 1.35],
        [2.15, 2.0],
      ],
    ],
  },
  uturn: {
    label: '掉头',
    paths: [
      [
        [0, 0],
        [1.2, 0],
        [2.0, 0.25],
        [2.5, 0.95],
        [2.45, 1.7],
        [1.85, 2.15],
        [1.1, 2.1],
        [0.6, 1.65],
      ],
    ],
  },
}

/** 所有模板名（下拉用） */
export const ARROW_TEMPLATE_NAMES = Object.keys(ARROW_TEMPLATES)

/** 取模板路径的深拷贝（避免调用方修改常量） */
export function templatePaths(name) {
  const tpl = ARROW_TEMPLATES[name] || ARROW_TEMPLATES.straight
  return tpl.paths.map((p) => p.map(([x, y]) => [x, y]))
}

/**
 * 把模板放到世界坐标
 * @param {string} name 模板名
 * @param {{x?:number,y?:number,z?:number,ry?:number,scale?:number}} pose
 * @returns {number[][][]} paths，每点 [x,y,z]
 */
export function transformTemplate(name, { x = 0, y = 0, z = 0, ry = 0, scale = 1 } = {}) {
  const cos = Math.cos(ry)
  const sin = Math.sin(ry)
  return templatePaths(name).map((path) =>
    path.map(([px, py]) => [
      x + (px * cos - py * sin) * scale,
      y + (px * sin + py * cos) * scale,
      z,
    ]),
  )
}

/** 箭头头部尺寸（随线宽自适应，保证视觉比例合理） */
export function arrowHeadSize(width) {
  const w = Math.max(0.02, width || 0.3)
  return { length: Math.max(1.1, w * 3.4), halfWidth: Math.max(0.42, w * 1.55) }
}

/**
 * 计算一条路径末端的箭头头部三角形（局部 2D）
 * @param {number[][]} path 折线 [[x,y],...]
 * @param {number} width 线宽
 * @returns {number[][]|null} 三个顶点 [[x,y],...]，路径过短时返回 null
 */
export function arrowHead(path, width) {
  if (!path || path.length < 2) return null
  const n = path.length
  const tip = path[n - 1]
  // 取末段方向（跳过重合点）
  let prev = path[n - 2]
  for (let i = n - 2; i >= 0; i--) {
    const dx = tip[0] - path[i][0]
    const dy = tip[1] - path[i][1]
    if (Math.hypot(dx, dy) > 1e-6) {
      prev = path[i]
      break
    }
  }
  const dx = tip[0] - prev[0]
  const dy = tip[1] - prev[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  const ux = dx / len
  const uy = dy / len
  const { length, halfWidth } = arrowHeadSize(width)
  const bx = tip[0] - ux * length
  const by = tip[1] - uy * length
  const nx = -uy
  const ny = ux
  return [
    [tip[0], tip[1]],
    [bx + nx * halfWidth, by + ny * halfWidth],
    [bx - nx * halfWidth, by - ny * halfWidth],
  ]
}

/** 折线总长度（3D） */
export function polylineLength(points) {
  let total = 0
  for (let i = 1; i < (points?.length || 0); i++) {
    const a = points[i - 1]
    const b = points[i]
    total += Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0))
  }
  return total
}

/** 折线质心（3D 顶点平均，编辑旋转/缩放时作为中心） */
export function polylineCentroid(points) {
  const n = points?.length || 0
  if (!n) return [0, 0, 0]
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    x += p[0]
    y += p[1]
    z += p[2] || 0
  }
  return [x / n, y / n, z / n]
}

/** 绕 Z 轴旋转一组 3D 点（就地返回新数组） */
export function rotatePoints(points, angle, center) {
  const [cx, cy] = center || polylineCentroid(points)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return points.map(([x, y, z]) => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
    z || 0,
  ])
}

/** 以质心为中心缩放一组 3D 点（就地返回新数组） */
export function scalePoints(points, factor, center) {
  const [cx, cy, cz] = center || polylineCentroid(points)
  return points.map(([x, y, z]) => [
    cx + (x - cx) * factor,
    cy + (y - cy) * factor,
    cz + ((z || 0) - cz) * factor,
  ])
}

/** 对箭头对象的所有路径做同一次变换 */
export function mapPaths(paths, fn) {
  return paths.map((p) => fn(p))
}

/* ---------------- 采样（测试数据生成用） ---------------- */

/**
 * 沿折线按间距采样中心线点
 * @param {number[][]} points [[x,y,z],...]
 * @param {number} spacing 间距
 */
export function sampleAlongPolyline(points, spacing) {
  const out = []
  const step = Math.max(0.01, spacing)
  for (let i = 1; i < (points?.length || 0); i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = (b[2] || 0) - (a[2] || 0)
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) continue
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push([a[0] + dx * t, a[1] + dy * t, (a[2] || 0) + dz * t])
    }
  }
  return out
}

/**
 * 按线宽把折线采样成带状点集
 * @param {number[][]} points 中心线
 * @param {number} width 线宽
 * @param {number} spacing 采样间距
 */
export function sampleThickPolyline(points, width, spacing) {
  const out = []
  const half = Math.max(0.01, width / 2)
  for (let i = 1; i < (points?.length || 0); i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const ux = dx / len
    const uy = dy / len
    const nx = -uy
    const ny = ux
    const along = Math.max(1, Math.ceil(len / spacing))
    const across = Math.max(1, Math.ceil((half * 2) / spacing))
    for (let s = 0; s <= along; s++) {
      const t = s / along
      const cx = a[0] + dx * t
      const cy = a[1] + dy * t
      const cz = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t
      for (let c = 0; c <= across; c++) {
        const o = -half + (c / across) * half * 2
        out.push([cx + nx * o, cy + ny * o, cz])
      }
    }
  }
  return out
}

/**
 * 填充箭头头部三角形（沿局部 2D 网格采样）
 * @param {number[][]} tri 三个顶点 [[x,y],...]
 * @param {number} z 高度
 * @param {number} spacing 间距
 */
export function sampleTriangle(tri, z, spacing) {
  if (!tri) return []
  const step = Math.max(0.02, spacing)
  const [p0, p1, p2] = tri
  const minX = Math.min(p0[0], p1[0], p2[0])
  const maxX = Math.max(p0[0], p1[0], p2[0])
  const minY = Math.min(p0[1], p1[1], p2[1])
  const maxY = Math.max(p0[1], p1[1], p2[1])
  const out = []
  for (let x = minX; x <= maxX + 1e-6; x += step) {
    for (let y = minY; y <= maxY + 1e-6; y += step) {
      if (pointInTriangle(x, y, p0, p1, p2)) out.push([x, y, z])
    }
  }
  return out
}

/** 采样一条带箭头头部的路面箭头（2D 路径 -> 3D 点） */
export function sampleArrowPath(path, width, spacing, z) {
  const out = sampleThickPolyline(path.map(([x, y]) => [x, y, z]), width, spacing)
  const head = arrowHead(path, width)
  if (head) out.push(...sampleTriangle(head, z, spacing))
  return out
}

/** 重心坐标法判断点是否在三角形内 */
function pointInTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1])
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** 深拷贝 paths（导入导出时避免共享引用） */
export function clonePaths(paths) {
  return (paths || []).map((p) => p.map(([x, y, z]) => [x, y, z || 0]))
}

/** 深拷贝 points */
export function clonePoints(points) {
  return (points || []).map(([x, y, z]) => [x, y, z || 0])
}

/**
 * RoadMarking3D —— 路面标线（车道线 / 斑马线 / 停止线 / 箭头）的可视化对象
 *
 * 用「带状 Mesh」而不是 THREE.Line 渲染：
 *   - WebGL 的 LineBasicMaterial 线宽在多数平台被限制为 1px，
 *     无法表达真实线宽；带面片可以按米控制宽度、随相机自然透视。
 *
 * 几何：
 *   line  —— points 折线沿法向左右扩展 width/2
 *   arrow —— paths 每条折线同样扩展，末端追加箭头三角面
 *
 * 拾取：额外生成一份加宽的不可见 Mesh，点选更宽容。
 */

import * as THREE from 'three'
import { arrowHead } from '../../utils/polyline.js'

/** 拾取用加宽量（米） */
const PICK_EXTRA_WIDTH = 0.5

export class RoadMarking3D {
  constructor(color = 0xffffff) {
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = true

    this.material = new THREE.MeshBasicMaterial({
      color,
      // 几何体在转弯处会有重叠三角形；使用不透明材质避免重叠区域颜色变深
      transparent: false,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.renderOrder = 2
    this.mesh.userData.pick = { kind: 'mark', ref: this }
    this.group.add(this.mesh)

    this.pickMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.pickMaterial)
    this.pickMesh.userData.pick = { kind: 'mark', ref: this }
    this.group.add(this.pickMesh)

    // 选中高亮：同几何叠加一层半透明白色
    this.highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
    this.highlight = new THREE.Mesh(new THREE.BufferGeometry(), this.highlightMaterial)
    this.highlight.renderOrder = 3
    this.highlight.visible = false
    this.group.add(this.highlight)

    this.objectId = null
    this.color = color
    this.shape = 'line'
    this.width = 0.15
    this.paths = []
  }

  setColor(color) {
    this.color = color
    this.material.color.set(color)
  }

  setSelected(selected) {
    this.highlight.visible = !!selected
  }

  /**
   * 用标注数据更新标线
   * @param {{id:string,shape:'line'|'arrow',width:number,points?:number[][],paths?:number[][][]}} obj
   * @param {string} [color] 类别颜色
   */
  apply(obj, color) {
    this.objectId = obj.id
    const shape = obj.shape === 'arrow' ? 'arrow' : 'line'
    const width = obj.width ?? (shape === 'arrow' ? 0.35 : 0.15)
    const paths = shape === 'line' ? [obj.points || []] : obj.paths || []
    // 保留世界坐标路径，供屏幕空间拾取使用（远处窄标线也能点中）
    this.paths = paths

    // 几何未变时跳过重建（拖动顶点会高频触发同步，避免反复分配 GPU 缓冲）
    const key = geometryKey(obj, shape, width)
    if (key !== this._geoKey) {
      this._geoKey = key
      this.shape = shape
      this.width = width
      const withHead = shape === 'arrow'
      const display = buildMarkingGeometry(paths, width, withHead)
      const pick = buildMarkingGeometry(paths, width + PICK_EXTRA_WIDTH, withHead)
      this._replaceGeometry(this.mesh, display)
      this._replaceGeometry(this.pickMesh, pick)
      this._replaceGeometry(this.highlight, display)
    }
    if (color !== undefined) this.setColor(color)
  }

  _replaceGeometry(mesh, geometry) {
    const old = mesh.geometry
    mesh.geometry = geometry
    if (old && old !== geometry) old.dispose()
  }

  /** 世界坐标包围盒中心（用于视口聚焦） */
  center() {
    const geo = this.mesh.geometry
    if (!geo || !geo.attributes.position || !geo.attributes.position.count) return null
    if (!geo.boundingBox) geo.computeBoundingBox()
    const box = geo.boundingBox
    return box.getCenter(new THREE.Vector3())
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.pickMesh.geometry.dispose()
    this.highlight.geometry.dispose()
    this.material.dispose()
    this.pickMaterial.dispose()
    this.highlightMaterial.dispose()
  }
}

/**
 * 由若干中心线路径构建标线几何
 * @param {number[][][]} paths
 * @param {number} width 总宽度（米）
 * @param {boolean} [withHead=true] 是否在路径末端生成箭头头部
 */
export function buildMarkingGeometry(paths, width, withHead = true) {
  const positions = []
  const indices = []
  const half = Math.max(0.01, (width || 0.15) / 2)
  const JOIN_SEGMENTS = 10

  for (const raw of paths) {
    const pts = dedupe(raw)
    if (pts.length < 2) continue

    // 每段独立生成一个矩形，拐角处额外补一个圆形接头。
    // 这样不会因为内外法向偏移不同而出现转弯处变细、重叠或自交。
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      let dx = b[0] - a[0]
      let dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      dx /= len
      dy /= len
      const nx = -dy * half
      const ny = dx * half
      const z0 = a[2] || 0
      const z1 = b[2] || 0
      const base = positions.length / 3
      positions.push(
        a[0] + nx, a[1] + ny, z0,
        a[0] - nx, a[1] - ny, z0,
        b[0] + nx, b[1] + ny, z1,
        b[0] - nx, b[1] - ny, z1,
      )
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
    }

    // 拐角圆接头（半径 = 线宽/2），保证任意夹角下线宽一致
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y, z = 0] = pts[i]
      const center = positions.length / 3
      positions.push(x, y, z)
      const ring = positions.length / 3
      for (let k = 0; k <= JOIN_SEGMENTS; k++) {
        const ang = (k / JOIN_SEGMENTS) * Math.PI * 2
        positions.push(x + Math.cos(ang) * half, y + Math.sin(ang) * half, z)
      }
      for (let k = 0; k < JOIN_SEGMENTS; k++) {
        indices.push(center, ring + k, ring + k + 1)
      }
    }

    // 箭头头部
    const head = withHead
      ? arrowHead(
          pts.map(([x, y]) => [x, y]),
          width,
        )
      : null
    if (head) {
      const z = pts[pts.length - 1][2] || 0
      const hb = positions.length / 3
      for (const [x, y] of head) positions.push(x, y, z)
      indices.push(hb, hb + 1, hb + 2)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** 几何缓存键：形状/线宽/所有顶点坐标 */
function geometryKey(obj, shape, width) {
  const paths = shape === 'line' ? [obj.points || []] : obj.paths || []
  let key = `${shape}|${width}`
  for (const p of paths) {
    key += '|'
    for (const [x, y, z] of p) key += `${x.toFixed(3)},${y.toFixed(3)},${(z || 0).toFixed(3)};`
  }
  return key
}

/** 去掉相邻重合点，避免法向退化产生 NaN */
function dedupe(points) {
  const out = []
  for (const p of points || []) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    const last = out[out.length - 1]
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-5) continue
    out.push([p[0], p[1], p[2] || 0])
  }
  return out
}

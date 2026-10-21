/**
 * PointCloudViewer —— 点云视口渲染核心（与 Vue 解耦的纯 Three.js 类）
 *
 * 职责：
 *  - 场景 / 相机 / 渲染循环 / 自适应尺寸（Z 轴向上）
 *  - 点云加载与显示（含帧级 LRU 缓存）、按强度/高度/原始颜色/语义标签着色
 *  - 3D 边界框的创建、同步、选中，以及 TransformControls 编辑手柄
 *  - 点级语义分割的屏幕空间拾取（矩形 / 画笔 / 套索）与标签写入
 *
 * 与外部交互全部通过构造参数 callbacks，避免依赖 Vue：
 *   onSelect(objectId|null)  选中/取消选中某个 3D 框
 *   onBoxChange(id, transform) gizmo 拖动后回传新的位姿
 *   onSketch(sketch|null)    分割框选过程中的临时图形（供 2D 覆盖层绘制）
 *   onSelection(count)       分割待提交选中点数变化
 *   getClasses()             获取当前类别表（用于标签着色）
 *   getActiveClassId()       获取当前激活类别（自动赋标签时使用）
 *   onLabelApplied(classId, count) 一次涂抹/框选自动生成标签后的回调
 *   onSegmentSelect(segment|null)  点击选中/取消选中标签片段（用于编辑）
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { BBox3D } from './helpers/BBox3D.js'
import { RoadMarking3D, buildMarkingGeometry } from './helpers/RoadMarking3D.js'
import { loadPointCloud } from './loaders/index.js'
import { intensityToColor, heightToColor, labelsToColor } from './helpers/PointColorizer.js'
import { transformTemplate, clonePoints } from '../utils/polyline.js'
import { get } from '../utils/http.js'

/** 帧级点云缓存上限（超出后按 LRU 淘汰） */
const MAX_CACHE = 8

/** 已编辑帧的标签缓存上限（真值共享模板不计入，且 dirty 帧不会被淘汰） */
const MAX_LABEL_FRAMES = 64

/**
 * 鼠标按键映射：
 *  - 常规模式：左键拖动平移、中键缩放、右键拖拽旋转
 *  - 分割模式：左键留给框选，中键平移、右键旋转、滚轮缩放
 */
const MOUSE_DEFAULT = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
}
const MOUSE_SEGMENT = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
}
/** 绘制模式：左键留给落点 */
const MOUSE_DRAW = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
}

export class PointCloudViewer {
  constructor(container, callbacks = {}) {
    this.container = container
    this.callbacks = callbacks

    /* ---------- 场景 / 相机 ---------- */
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0d1117)

    // 点云坐标系约定 Z 轴向上（KITTI/LiDAR 常见约定），因此显式设置相机 up
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(-18, -22, 16)

    /* ---------- 渲染器 ---------- */
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(this._pixelRatio())
    container.appendChild(this.renderer.domElement)
    this._perf = { fps: 0, frameMs: 0, frames: 0, last: performance.now() }

    /* ---------- 批注标签（CSS2D，始终朝向屏幕） ---------- */
    this.labelRenderer = new CSS2DRenderer()
    const labelDom = this.labelRenderer.domElement
    labelDom.style.position = 'absolute'
    labelDom.style.inset = '0'
    labelDom.style.pointerEvents = 'none'
    labelDom.style.zIndex = '3'
    labelDom.style.overflow = 'hidden'
    container.appendChild(labelDom)
    this.commentLabels = []

    /* ---------- 轨道控制器（左键平移 / 右键旋转） ---------- */
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.screenSpacePanning = true // 平移沿屏幕平面，拖动更符合直觉
    this.controls.target.set(22, 0, 0)
    this.controls.mouseButtons = { ...MOUSE_DEFAULT }

    /* ---------- 参考网格 / 坐标轴（位于地平面） ---------- */
    const grid = new THREE.GridHelper(220, 110, 0x2b3440, 0x1b2027)
    grid.rotation.x = Math.PI / 2 // 默认在 XZ 平面，旋转到 XY 平面以适配 Z-up
    grid.position.z = -1.73
    this.grid = grid
    this.scene.add(grid)

    this.axes = new THREE.AxesHelper(6)
    this.axes.position.set(0, 0, -1.6)
    this.scene.add(this.axes)

    /* ---------- 3D 框容器 ---------- */
    this.boxRoot = new THREE.Group()
    this.scene.add(this.boxRoot)
    this.boxes = new Map() // objectId -> BBox3D

    /* ---------- 路面标线容器 ---------- */
    this.markRoot = new THREE.Group()
    this.scene.add(this.markRoot)
    this.marks = new Map() // objectId -> RoadMarking3D

    /* ---------- 标线顶点手柄 ---------- */
    this.vertexRoot = new THREE.Group()
    this.scene.add(this.vertexRoot)
    this.vertexGeo = new THREE.SphereGeometry(1, 10, 8)
    this.vertexHandles = []
    this.vertexDrag = null // { objId, pathIndex, index }
    this.vertexObjectId = null // 当前显示手柄的标线对象
    this._suppressClick = false // Alt+点击删除顶点后，忽略同一次 pointerup 的拾取

    /* ---------- 绘制草稿（画线/画箭头时的预览） ---------- */
    this.drawRoot = new THREE.Group()
    this.scene.add(this.drawRoot)
    this.drawMode = null // null | 'line' | 'arrow'
    this.drawPoints = [] // 已落下的点 [[x,y,z],...]
    this.drawHover = null // 鼠标悬停点
    this.drawTemplate = 'free'
    this.drawWidth = 0.15
    this.drawHeading = 0
    this.groundZ = -1.73
    this.snapToPoints = true // 拖拽标线顶点时吸附到最近点云
    this._drawPreview = null

    /* ---------- 缩放手柄（自定义，替代 TransformControls 的 scale 模式） ---------- */
    // 三个球分别位于框的 +X/+Y/+Z 面中心，拖动即可改变 长/宽/高
    this.scaleHandleGroup = new THREE.Group()
    this.scaleHandleGroup.visible = false
    this.scene.add(this.scaleHandleGroup)
    this.scaleHandleGeo = new THREE.SphereGeometry(1, 12, 10)
    this.scaleHandles = []
    const HANDLE_COLORS = [0xff6b6b, 0x57d9a3, 0x4f9bff]
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(
        this.scaleHandleGeo,
        new THREE.MeshBasicMaterial({ color: HANDLE_COLORS[i], depthTest: false, transparent: true, opacity: 0.95 }),
      )
      mesh.renderOrder = 999 // 始终画在最上层，便于抓取
      mesh.userData.scaleAxis = i
      this.scaleHandleGroup.add(mesh)
      this.scaleHandles.push(mesh)
    }
    this.activeTool = 'select'
    this._scaleState = null
    this.readOnly = false

    /* ---------- 编辑手柄（平移/旋转/缩放） ---------- */
    this.transform = new TransformControls(this.camera, this.renderer.domElement)
    this.transform.setSize(0.9)
    this._draggingGizmo = false // 正在拖动编辑手柄
    // 拖动手柄时禁用轨道控制器，避免相机与框一起动
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value
      const isGroup = this.groupGizmoIds.length > 0
      this._draggingGizmo = !isGroup && e.value
      if (isGroup) {
        if (e.value) {
          this._groupDragging = true
          this._groupStart = this.groupPivot.position.clone()
          this._groupStartRotation = this.groupPivot.rotation.z
          this._groupRotateCenter = this.groupPivot.position.clone()
          this._groupStartPositions = this.groupGizmoIds
            .map((id) => {
              const box = this.boxes.get(id)
              if (box) return { id, box, mark: null, start: box.group.position.clone() }
              const mark = this.marks.get(id)
              if (mark) return { id, box: null, mark, start: mark.group.position.clone() }
              return null
            })
            .filter(Boolean)
          // 单条标线整体移动/旋转时，黄色顶点手柄不在 mark.group 下，需要单独跟随
          this._handleStartPositions = this.vertexHandles
            .filter((h) => this.groupGizmoIds.includes(h.userData.vertex?.objId))
            .map((handle) => ({ handle, start: handle.position.clone() }))
        } else if (this._groupDragging) {
          this._groupDragging = false
          const ids = this.groupGizmoIds.slice()
          if (this._groupMode === 'rotate') {
            const angle = this.groupPivot.rotation.z - this._groupStartRotation
            this._groupStart = null
            this._groupStartPositions = null
            this._groupRotateCenter = null
            this._handleStartPositions = null
            this.callbacks.onGroupRotate?.(ids[0], angle)
          } else {
            const start = this._groupStart
            const dx = start ? this.groupPivot.position.x - start.x : 0
            const dy = start ? this.groupPivot.position.y - start.y : 0
            // 混合选择（含标线）强制 XY，忽略 Z，避免标线离开地面
            const dz = start && this._groupAllowZ ? this.groupPivot.position.z - start.z : 0
            this._groupStart = null
            this._groupStartPositions = null
            this._groupRotateCenter = null
            this._handleStartPositions = null
            this.callbacks.onGroupCommit?.(ids, { dx, dy, dz })
          }
        }
        return
      }
      if (!e.value && this.gizmoObjectId && this.boxes.has(this.gizmoObjectId)) {
        // 松手：把最终变换回传（期间不回写，避免与手柄相互覆盖）
        this.callbacks.onBoxChange?.(this.gizmoObjectId, this.boxes.get(this.gizmoObjectId).readTransform())
      }
    })
    // 手柄变换后把新的位姿回传给上层（写回 store）
    this.transform.addEventListener('objectChange', () => {
      if (this._groupDragging) {
        if (this._groupMode === 'rotate') {
          const center = this._groupRotateCenter
          if (!center) return
          const angle = this.groupPivot.rotation.z - this._groupStartRotation
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)
          // 标线几何是世界坐标：绕中心 C 旋转等价于 group.rotation + position = C - R*C
          for (const id of this.groupGizmoIds) {
            const mark = this.marks.get(id)
            if (!mark) continue
            mark.group.rotation.z = angle
            mark.group.position.set(
              center.x - (center.x * cos - center.y * sin),
              center.y - (center.x * sin + center.y * cos),
              0,
            )
          }
          for (const { handle, start } of this._handleStartPositions || []) {
            const rx = start.x - center.x
            const ry = start.y - center.y
            handle.position.set(center.x + rx * cos - ry * sin, center.y + rx * sin + ry * cos, start.z)
          }
          return
        }
        const start = this._groupStart
        if (!start) return
        const dx = this.groupPivot.position.x - start.x
        const dy = this.groupPivot.position.y - start.y
        const dz = this._groupAllowZ ? this.groupPivot.position.z - start.z : 0
        for (const item of this._groupStartPositions || []) {
          item.box?.group.position.set(item.start.x + dx, item.start.y + dy, item.start.z + dz)
          item.mark?.group.position.set(item.start.x + dx, item.start.y + dy, item.start.z + dz)
        }
        for (const { handle, start } of this._handleStartPositions || []) {
          handle.position.set(start.x + dx, start.y + dy, start.z + dz)
        }
        return
      }
      if (this.gizmoObjectId && this.boxes.has(this.gizmoObjectId)) {
        const box = this.boxes.get(this.gizmoObjectId)
        this.callbacks.onBoxChange?.(this.gizmoObjectId, box.readTransform())
      }
    })
    this.scene.add(this.transform.getHelper())
    this.gizmoObjectId = null

    /* ---------- 多选整体平移 ---------- */
    this.groupPivot = new THREE.Object3D()
    this.scene.add(this.groupPivot)
    this.groupGizmoIds = []
    this._groupDragging = false
    this._groupStart = null
    this._groupStartPositions = null
    this._groupAllowZ = false
    this._groupMode = 'translate'
    this._groupStartRotation = 0
    this._groupRotateCenter = null
    this._handleStartPositions = null

    /* ---------- 点云对象 ---------- */
    this.pointObject = null
    this.pointGeometry = null
    // 用像素尺寸（sizeAttenuation=false），使不同尺度的点云在屏幕上大小一致
    this.pointMaterial = new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
    })
    this.currentCloud = null
    this.currentKey = null
    this.cache = new Map()
    this.inflight = new Map() // key -> Promise，避免同一帧重复请求
    // 演示/弱网默认关闭预取；需要时用 ?prefetch=1 开启（只预取下一帧）
    this.prefetchEnabled = new URLSearchParams(location.search).get('prefetch') === '1'
    this._prefetchQueue = []
    this._prefetching = false
    this._prefetchTimer = null
    this.labelsByKey = new Map() // 已编辑帧的点级标签（独立于点云 LRU 缓存）
    this.pointLabelFiles = new Map() // 点级标签文件缓存（URL -> 解析结果），避免逐帧重复请求
    this.pointLabelTemplates = new Map() // 共享真值模板（URL -> 只读数组），未编辑帧直接复用
    this.pointLabelFailed = new Set() // 加载失败的标签 URL，避免每帧重试拖慢点云显示
    this.colorMode = 'intensity'

    /* ---------- 拾取相关 ---------- */
    this.raycaster = new THREE.Raycaster()
    this.raycaster.params.Points.threshold = 0.2
    this.pointer = new THREE.Vector2()
    this._down = { x: 0, y: 0, t: 0 }

    /* ---------- 点级分割状态 ---------- */
    this.segEnabled = false
    this.segMode = 'rect' // rect | brush | lasso
    this.brushSize = 24
    this.selectionMask = null // Uint8Array，1 表示该点被选中（待提交）
    this.selectionIndices = [] // 已选中的点索引，避免每次都全量扫描 40 万点
    this.selectionCount = 0
    this.segOverwrite = true // 新标签是否覆盖已有标签
    this.baseColors = null // 未叠加高亮前的原始颜色
    this.selectedSegmentId = null // 当前选中用于编辑的标签片段 id
    this.segmentSeq = 0
    this._selecting = false
    this._sketch = null
    this._pendingBrush = null // 画笔节流用
    this._brushRaf = 0
    this._projector = new THREE.Vector3() // 复用的投影临时向量
    this._screen = { x: 0, y: 0, z: 0 } // 复用的屏幕坐标，避免逐点分配对象

    /* ---------- 事件绑定 ---------- */
    this._onResize = this._onResize.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._onDoubleClick = this._onDoubleClick.bind(this)
    this._animate = this._animate.bind(this)

    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.addEventListener('pointerup', this._onPointerUp)
    this.renderer.domElement.addEventListener('dblclick', this._onDoubleClick)

    this.resizeObserver = new ResizeObserver(this._onResize)
    this.resizeObserver.observe(container)
    this._onResize()

    this.running = true
    this.renderer.setAnimationLoop(this._animate)
  }

  /** 渲染循环 */
  _animate() {
    const now = performance.now()
    this.controls.update() // damping 需要每帧 update
    this._updateHandleScales()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
    const perf = this._perf
    perf.frames++
    const dt = now - perf.last
    if (dt >= 500) {
      perf.fps = Math.round((perf.frames * 1000) / dt)
      perf.frameMs = Number((dt / perf.frames).toFixed(1))
      perf.frames = 0
      perf.last = now
    }
  }

  /** URL 参数 ?dpr=1 / ?quality=low 可强制降低渲染分辨率 */
  _pixelRatio() {
    const params = new URLSearchParams(location.search)
    const forced = Number(params.get('dpr'))
    if (forced > 0) return Math.min(forced, 2)
    if (params.get('quality') === 'low') return 1
    const dpr = window.devicePixelRatio || 1
    const w = this.container.clientWidth || window.innerWidth || 1
    const h = this.container.clientHeight || window.innerHeight || 1
    // 控制总像素量，避免 4K/高分屏 + 40 万点造成填充率瓶颈
    const byArea = Math.sqrt(2_500_000 / Math.max(1, w * h))
    return Math.max(0.75, Math.min(dpr, 1.5, byArea))
  }

  getPerfStats() {
    const info = this.renderer.info
    return {
      ...this._perf,
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
    }
  }

  /** 顶点手柄按相机距离缩放，保证屏幕上大小稳定、始终好点中 */
  _updateHandleScales() {
    if (!this.vertexHandles.length) return
    for (const h of this.vertexHandles) {
      const d = h.position.distanceTo(this.camera.position)
      h.scale.setScalar(Math.max(0.04, d * 0.012))
    }
  }

  /** 容器尺寸变化时同步相机宽高比与渲染器大小 */
  _onResize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(this._pixelRatio())
    this.renderer.setSize(w, h, false)
    this.labelRenderer?.setSize(w, h)
  }

  /** 鼠标位置 -> 归一化设备坐标（NDC） */
  _updatePointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** 鼠标位置 -> 相对画布左上角的像素坐标 */
  _localPoint(event) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** 指针按下：优先抓取缩放手柄/标线顶点；分割模式下左键开始框选；否则记录起点用于区分点击/拖动 */
  _onPointerDown(event) {
    this._down = { x: event.clientX, y: event.clientY, t: performance.now() }
    // 标线顶点拖动（选中标线后显示的手柄；绘制模式下不响应，避免误拖）
    if (event.button === 0 && !this.readOnly && !this.drawMode && this.vertexHandles.length) {
      const hit = this._pickVertex(event)
      if (hit) {
        if (event.altKey) {
          // Alt+点击：删除该顶点（并阻止随后的单击重新拾取）
          this._suppressClick = true
          this.callbacks.onVertexDelete?.(hit.objId, hit.index, hit.pathIndex)
          return
        }
        this._startVertexDrag(hit)
        return
      }
    }
    // 缩放工具：命中手柄则开始拖动缩放
    if (this.activeTool === 'scale' && !this.readOnly && !this.segEnabled && event.button === 0) {
      const idx = this._pickScaleHandle(event)
      if (idx !== -1) {
        this._startScale(idx)
        return
      }
    }
    if (this.segEnabled && !this.readOnly && event.button === 0 && this.transform.axis === null && this.currentCloud) {
      this._selecting = true
      const p = this._localPoint(event)
      if (this.segMode === 'lasso') {
        this._sketch = { mode: 'lasso', points: [[p.x, p.y]] }
      } else {
        this._sketch = { mode: 'rect', x0: p.x, y0: p.y, x1: p.x, y1: p.y }
        // 画笔模式在按下时立即涂抹一次
        if (this.segMode === 'brush') {
          this._selectPointsInCircle(p.x, p.y, this.brushSize)
        }
      }
      this.callbacks.onSketch?.(this._sketch)
    }
  }

  /** 指针移动：优先处理缩放拖动/顶点拖动/绘制预览，其次更新分割框选图形 */
  _onPointerMove(event) {
    if (this._scaleState) {
      this._updateScale(event)
      return
    }
    if (this.vertexDrag) {
      this._updateVertexDrag(event)
      return
    }
    if (this.drawMode) {
      this.drawHover = this._drawPoint(event)
      this._updateDrawPreview()
      return
    }
    if (!this._selecting || this.transform.axis !== null) return
    const p = this._localPoint(event)
    if (this._sketch.mode === 'lasso') {
      this._sketch.points.push([p.x, p.y])
    } else {
      this._sketch.x1 = p.x
      this._sketch.y1 = p.y
      // 画笔：选择是 O(n) 的，用 requestAnimationFrame 节流，避免大数据下来不及处理每次移动
      if (this.segMode === 'brush') {
        this._pendingBrush = { x: p.x, y: p.y }
        if (!this._brushRaf) {
          this._brushRaf = requestAnimationFrame(() => {
            this._brushRaf = null
            const pb = this._pendingBrush
            if (pb && this._selecting) this._selectPointsInCircle(pb.x, pb.y, this.brushSize)
          })
        }
      }
    }
    this.callbacks.onSketch?.(this._sketch)
  }

  /**
   * 指针抬起：
   *  - 分割拖动结束 → 自动把选中的点提交为「当前类别」的标签片段（无需手动点按钮）
   *  - 位移很小视为单击 → 拾取光标下的标签片段用于编辑；否则做 3D 框拾取
   */
  _onPointerUp(event) {
    if (this._scaleState) {
      this._endScale()
      return
    }
    if (this.vertexDrag) {
      this._endVertexDrag()
      return
    }
    if (this._suppressClick) {
      this._suppressClick = false
      return
    }
    if (this.drawMode) {
      const moved = Math.hypot(event.clientX - this._down.x, event.clientY - this._down.y) > 4
      if (!moved && event.button === 0) this._handleDrawClick(event)
      return
    }
    if (this._selecting) {
      this._selecting = false
      // 画笔：补上最后一次节流未执行的位置，并取消挂起的 rAF
      if (this._brushRaf) {
        cancelAnimationFrame(this._brushRaf)
        this._brushRaf = null
      }
      if (this.segMode === 'brush' && this._pendingBrush && this._sketch?.mode === 'rect') {
        this._selectPointsInCircle(this._pendingBrush.x, this._pendingBrush.y, this.brushSize)
      }
      this._pendingBrush = null

      const sketch = this._sketch
      this._sketch = null
      this.callbacks.onSketch?.(null)

      // 位移过小视为单击：不产生新标签，改为选中已有标签进行编辑
      const tiny =
        !sketch ||
        (sketch.mode === 'rect' &&
          Math.abs(sketch.x1 - sketch.x0) < 6 &&
          Math.abs(sketch.y1 - sketch.y0) < 6) ||
        (sketch.mode === 'lasso' && sketch.points.length < 5)

      if (tiny) {
        this.selectSegmentAt(event)
        return
      }

      if (sketch.mode === 'rect') {
        this._selectPointsInRect(sketch.x0, sketch.y0, sketch.x1, sketch.y1)
      } else if (sketch.mode === 'lasso') {
        this._selectPointsInPolygon(sketch.points)
      }
      // 画笔模式的掩码已在移动过程中累积

      // 自动生成标签，然后清除待提交高亮，使点显示为类别颜色
      const classId = this.callbacks.getActiveClassId?.() ?? 0
      const count = this._commitLabelToMask(classId)
      this.clearSelection()
      if (count) this.callbacks.onLabelApplied?.(classId, count)
      return
    }
    // 位移超过阈值视为拖动（平移/旋转相机），不触发选中
    const dx = event.clientX - this._down.x
    const dy = event.clientY - this._down.y
    const moved = Math.hypot(dx, dy) > 4
    if (moved || this.transform.axis !== null) return
    if (event.button !== 0) return
    // 分割模式下单击只拾取语义标签
    if (this.segEnabled) {
      this.selectSegmentAt(event)
      return
    }
    // 标签着色下：光标附近有已标注点时优先编辑该片段，否则继续拾取框/标线
    if (this.colorMode === 'label' && this.currentCloud?.pointSegment) {
      const p = this._localPoint(event)
      if (this._pickNearestPoint(p.x, p.y, 12, true) >= 0) {
        this.selectSegmentAt(event)
        return
      }
    }
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects([...this.boxRoot.children, ...this.markRoot.children], true)
    const additive = event.ctrlKey || event.metaKey
    for (const hit of hits) {
      const pick = hit.object.userData.pick
      if (pick && (pick.kind === 'box' || pick.kind === 'mark')) {
        this.callbacks.onSelect?.(pick.ref.objectId, { additive })
        return
      }
    }
    // 远距离下标线的拾取面可能只有几个像素，补一层屏幕空间命中
    const local = this._localPoint(event)
    const markId = this._pickMarkAtScreen(local.x, local.y)
    if (markId) {
      this.callbacks.onSelect?.(markId, { additive })
      return
    }
    this.callbacks.onSelect?.(null, { additive })
  }

  /** 双击：绘制模式下完成当前标线 */
  _onDoubleClick() {
    if (this.drawMode) this.finishDrawing()
  }

  /* ---------------- 路面标线：绘制 ---------------- */

  /** 只读模式（批注员）：禁止所有几何修改 */
  setReadOnly(readOnly) {
    this.readOnly = !!readOnly
    if (!this.readOnly) return
    this.setDrawMode(null)
    this.setSegEnabled(false)
    this.attachGizmo(null)
    this.showVertexHandles(null)
  }

  /** 进入/退出绘制模式（左键留给落点） */
  setDrawMode(mode) {
    const next = !this.readOnly && (mode === 'line' || mode === 'arrow') ? mode : null
    if (next === this.drawMode) return
    this.drawMode = next
    this.drawPoints = []
    this.drawHover = null
    this.controls.mouseButtons = next ? { ...MOUSE_DRAW } : this.segEnabled ? { ...MOUSE_SEGMENT } : { ...MOUSE_DEFAULT }
    this._updateDrawPreview()
    this.callbacks.onDrawChange?.(this.drawPoints.length)
  }

  /** 开关顶点拖拽吸附 */
  setSnapEnabled(enabled) {
    this.snapToPoints = !!enabled
  }

  /** 同步绘制选项 */
  setDrawOptions({ width, template, heading, groundZ } = {}) {
    if (width != null) this.drawWidth = width
    if (template != null) this.drawTemplate = template
    if (heading != null) this.drawHeading = heading
    if (groundZ != null) this.groundZ = groundZ
    this._updateDrawPreview()
  }

  /** 完成绘制：把草稿交给上层生成标注对象 */
  finishDrawing() {
    if (!this.drawMode) return false
    const mode = this.drawMode
    const points = clonePoints(this.drawPoints)
    // 模板箭头在单击落点时即生成，Enter 视为已完成
    if (mode === 'arrow' && this.drawTemplate !== 'free') return true
    if (points.length < 2) return false
    this._resetDraft()
    if (mode === 'arrow') {
      this.callbacks.onDrawFinish?.({ shape: 'arrow', paths: [points], width: this.drawWidth, template: null })
    } else {
      this.callbacks.onDrawFinish?.({ shape: 'line', points, width: this.drawWidth })
    }
    return true
  }

  /** 取消当前草稿 */
  cancelDrawing() {
    this._resetDraft()
  }

  /** 退掉最后一个落点 */
  undoDrawPoint() {
    if (!this.drawPoints.length) return false
    this.drawPoints.pop()
    this._updateDrawPreview()
    this.callbacks.onDrawChange?.(this.drawPoints.length)
    return true
  }

  /** 是否有正在进行的草稿 */
  hasDraft() {
    return this.drawPoints.length > 0
  }

  _resetDraft() {
    this.drawPoints = []
    this.drawHover = null
    this._updateDrawPreview()
    this.callbacks.onDrawChange?.(0)
  }

  /** 左键落点；模板箭头单击即放置 */
  _handleDrawClick(event) {
    const p = this._drawPoint(event)
    if (!p) return
    if (this.drawMode === 'arrow' && this.drawTemplate !== 'free') {
      const paths = transformTemplate(this.drawTemplate, {
        x: p[0],
        y: p[1],
        z: p[2],
        ry: (this.drawHeading * Math.PI) / 180,
        scale: 1,
      })
      this.callbacks.onDrawFinish?.({
        shape: 'arrow',
        paths,
        width: this.drawWidth,
        template: this.drawTemplate,
      })
      this._resetDraft()
      return
    }
    // 与上一点过近则忽略（避免双击完成时留下重复点）
    const last = this.drawPoints[this.drawPoints.length - 1]
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.15) return
    this.drawPoints.push(p)
    this.drawHover = p
    this._updateDrawPreview()
    this.callbacks.onDrawChange?.(this.drawPoints.length)
  }

  /** 绘制落点：地面交点 + 可选的点云吸附 */
  _drawPoint(event) {
    const p = this._groundPoint(event)
    if (!p || !this.snapToPoints || !this.currentCloud) return p
    const snapped = this._snapToNearestPoint(this.currentCloud, p, this._snapRadius())
    return snapped || p
  }

  /**
   * 屏幕坐标 -> 水平面交点
   * @param {PointerEvent} event
   * @param {number} [planeZ] 目标平面高度，缺省为地面
   */
  _groundPoint(event, planeZ = this.groundZ) {
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const ray = this.raycaster.ray
    const dir = ray.direction
    if (Math.abs(dir.z) < 1e-6) return null
    const t = (planeZ - ray.origin.z) / dir.z
    if (t <= 0) return null
    const x = ray.origin.x + dir.x * t
    const y = ray.origin.y + dir.y * t
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return [x, y, planeZ]
  }

  /** 刷新绘制预览（已落点 + 悬停橡皮筋） */
  _updateDrawPreview() {
    if (this._drawPreview) {
      this.drawRoot.remove(this._drawPreview)
      disposeObject(this._drawPreview)
      this._drawPreview = null
    }
    if (!this.drawMode) return
    const paths = []
    if (this.drawPoints.length) {
      const pts = clonePoints(this.drawPoints)
      if (this.drawHover) pts.push(this.drawHover)
      paths.push(pts)
    } else if (this.drawHover && this.drawMode === 'arrow' && this.drawTemplate !== 'free') {
      // 模板箭头：在悬停位置显示半透明预览
      paths.push(
        ...transformTemplate(this.drawTemplate, {
          x: this.drawHover[0],
          y: this.drawHover[1],
          z: this.drawHover[2],
          ry: (this.drawHeading * Math.PI) / 180,
          scale: 1,
        }),
      )
    }
    if (!paths.length) return
    const group = new THREE.Group()
    // 草稿比实际线宽略宽、用亮黄色，确保在密集点云上也能看清
    const draftWidth = Math.max(this.drawWidth, 0.3) * 1.25
    const geometry = buildMarkingGeometry(paths, draftWidth, this.drawMode === 'arrow')
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthTest: false,
    })
    const mesh = new THREE.Mesh(geometry, mat)
    mesh.renderOrder = 900
    group.add(mesh)
    // 落点标记
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false })
    for (const [x, y, z] of this.drawPoints) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), dotMat)
      dot.position.set(x, y, z)
      dot.renderOrder = 901
      group.add(dot)
    }
    this._drawPreview = group
    this.drawRoot.add(group)
  }

  /* ---------------- 路面标线：同步与顶点编辑 ---------------- */

  /**
   * 让视口中的标线与数据保持一致
   * @param {Array} objects 当前帧对象
   * @param {Array} classes 类别表
   * @param {string|null} selectedId 选中对象 id
   */
  syncMarks(objects, classes, selectedIds) {
    const selected = toIdSet(selectedIds)
    const seen = new Set()
    const colorOf = (classId) => {
      const c = classes.find((x) => x.id === classId)
      return c ? c.color : '#f2f4f8'
    }
    for (const obj of objects) {
      if (obj.shape !== 'line' && obj.shape !== 'arrow') continue
      seen.add(obj.id)
      let mark = this.marks.get(obj.id)
      if (!mark) {
        mark = new RoadMarking3D(colorOf(obj.classId))
        this.marks.set(obj.id, mark)
        this.markRoot.add(mark.group)
      }
      if (!this._groupDragging) {
        mark.group.position.set(0, 0, 0)
        mark.group.rotation.set(0, 0, 0)
      }
      mark.apply(obj, colorOf(obj.classId))
      mark.setSelected(selected.has(obj.id))
    }
    for (const [id, mark] of Array.from(this.marks.entries())) {
      if (!seen.has(id)) {
        this.markRoot.remove(mark.group)
        mark.dispose()
        this.marks.delete(id)
        if (this.vertexObjectId === id) this.showVertexHandles(null)
      }
    }
    // 只读角色不显示顶点手柄
    if (this.readOnly) {
      if (this.vertexObjectId) this.showVertexHandles(null)
      return
    }
    // 绘制过程中不显示顶点手柄，避免与落点混淆
    if (this.drawMode) {
      if (this.vertexObjectId) this.showVertexHandles(null)
      return
    }
    // 选中标线时显示顶点手柄（拖动过程中不重建，否则会丢失当前拖拽的 mesh）
    if (this.vertexDrag) return
    const sel = selected.size === 1 ? objects.find((o) => selected.has(o.id)) : null
    if (sel && (sel.shape === 'line' || sel.shape === 'arrow')) {
      // 顶点数量与对象一致时只更新位置，避免每次同步都重建
      const count = sel.shape === 'line' ? sel.points?.length || 0 : (sel.paths || []).reduce((s, p) => s + p.length, 0)
      if (this.vertexObjectId === sel.id && this.vertexHandles.length === count) {
        this._updateVertexPositions(sel)
        return
      }
      this.showVertexHandles(sel)
    } else if (this.vertexObjectId) this.showVertexHandles(null)
  }

  /**
   * 在当前帧的对象上显示批注气泡。
   * 只有带 objectId 的批注才挂到具体标注上；同一对象显示最新一条并附带数量。
   */
  syncCommentLabels(comments, objects, frameIndex) {
    this._clearCommentLabels()
    if (!this.labelRenderer || !Array.isArray(comments) || !comments.length) return
    const byObject = new Map()
    for (const c of comments) {
      if (c.frameIndex !== frameIndex || !c.objectId) continue
      const entry = byObject.get(c.objectId)
      if (!entry) byObject.set(c.objectId, { latest: c, count: 1 })
      else {
        entry.count++
        if ((c.createdAt || 0) >= (entry.latest.createdAt || 0)) entry.latest = c
      }
    }
    if (!byObject.size) return
    const list = Array.isArray(objects) ? objects : []
    for (const [objectId, info] of byObject) {
      const obj = list.find((o) => o.id === objectId)
      if (!obj) continue
      let parent = null
      let local = null
      const box = this.boxes.get(objectId)
      if (box) {
        parent = box.group
        local = new THREE.Vector3(0, 0, (obj.h || 1) / 2 + 0.45)
      } else {
        const mark = this.marks.get(objectId)
        const center = mark?.center()
        if (!mark || !center) continue
        parent = mark.group
        local = center.clone()
        local.z += 0.7
      }
      const el = this._makeCommentElement(info.latest, info.count)
      const label = new CSS2DObject(el)
      label.center.set(0.5, 1)
      label.position.copy(local)
      parent.add(label)
      this.commentLabels.push({ label, parent })
    }
  }

  _makeCommentElement(comment, count) {
    const el = document.createElement('div')
    el.className = `pc-comment-label${comment.kind === 'rejection' ? ' is-rejection' : ''}`
    el.title = comment.text || ''
    const head = document.createElement('div')
    head.className = 'pc-comment-label-head'
    const author = document.createElement('span')
    author.textContent = comment.author || '批注'
    head.appendChild(author)
    if (count > 1) {
      const more = document.createElement('span')
      more.className = 'pc-comment-label-more'
      more.textContent = `+${count - 1}`
      head.appendChild(more)
    }
    const text = document.createElement('div')
    text.className = 'pc-comment-label-text'
    text.textContent = comment.text || ''
    el.appendChild(head)
    el.appendChild(text)
    return el
  }

  _clearCommentLabels() {
    for (const { label } of this.commentLabels) {
      label.removeFromParent()
      label.element?.remove?.()
    }
    this.commentLabels = []
  }

  /** 仅更新已有顶点手柄的位置 */
  _updateVertexPositions(obj) {
    const paths = obj.shape === 'line' ? [obj.points || []] : obj.paths || []
    let k = 0
    for (const path of paths) {
      for (const [x, y, z] of path) {
        const h = this.vertexHandles[k++]
        if (h) h.position.set(x, y, z)
      }
    }
  }

  /**
   * 显示某个标线的顶点手柄（传 null 隐藏）
   * @param {object|null} obj 标线对象
   */
  showVertexHandles(obj) {
    this.vertexObjectId = obj ? obj.id : null
    for (const h of this.vertexHandles) {
      this.vertexRoot.remove(h)
      h.material.dispose()
    }
    this.vertexHandles = []
    if (!obj) return
    const paths = obj.shape === 'line' ? [obj.points || []] : obj.paths || []
    paths.forEach((path, pathIndex) => {
      path.forEach(([x, y, z], index) => {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true, opacity: 0.95 })
        const mesh = new THREE.Mesh(this.vertexGeo, mat)
        mesh.position.set(x, y, z)
        mesh.scale.setScalar(0.1)
        mesh.renderOrder = 950
        mesh.userData.vertex = { objId: obj.id, pathIndex, index }
        this.vertexRoot.add(mesh)
        this.vertexHandles.push(mesh)
      })
    })
  }

  /** 拾取顶点手柄 */
  _pickVertex(event) {
    if (!this.vertexHandles.length) return null
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.vertexHandles, false)
    return hits.length ? hits[0].object.userData.vertex : null
  }

  _startVertexDrag(hit) {
    const mesh = this.vertexHandles.find(
      (h) => h.userData.vertex.index === hit.index && h.userData.vertex.pathIndex === hit.pathIndex,
    )
    if (!mesh) return
    this.vertexDrag = { ...hit, mesh }
    this.controls.enabled = false
  }

  _updateVertexDrag(event) {
    const st = this.vertexDrag
    if (!st) return
    // 保持顶点原有高度（标线通常比地面略高），只改平面位置
    const z = st.mesh.position.z
    let p = this._groundPoint(event, z)
    if (!p) return
    // 自动吸附到最近的点云点，使顶点贴合真实路面/标线点
    if (this.snapToPoints && this.currentCloud) {
      const snapped = this._snapToNearestPoint(this.currentCloud, p, this._snapRadius())
      if (snapped) p = snapped
    }
    st.mesh.position.set(p[0], p[1], p[2])
    this.callbacks.onVertexChange?.(st.objId, st.index, p, st.pathIndex)
  }

  /** 吸附搜索半径：随相机距离缩放，近距离更精确、远距离更好点中 */
  _snapRadius() {
    const d = this.camera.position.distanceTo(this.controls.target)
    return Math.min(1.5, Math.max(0.2, d * 0.02))
  }

  /**
   * 在点云中查找距离目标点最近的点（3D 距离，带高度容差过滤）
   * 使用 XY 平面网格加速，首次调用时为当前点云建立空间索引并缓存。
   * @param {object} cloud
   * @param {number[]} target [x,y,z]
   * @param {number} maxDist 最大吸附距离（米）
   * @returns {number[]|null} [x,y,z]
   */
  _snapToNearestPoint(cloud, target, maxDist = 0.5) {
    const { cell, grid, pos, count } = this._ensureSnapGrid(cloud)
    const cx = Math.floor(target[0] / cell)
    const cy = Math.floor(target[1] / cell)
    const r = Math.ceil(maxDist / cell)
    // 高度容差：优先吸附到与顶点同一高度层的地面/标线点，避免吸到车身、建筑上
    const zTol = Math.min(0.8, Math.max(0.4, maxDist))
    let best = -1
    let bestD2 = maxDist * maxDist
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        const arr = grid.get(ix * 100000 + iy)
        if (!arr) continue
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k]
          const dx = pos[i * 3] - target[0]
          const dy = pos[i * 3 + 1] - target[1]
          const dz = pos[i * 3 + 2] - target[2]
          if (Math.abs(dz) > zTol) continue
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD2) {
            bestD2 = d2
            best = i
          }
        }
      }
    }
    if (best < 0 || best >= count) return null
    return [pos[best * 3], pos[best * 3 + 1], pos[best * 3 + 2]]
  }

  /** 为点云建立/复用 XY 网格索引 */
  _ensureSnapGrid(cloud) {
    if (cloud._snapGrid) return cloud._snapGrid
    const cell = 0.5
    const grid = new Map()
    const pos = cloud.positions
    const count = cloud.pointCount
    for (let i = 0; i < count; i++) {
      const key = Math.floor(pos[i * 3] / cell) * 100000 + Math.floor(pos[i * 3 + 1] / cell)
      let arr = grid.get(key)
      if (!arr) {
        arr = []
        grid.set(key, arr)
      }
      arr.push(i)
    }
    cloud._snapGrid = { cell, grid, pos, count }
    return cloud._snapGrid
  }

  _endVertexDrag() {
    this.vertexDrag = null
    this.controls.enabled = true
  }

  /* ---------------- 点云加载 / 显示 ---------------- */

  /** 计算帧的缓存键：URL 帧用 URL，本地文件用「名字:大小:修改时间」 */
  cacheKeyFor(frame) {
    if (frame.source.url) return frame.source.url
    const f = frame.source.file
    return `${frame.name}:${f ? f.size : 0}:${f ? f.lastModified : 0}`
  }

  /** 取帧点云（命中缓存则提升为最近使用，否则加载并写入 LRU 缓存） */
  async getCloud(frame, options = {}) {
    const key = this.cacheKeyFor(frame)
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)
      this.cache.delete(key)
      this.cache.set(key, entry)
      return entry
    }
    if (this.inflight.has(key)) return this.inflight.get(key)
    const promise = loadPointCloud(frame.source, { signal: options.signal })
      .then((cloud) => {
        cloud.key = key
        this._attachSavedLabels(cloud)
        this.cache.set(key, cloud)
        while (this.cache.size > MAX_CACHE) {
          const oldest = this.cache.keys().next().value
          const evicted = this.cache.get(oldest)
          if (evicted) evicted._snapGrid = null // 释放空间索引，避免缓存多帧时内存膨胀
          this.cache.delete(oldest)
        }
        return cloud
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, promise)
    return promise
  }

  /**
   * 可选预取：默认关闭。开启后只预取下一帧，并延迟 1.5 秒，
   * 避免后台 Worker/下载和用户正在切换的当前帧抢资源。
   */
  prefetchFrames(frames, index) {
    if (!this.prefetchEnabled || !frames?.length) return
    this._prefetchQueue = []
    const next = frames[index + 1] || frames[index - 1]
    if (!next) return
    const key = this.cacheKeyFor(next)
    if (this.cache.has(key) || this.inflight.has(key)) return
    this._prefetchQueue.push(next)
    if (this._prefetchTimer) clearTimeout(this._prefetchTimer)
    this._prefetchTimer = setTimeout(() => {
      this._prefetchTimer = null
      this._drainPrefetch()
    }, 1500)
  }

  /** 切帧/切数据集/卸载时清空预取队列 */
  clearPrefetch() {
    this._prefetchQueue = []
    if (this._prefetchTimer) {
      clearTimeout(this._prefetchTimer)
      this._prefetchTimer = null
    }
  }

  _drainPrefetch() {
    if (!this.prefetchEnabled || this._prefetching) return
    const next = this._prefetchQueue.shift()
    if (!next) return
    this._prefetching = true
    const run = () => {
      this.getCloud(next)
        .catch(() => {})
        .finally(() => {
          this._prefetching = false
          this._drainPrefetch()
        })
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 })
    else setTimeout(run, 30)
  }

  /** 显示某一帧：点云先上屏，点标签在后台异步加载 */
  async showFrame(frame, options = {}) {
    const cloud = await this.getCloud(frame, options)
    // 点云优先显示，绝不等待点标签网络请求
    this.setCloud(cloud)
    frame.pointCount = cloud.pointCount
    this._loadPointLabels(frame, cloud)
      .then((loaded) => {
        if (!loaded) return
        if (this.currentCloud === cloud && this.colorMode === 'label') this.refreshColors()
        this.callbacks.onLabelsLoaded?.(frame, cloud)
      })
      .catch(() => {})
    return cloud
  }

  /**
   * 加载帧附带的点级语义标签文件（scene.json 中的 pointLabels 字段）。
   * 标签按帧缓存键写入 labelsByKey，格式与手工标注一致，因此可以继续编辑/导出。
   * 失败只告警，不影响点云显示。
   */
  async _loadPointLabels(frame, cloud) {
    if (!frame?.pointLabelsUrl || !cloud?.key) return false
    if (this.labelsByKey.has(cloud.key)) return false
    if (cloud.pointLabels) return false
    if (this.pointLabelFailed.has(frame.pointLabelsUrl)) return false
    try {
      let template = this.pointLabelTemplates.get(frame.pointLabelsUrl)
      if (!template) {
        let data = this.pointLabelFiles.get(frame.pointLabelsUrl)
        if (!data) {
          data = await withTimeout(
            get(frame.pointLabelsUrl, null, { silent: true }),
            5000,
            '点级标签加载超时',
          )
          this.pointLabelFiles.set(frame.pointLabelsUrl, data)
        }
        if (!data || !Array.isArray(data.segments)) {
          this.pointLabelFailed.add(frame.pointLabelsUrl)
          return false
        }
        const n = cloud.pointCount
        const labels = new Int32Array(n).fill(-1)
        const pointSegment = new Int32Array(n).fill(-1)
        const segments = []
        let segId = 0
        for (const seg of data.segments) {
          const classId = Number(seg.classId)
          const indices = (seg.indices || []).filter((i) => Number.isInteger(i) && i >= 0 && i < n)
          if (!indices.length) continue
          const id = ++segId
          segments.push({ id, classId, indices: Int32Array.from(indices) })
          for (const i of indices) {
            labels[i] = classId
            pointSegment[i] = id
          }
        }
        if (!segments.length) {
          this.pointLabelFailed.add(frame.pointLabelsUrl)
          return false
        }
        template = { pointLabels: labels, pointSegment, segments, pointCount: n }
        this.pointLabelTemplates.set(frame.pointLabelsUrl, template)
        this.segmentSeq = Math.max(this.segmentSeq, segId)
      }
      if (template.pointCount !== cloud.pointCount) {
        this.pointLabelFailed.add(frame.pointLabelsUrl)
        return false
      }
      // 未编辑帧共享同一份只读真值模板，显著降低多帧浏览时的内存
      cloud.pointLabels = template.pointLabels
      cloud.pointSegment = template.pointSegment
      cloud.segments = template.segments
      cloud.labelHistory = []
      cloud._labelsShared = true
      cloud._labelsTemplateUrl = frame.pointLabelsUrl
      return true
    } catch (err) {
      this.pointLabelFailed.add(frame.pointLabelsUrl)
      console.warn('[PointCloudViewer] 点级标签加载失败:', frame.pointLabelsUrl, err)
      return false
    }
  }

  /** 用点云数据构建 BufferGeometry 并替换当前显示对象 */
  setCloud(cloud) {
    this.currentCloud = cloud
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    // baseColors 保存「真实颜色」，renderColors 是叠加选中高亮后的渲染颜色
    const computed = this._computeColors(cloud)
    this.baseColors = computed === cloud.colors ? new Float32Array(computed) : computed
    this.renderColors = new Float32Array(this.baseColors)
    geometry.setAttribute('color', new THREE.BufferAttribute(this.renderColors, 3))
    geometry.computeBoundingSphere()

    if (this.pointObject) {
      this.scene.remove(this.pointObject)
      this.pointObject.geometry.dispose()
    }
    this.pointObject = new THREE.Points(geometry, this.pointMaterial)
    this.pointObject.frustumCulled = false // 点云包围球可能不准，关闭视锥剔除避免整块消失
    this.pointGeometry = geometry
    this.scene.add(this.pointObject)

    // 切换帧后清空上一次的选中与未完成的绘制草稿
    this.selectionMask = null
    this.selectionIndices = []
    this.selectionCount = 0
    this.selectedSegmentId = null
    if (this.drawPoints.length) this._resetDraft()
    this.callbacks.onSelection?.(0)
    this.callbacks.onSegmentSelect?.(null)
  }

  /** 根据当前着色模式计算每个点的颜色，返回 Float32Array(rgb) */
  _computeColors(cloud) {
    const mode = this.colorMode
    if (mode === 'label' && cloud.pointLabels) {
      return labelsToColor(cloud.pointLabels, this.callbacks.getClasses?.() || [])
    }
    if (mode === 'source' && cloud.colors) {
      return cloud.colors
    }
    if ((mode === 'intensity' || mode === 'source') && cloud.intensity) {
      return intensityToColor(cloud.intensity)
    }
    if (mode === 'height' || mode === 'source') {
      return heightToColor(cloud.positions)
    }
    // 兜底：无强度用高度
    if (cloud.intensity) return intensityToColor(cloud.intensity)
    return heightToColor(cloud.positions)
  }

  /** 重新计算基础颜色并刷新渲染缓冲 */
  refreshColors() {
    if (!this.currentCloud || !this.pointGeometry || !this.baseColors) return
    this.baseColors.set(this._computeColors(this.currentCloud))
    this._paintColors()
  }

  /** 把 baseColors（+ 待提交选中高亮 + 选中片段高亮）写入 GPU color 属性 */
  _paintColors() {
    if (!this.pointGeometry || !this.baseColors || !this.renderColors) return
    const base = this.baseColors
    const out = this.renderColors
    const cloud = this.currentCloud
    const segId = this.selectedSegmentId
    const pointSeg = segId != null ? cloud?.pointSegment : null
    // 原生拷贝 base，随后只绘制少量高亮点，避免每次全量逐点判断
    out.set(base)
    if (pointSeg) {
      const seg = cloud?.segments?.find((s) => s.id === segId)
      if (seg) {
        for (const i of seg.indices) {
          if (pointSeg[i] !== segId) continue
          const j = i * 3
          out[j] = 1
          out[j + 1] = 1
          out[j + 2] = 1
        }
      }
    }
    for (const i of this.selectionIndices) {
      const j = i * 3
      out[j] = 1
      out[j + 1] = 0.92
      out[j + 2] = 0.25
    }
    this.pointGeometry.getAttribute('color').needsUpdate = true
  }

  setColorMode(mode) {
    this.colorMode = mode
    this.refreshColors()
  }

  /** 仅预设着色模式（不触发重绘），用于「加载帧之前」先定好模式，省去一次全量重算 */
  presetColorMode(mode) {
    this.colorMode = mode
  }

  setPointSize(size) {
    this.pointMaterial.size = size
    this.pointMaterial.needsUpdate = true
  }

  setBackground(hex) {
    this.scene.background = new THREE.Color(hex)
  }

  /** 根据点云包围球自动摆放相机，使整片点云可见 */
  fitView(radiusScale = 2.4) {
    if (!this.pointGeometry) return
    this.pointGeometry.computeBoundingSphere()
    const sphere = this.pointGeometry.boundingSphere
    if (!sphere) return
    const center = sphere.center.clone()
    const radius = Math.max(sphere.radius, 1)
    const dir = new THREE.Vector3(-0.6, -0.75, 0.55).normalize()
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(dir, radius * radiusScale)
    // 近/远裁剪面随尺度自适应，兼顾小物体（bunny）与大地图
    this.camera.near = Math.max(radius / 500, 0.02)
    this.camera.far = radius * 40
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  setView(position, target) {
    if (position) this.camera.position.set(position[0], position[1], position[2])
    if (target) this.controls.target.set(target[0], target[1], target[2])
    this.controls.update()
  }

  /* ---------------- 3D 框 ---------------- */

  /**
   * 让视口中的框与数据保持一致：新增缺失的、更新已有的、移除多余的
   * @param {Array} objects 当前帧对象
   * @param {Array} classes 类别表（用于取颜色）
   * @param {string|null} selectedId 选中对象 id
   */
  syncBoxes(objects, classes, selectedIds) {
    const selected = toIdSet(selectedIds)
    const seen = new Set()
    const colorOf = (classId) => {
      const c = classes.find((x) => x.id === classId)
      return c ? c.color : '#8899aa'
    }
    for (const obj of objects) {
      seen.add(obj.id)
      let box = this.boxes.get(obj.id)
      if (!box) {
        box = new BBox3D()
        this.boxes.set(obj.id, box)
        this.boxRoot.add(box.group)
      }
      // 正在拖动的框由手柄直接控制，此处不回写，避免把尺寸乘子复位导致跳变
      if (obj.id === this.gizmoObjectId && this._draggingGizmo) {
        box.setSelected(selected.has(obj.id))
        continue
      }
      box.apply(obj, colorOf(obj.classId))
      box.setSelected(selected.has(obj.id))
    }
    for (const [id, box] of Array.from(this.boxes.entries())) {
      if (!seen.has(id)) {
        this.boxRoot.remove(box.group)
        box.dispose()
        this.boxes.delete(id)
        if (this.gizmoObjectId === id) this.attachGizmo(null)
      }
    }
    this._refreshScaleHandles()
  }

  /** 解绑整体平移/旋转手柄 */
  detachGroupGizmo() {
    if (!this.groupGizmoIds.length) return
    this.groupGizmoIds = []
    this._groupDragging = false
    this._groupStart = null
    this._groupStartPositions = null
    this._handleStartPositions = null
    this._groupAllowZ = false
    this._groupMode = 'translate'
    this._groupStartRotation = 0
    this._groupRotateCenter = null
    this.groupPivot.rotation.set(0, 0, 0)
    this.transform.detach()
  }

  /** 绑定/解绑编辑手柄：平移/旋转用 TransformControls，缩放用自定义手柄 */
  attachGizmo(objectId) {
    this.detachGroupGizmo()
    this.gizmoObjectId = objectId
    if (this.readOnly) {
      this.gizmoObjectId = null
      this.transform.detach()
      this._refreshScaleHandles()
      return
    }
    const noGizmo = ['select', 'scale', 'line', 'arrow']
    const usable = objectId && this.boxes.has(objectId) && !noGizmo.includes(this.activeTool)
    if (usable) {
      if (this.activeTool === 'rotate') {
        this.transform.showX = false
        this.transform.showY = false
        this.transform.showZ = true
      } else {
        this.transform.showX = true
        this.transform.showY = true
        this.transform.showZ = true
      }
      this.transform.attach(this.boxes.get(objectId).group)
    } else this.transform.detach()
    this._refreshScaleHandles()
  }

  /**
   * 整体平移/旋转：单条标线或多选对象。手柄挂到选中对象质心的临时对象上。
   * 混合选择（框+标线）只开放 XY 平移，避免标线离开地面；全是框时开放 Z。
   * @param {string[]} ids
   * @param {'translate'|'rotate'} [mode]
   * @param {[number,number,number]|null} [centerOverride] 单条标线使用顶点质心，保证旋转中心一致
   */
  attachGroupGizmo(ids, mode = 'translate', centerOverride = null) {
    this.detachGroupGizmo()
    this.transform.detach()
    this.gizmoObjectId = null
    this._refreshScaleHandles()
    if (this.readOnly) return
    const unique = Array.from(new Set(ids || []))
    if (!unique.length) {
      this.detachGroupGizmo()
      return
    }
    const rotate = mode === 'rotate'
    if (rotate && unique.length !== 1) return
    const allBoxes = unique.every((id) => this.boxes.has(id))
    const center = new THREE.Vector3()
    if (centerOverride) {
      center.set(centerOverride[0], centerOverride[1], centerOverride[2] || 0)
    } else {
      const centers = []
      for (const id of unique) {
        const box = this.boxes.get(id)
        if (box) {
          centers.push(box.group.position)
          continue
        }
        const mark = this.marks.get(id)
        const c = mark?.center()
        if (c) centers.push(c)
      }
      if (!centers.length) {
        this.detachGroupGizmo()
        return
      }
      for (const p of centers) center.add(p)
      center.divideScalar(centers.length)
    }
    const allowZ = !rotate && allBoxes
    this.groupPivot.position.copy(center)
    this.groupPivot.rotation.set(0, 0, 0)
    this.groupPivot.updateMatrixWorld()
    this.groupGizmoIds = unique
    this._groupMode = rotate ? 'rotate' : 'translate'
    this._groupAllowZ = allowZ
    this.transform.setMode(rotate ? 'rotate' : 'translate')
    this.transform.showX = !rotate
    this.transform.showY = !rotate
    this.transform.showZ = rotate || allowZ
    this.transform.attach(this.groupPivot)
    this.controls.enabled = true
  }

  /** 切换工具：平移/旋转 -> TransformControls；缩放 -> 自定义面手柄；绘制模式不显示手柄 */
  setGizmoMode(mode) {
    if (!['select', 'translate', 'rotate', 'scale', 'line', 'arrow'].includes(mode)) return
    this.activeTool = mode
    if (mode !== 'translate') this.detachGroupGizmo()
    if (mode === 'line' || mode === 'arrow') {
      this.transform.detach()
      this._refreshScaleHandles()
      return
    }
    if (mode === 'translate' || mode === 'rotate') {
      this.transform.setMode(mode)
      // 旋转只开放绕 Z 轴（偏航）
      const axisOnlyZ = mode === 'rotate'
      this.transform.showX = !axisOnlyZ
      this.transform.showY = !axisOnlyZ
      this.transform.showZ = true
    }
    this._refreshScaleHandles()
  }

  /* ---------------- 缩放手柄 ---------------- */

  /** 命中测试：返回被点中的手柄轴向索引（0=X/长, 1=Y/宽, 2=Z/高），未命中返回 -1 */
  _pickScaleHandle(event) {
    if (!this.scaleHandleGroup.visible) return -1
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.scaleHandles, false)
    return hits.length ? hits[0].object.userData.scaleAxis : -1
  }

  /** 按当前选中框的位置/尺寸摆放三个缩放手柄 */
  _refreshScaleHandles() {
    const box = this.gizmoObjectId ? this.boxes.get(this.gizmoObjectId) : null
    const show = this.activeTool === 'scale' && !!box
    this.scaleHandleGroup.visible = show
    if (!show) return
    const { l, w, h } = box.dims
    const p = box.group.position
    const ry = box.group.rotation.z
    const cos = Math.cos(ry)
    const sin = Math.sin(ry)
    // 每个手柄位于对应方向的表面中心（局部坐标 -> 世界坐标）
    const local = [
      [l / 2, 0, 0],
      [0, w / 2, 0],
      [0, 0, h / 2],
    ]
    const r = Math.max(0.03, Math.min(l, w, h) * 0.08) // 手柄半径随框尺寸缩放
    for (let i = 0; i < 3; i++) {
      const [lx, ly, lz] = local[i]
      const handle = this.scaleHandles[i]
      handle.position.set(p.x + lx * cos - ly * sin, p.y + lx * sin + ly * cos, p.z + lz)
      handle.scale.setScalar(r)
    }
  }

  /** 开始缩放某个轴 */
  _startScale(index) {
    const box = this.boxes.get(this.gizmoObjectId)
    if (!box) return
    const dir = new THREE.Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0)
    dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), box.group.rotation.z)
    this._scaleState = {
      index,
      key: ['l', 'w', 'h'][index],
      objId: this.gizmoObjectId,
      center: box.group.position.clone(),
      dir: dir.normalize(),
    }
    this.controls.enabled = false // 拖动手柄时禁止相机平移
  }

  /**
   * 缩放拖动：求鼠标射线与「过框中心、沿该轴」的直线的最近点，
   * 以该点到中心的距离作为半尺寸（绕中心对称缩放）
   */
  _updateScale(event) {
    const st = this._scaleState
    if (!st) return
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const ray = this.raycaster.ray
    const D = st.dir
    const w0 = st.center.clone().sub(ray.origin)
    const b = D.dot(ray.direction)
    const d = D.dot(w0)
    const e = ray.direction.dot(w0)
    const denom = 1 - b * b
    // 最近点参数（射线与轴近似平行时退化为投影）
    const s = Math.abs(denom) < 1e-6 ? d : (e * b - d) / denom
    const dim = Math.min(2000, Math.max(0.02, Math.abs(s) * 2))
    this.callbacks.onBoxChange?.(st.objId, { [st.key]: dim })
  }

  _endScale() {
    this._scaleState = null
    this.controls.enabled = true
  }

  /** 把轨道控制器焦点移动到某个对象（框用中心，标线用包围盒中心） */
  focusObject(obj) {
    if (obj.shape === 'line' || obj.shape === 'arrow') {
      const mark = this.marks.get(obj.id)
      const center = mark?.center()
      if (center) {
        this.controls.target.copy(center)
        this.controls.update()
      }
      return
    }
    const box = this.boxes.get(obj.id)
    if (!box) return
    this.controls.target.set(obj.x, obj.y, obj.z)
    this.controls.update()
  }

  /* ---------------- 拾取工具 ---------------- */

  screenToRay(event) {
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.ray
  }

  raycastPoints(event) {
    if (!this.pointObject) return null
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.pointObject, false)
    return hits.length ? hits[0] : null
  }

  projectPoint(x, y, z, out = new THREE.Vector3()) {
    out.set(x, y, z).project(this.camera)
    return out
  }

  /* ---------------- 点级语义分割 ---------------- */

  /** 开关分割模式，并切换鼠标按键映射（左键让给框选） */
  setSegEnabled(enabled) {
    this.segEnabled = !!enabled && !this.readOnly
    this.controls.mouseButtons = this.drawMode
      ? { ...MOUSE_DRAW }
      : this.segEnabled
        ? { ...MOUSE_SEGMENT }
        : { ...MOUSE_DEFAULT }
    if (!this.segEnabled) {
      this._sketch = null
      this.callbacks.onSketch?.(null)
      this.clearSelection()
      this.clearSegmentSelection()
    }
  }

  setSegMode(mode) {
    this.segMode = mode
  }

  /** 是否允许新画的标签覆盖已有标签 */
  setSegOverwrite(overwrite) {
    this.segOverwrite = !!overwrite
  }

  setBrushSize(size) {
    this.brushSize = size
  }

  /** 确保选中掩码与当前点云点数一致（变更帧后重建） */
  _ensureMask() {
    const n = this.currentCloud.pointCount
    if (!this.selectionMask || this.selectionMask.length !== n) {
      this.selectionMask = new Uint8Array(n)
      this.selectionIndices = []
      this.selectionCount = 0
    }
    return this.selectionMask
  }

  /** 掩码变化后：更新选中数、刷新高亮颜色、通知上层 */
  _afterMaskChange() {
    this.selectionCount = this.selectionIndices.length
    this._paintColors()
    this.callbacks.onSelection?.(this.selectionCount)
  }

  /** 世界坐标 -> 屏幕像素坐标（复用对象，避免逐点分配） */
  _projectToScreen(pos, i, W, H) {
    const v = this._projector
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(this.camera)
    const s = this._screen
    s.x = (v.x * 0.5 + 0.5) * W
    s.y = (-v.y * 0.5 + 0.5) * H
    s.z = v.z
    return s
  }

  /** 选中投影落在屏幕矩形内的所有点 */
  _selectPointsInRect(x0, y0, x1, y1) {
    if (!this.currentCloud) return
    const pos = this.currentCloud.positions
    const n = this.currentCloud.pointCount
    const W = this.renderer.domElement.clientWidth
    const H = this.renderer.domElement.clientHeight
    const minx = Math.min(x0, x1)
    const maxx = Math.max(x0, x1)
    const miny = Math.min(y0, y1)
    const maxy = Math.max(y0, y1)
    const mask = this._ensureMask()
    for (let i = 0; i < n; i++) {
      const p = this._projectToScreen(pos, i, W, H)
      if (p.z < -1 || p.z > 1) continue // 裁剪面之外
      if (p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy && !mask[i]) {
        mask[i] = 1
        this.selectionIndices.push(i)
      }
    }
    this._afterMaskChange()
  }

  /** 画笔：选中投影落在屏幕圆内的所有点 */
  _selectPointsInCircle(cx, cy, r) {
    if (!this.currentCloud) return
    const pos = this.currentCloud.positions
    const n = this.currentCloud.pointCount
    const W = this.renderer.domElement.clientWidth
    const H = this.renderer.domElement.clientHeight
    const r2 = r * r
    const mask = this._ensureMask()
    for (let i = 0; i < n; i++) {
      const p = this._projectToScreen(pos, i, W, H)
      if (p.z < -1 || p.z > 1) continue
      const dx = p.x - cx
      const dy = p.y - cy
      if (dx * dx + dy * dy <= r2 && !mask[i]) {
        mask[i] = 1
        this.selectionIndices.push(i)
      }
    }
    this._afterMaskChange()
  }

  /** 套索：选中投影落在多边形内的所有点 */
  _selectPointsInPolygon(points) {
    if (!this.currentCloud) return
    const pos = this.currentCloud.positions
    const n = this.currentCloud.pointCount
    const W = this.renderer.domElement.clientWidth
    const H = this.renderer.domElement.clientHeight
    const mask = this._ensureMask()
    for (let i = 0; i < n; i++) {
      const p = this._projectToScreen(pos, i, W, H)
      if (p.z < -1 || p.z > 1) continue
      if (pointInPolygon(p.x, p.y, points) && !mask[i]) {
        mask[i] = 1
        this.selectionIndices.push(i)
      }
    }
    this._afterMaskChange()
  }

  /** 清空待提交的选中（不影响已生成的标签） */
  clearSelection() {
    this.selectionMask = null
    this.selectionIndices = []
    this.selectionCount = 0
    this._paintColors()
    this.callbacks.onSelection?.(0)
  }

  /* --- 标签片段（segment）：一次涂抹/框选生成一个片段，便于点击编辑 --- */

  /** 初始化点云的标签/片段容器 */
  _ensureSegmentStructures(cloud) {
    if (!cloud.pointLabels) cloud.pointLabels = new Int32Array(cloud.pointCount).fill(-1)
    if (!cloud.pointSegment) cloud.pointSegment = new Int32Array(cloud.pointCount).fill(-1)
    if (!cloud.segments) cloud.segments = []
    if (!cloud.labelHistory) cloud.labelHistory = []
  }

  /** 共享真值模板第一次被编辑时复制为当前帧私有数据 */
  _ensureWritableLabels(cloud) {
    if (!cloud) return
    if (!cloud._labelsShared) {
      this._ensureSegmentStructures(cloud)
      return
    }
    cloud.pointLabels = Int32Array.from(cloud.pointLabels || [])
    cloud.pointSegment = Int32Array.from(cloud.pointSegment || [])
    cloud.segments = (cloud.segments || []).map((s) => ({
      id: s.id,
      classId: s.classId,
      indices: Int32Array.from(s.indices),
    }))
    cloud.labelHistory = []
    cloud._labelsShared = false
    cloud._labelsTemplateUrl = null
  }

  /**
   * 把已保存的标签挂到新加载的点云上（点云缓存被淘汰后重新加载也能恢复标注）
   */
  _attachSavedLabels(cloud) {
    const saved = this.labelsByKey.get(cloud.key)
    if (saved) {
      cloud.pointLabels = saved.pointLabels
      cloud.pointSegment = saved.pointSegment
      cloud.segments = saved.segments
      cloud.labelHistory = saved.labelHistory
      cloud._labelsShared = false
      return
    }
    // 模板由 _loadPointLabels 挂载；这里不要清空已挂载的共享数组
    if (cloud._labelsShared && cloud.pointLabels) return
    cloud.pointLabels = null
    cloud.pointSegment = null
    cloud.segments = null
    cloud.labelHistory = null
    cloud._labelsShared = false
  }

  /** 把已编辑帧的标签写回缓存（共享真值模板不入缓存） */
  _persistLabels(cloud = this.currentCloud) {
    if (!cloud || !cloud.key || cloud._labelsShared) return
    // 重新插入以更新 LRU 顺序
    this.labelsByKey.delete(cloud.key)
    this.labelsByKey.set(cloud.key, {
      pointLabels: cloud.pointLabels,
      pointSegment: cloud.pointSegment,
      segments: cloud.segments,
      labelHistory: cloud.labelHistory,
    })
    while (this.labelsByKey.size > MAX_LABEL_FRAMES) {
      this.labelsByKey.delete(this.labelsByKey.keys().next().value)
    }
  }

  /**
   * 取出某帧已保存的点标签并转成可序列化结构（供保存/导出）
   * 无标签时返回 null
   */
  serializeLabels(key) {
    const saved = key ? this.labelsByKey.get(key) : null
    if (!saved || !saved.pointLabels) return null
    const labels = saved.pointLabels
    let labeled = 0
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labeled++
    if (!labeled) return null
    return {
      pointCount: labels.length,
      labeled,
      labels: Array.from(labels),
      segments: (saved.segments || []).map((s) => ({
        classId: s.classId,
        indices: Array.from(s.indices),
      })),
    }
  }

  /** 记录一条操作级撤销记录（只保存变化点，避免整帧快照占用大量内存） */
  _pushAction(cloud, action) {
    if (!cloud) return
    this._ensureSegmentStructures(cloud)
    cloud.labelHistory.push(action)
    if (cloud.labelHistory.length > 40) cloud.labelHistory.shift()
  }

  /**
   * 把待提交掩码中的点提交为一个新标签片段，返回实际标记的点数。
   * `segOverwrite=false` 时跳过已有标签的点（不覆盖）。
   */
  _commitLabelToMask(classId) {
    const cloud = this.currentCloud
    const mask = this.selectionMask
    if (!cloud || !mask) return 0
    this._ensureWritableLabels(cloud)
    const indices = []
    const skipExisting = !this.segOverwrite
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      // 不覆盖模式：已经标注过的点保持原标签
      if (skipExisting && cloud.pointLabels[i] >= 0) continue
      indices.push(i)
    }
    if (!indices.length) return 0
    const id = ++this.segmentSeq
    const oldLabels = new Int32Array(indices.length)
    const oldSegments = new Int32Array(indices.length)
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      oldLabels[k] = cloud.pointLabels[i]
      oldSegments[k] = cloud.pointSegment[i]
    }
    cloud.segments.push({ id, classId, indices: Int32Array.from(indices) })
    for (const i of indices) {
      cloud.pointLabels[i] = classId
      cloud.pointSegment[i] = id
    }
    this._pushAction(cloud, {
      kind: 'commit',
      segId: id,
      indices: Int32Array.from(indices),
      oldLabels,
      oldSegments,
    })
    // 自动切到标签着色，使点显示为类别颜色
    this.colorMode = 'label'
    this.refreshColors()
    this._persistLabels(cloud)
    return indices.length
  }

  /**
   * 屏幕空间拾取标线：把每条标线路径投影到屏幕，按像素距离命中。
   * 远处标线的射线拾取面可能只有几像素宽，这层兜底让箭头/细线仍然可点。
   * @param {number} x 画布像素坐标
   * @param {number} y 画布像素坐标
   * @param {number} threshold 命中像素半径
   * @returns {string|null} 标线对象 id
   */
  _pickMarkAtScreen(x, y, threshold = 14) {
    if (!this.marks.size) return null
    const W = this.renderer.domElement.clientWidth
    const H = this.renderer.domElement.clientHeight
    const t2 = threshold * threshold
    let bestId = null
    let bestD2 = t2
    let bestZ = Infinity
    const project = (p) => {
      const v = this._projector.set(p[0], p[1], p[2] || 0).project(this.camera)
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z }
    }
    const distToSegment2 = (ax, ay, bx, by) => {
      const vx = bx - ax
      const vy = by - ay
      const wx = x - ax
      const wy = y - ay
      const c1 = vx * wx + vy * wy
      if (c1 <= 0) return wx * wx + wy * wy
      const c2 = vx * vx + vy * vy
      if (c2 <= c1) {
        const dx = x - bx
        const dy = y - by
        return dx * dx + dy * dy
      }
      const t = c1 / c2
      const dx = x - (ax + vx * t)
      const dy = y - (ay + vy * t)
      return dx * dx + dy * dy
    }
    for (const mark of this.marks.values()) {
      const paths = mark.paths || []
      for (const path of paths) {
        if (!path?.length) continue
        if (path.length === 1) {
          const p = project(path[0])
          if (p.z < -1 || p.z > 1) continue
          const d2 = (p.x - x) ** 2 + (p.y - y) ** 2
          if (d2 <= bestD2 && (d2 < bestD2 || p.z < bestZ)) {
            bestD2 = d2
            bestZ = p.z
            bestId = mark.objectId
          }
          continue
        }
        for (let i = 1; i < path.length; i++) {
          const a = project(path[i - 1])
          const b = project(path[i])
          if ((a.z < -1 || a.z > 1) && (b.z < -1 || b.z > 1)) continue
          const d2 = distToSegment2(a.x, a.y, b.x, b.y)
          const z = Math.min(a.z, b.z)
          if (d2 <= bestD2 && (d2 < bestD2 || z < bestZ)) {
            bestD2 = d2
            bestZ = z
            bestId = mark.objectId
          }
        }
      }
    }
    return bestId
  }

  /**
   * 屏幕空间拾取最近的点（比射线拾取更可靠，点按像素尺寸渲染）
   * @param {number} radius 像素半径
   * @param {boolean} labeledOnly 只考虑已有标签的点（用于点击编辑标签）
   */
  _pickNearestPoint(x, y, radius = 8, labeledOnly = false) {
    const cloud = this.currentCloud
    if (!cloud) return -1
    if (labeledOnly && (!cloud.pointLabels || !cloud.pointSegment)) return -1
    const pos = cloud.positions
    const n = cloud.pointCount
    const W = this.renderer.domElement.clientWidth
    const H = this.renderer.domElement.clientHeight
    const r2 = radius * radius
    let best = -1
    let bestZ = Infinity
    for (let i = 0; i < n; i++) {
      if (labeledOnly && (cloud.pointLabels[i] < 0 || cloud.pointSegment[i] === -1)) continue
      const p = this._projectToScreen(pos, i, W, H)
      if (p.z < -1 || p.z > 1) continue
      const dx = p.x - x
      const dy = p.y - y
      if (dx * dx + dy * dy > r2) continue
      if (p.z < bestZ) {
        bestZ = p.z
        best = i
      }
    }
    return best
  }

  /**
   * 在事件位置拾取标签片段并选中；未命中则取消选中。
   * 只考虑「已标注」的点并放宽到 12px，避免邻近的未标注点抢先命中导致点不中。
   */
  selectSegmentAt(event) {
    const p = this._localPoint(event)
    const index = this._pickNearestPoint(p.x, p.y, 12, true)
    const cloud = this.currentCloud
    const segId = index >= 0 && cloud?.pointSegment ? cloud.pointSegment[index] : -1
    if (segId == null || segId === -1) {
      this.clearSegmentSelection()
      return
    }
    this._selectSegmentById(segId)
  }

  /** 按 id 选中片段（并切到标签着色以便看清） */
  _selectSegmentById(id) {
    this.selectedSegmentId = id
    this.colorMode = 'label'
    this.refreshColors()
    this.callbacks.onSegmentSelect?.(this.getSelectedSegment())
  }

  /** 当前选中片段信息 { id, classId, count }（无则 null） */
  getSelectedSegment() {
    const cloud = this.currentCloud
    if (!cloud || !cloud.segments || this.selectedSegmentId == null) return null
    const seg = cloud.segments.find((s) => s.id === this.selectedSegmentId)
    if (!seg) return null
    let count = 0
    for (const i of seg.indices) if (cloud.pointSegment[i] === seg.id) count++
    return { id: seg.id, classId: seg.classId, count }
  }

  clearSegmentSelection() {
    if (this.selectedSegmentId === null) return
    this.selectedSegmentId = null
    this._paintColors()
    this.callbacks.onSegmentSelect?.(null)
  }

  /** 修改选中片段的类别 */
  setSelectedSegmentClass(classId) {
    const cloud = this.currentCloud
    if (!cloud) return 0
    this._ensureWritableLabels(cloud)
    const seg = cloud.segments.find((s) => s.id === this.selectedSegmentId)
    if (!seg) return 0
    const oldClass = seg.classId
    const indices = Int32Array.from(seg.indices)
    seg.classId = classId
    for (const i of indices) {
      if (cloud.pointSegment[i] === seg.id) cloud.pointLabels[i] = classId
    }
    this._pushAction(cloud, { kind: 'class', segId: seg.id, oldClass, indices })
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(this.getSelectedSegment())
    return seg.indices.length
  }

  /** 删除选中片段（其点回到未标注） */
  deleteSelectedSegment() {
    const cloud = this.currentCloud
    if (!cloud) return 0
    this._ensureWritableLabels(cloud)
    const seg = cloud.segments.find((s) => s.id === this.selectedSegmentId)
    if (!seg) return 0
    const indices = []
    const labels = []
    for (const i of seg.indices) {
      if (cloud.pointSegment[i] === seg.id) {
        indices.push(i)
        labels.push(seg.classId)
        cloud.pointLabels[i] = -1
        cloud.pointSegment[i] = -1
      }
    }
    cloud.segments = cloud.segments.filter((s) => s.id !== seg.id)
    this._pushAction(cloud, {
      kind: 'delete',
      segment: { id: seg.id, classId: seg.classId, indices: Int32Array.from(seg.indices) },
      indices: Int32Array.from(indices),
      labels: Int32Array.from(labels),
    })
    this.selectedSegmentId = null
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(null)
    return indices.length
  }

  /** 撤销上一步标签操作（操作级差分，不保存整帧快照） */
  undoLabel() {
    const cloud = this.currentCloud
    if (!cloud || !cloud.labelHistory || !cloud.labelHistory.length) return false
    this._ensureWritableLabels(cloud)
    const action = cloud.labelHistory.pop()
    if (!action) return false
    if (action.kind === 'commit') {
      cloud.segments = cloud.segments.filter((s) => s.id !== action.segId)
      for (let k = 0; k < action.indices.length; k++) {
        const i = action.indices[k]
        cloud.pointLabels[i] = action.oldLabels[k]
        cloud.pointSegment[i] = action.oldSegments[k]
      }
      if (this.selectedSegmentId === action.segId) this.selectedSegmentId = null
    } else if (action.kind === 'class') {
      const seg = cloud.segments.find((s) => s.id === action.segId)
      if (seg) {
        seg.classId = action.oldClass
        for (const i of action.indices) {
          if (cloud.pointSegment[i] === seg.id) cloud.pointLabels[i] = action.oldClass
        }
      }
    } else if (action.kind === 'delete') {
      if (!cloud.segments.some((s) => s.id === action.segment.id)) {
        cloud.segments.push({
          id: action.segment.id,
          classId: action.segment.classId,
          indices: Int32Array.from(action.segment.indices),
        })
      }
      for (let k = 0; k < action.indices.length; k++) {
        const i = action.indices[k]
        cloud.pointLabels[i] = action.labels[k]
        cloud.pointSegment[i] = action.segment.id
      }
    } else if (action.kind === 'clear') {
      cloud.pointLabels = Int32Array.from(action.labels)
      cloud.pointSegment = Int32Array.from(action.pointSegment)
      cloud.segments = (action.segments || []).map((s) => ({
        id: s.id,
        classId: s.classId,
        indices: Int32Array.from(s.indices),
      }))
      this.selectedSegmentId = null
    }
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(this.getSelectedSegment())
    return true
  }

  /** 清空当前帧全部点标签（可撤销） */
  clearLabels() {
    const cloud = this.currentCloud
    if (!cloud || !cloud.pointSegment) return
    this._ensureWritableLabels(cloud)
    this._pushAction(cloud, {
      kind: 'clear',
      labels: Int32Array.from(cloud.pointLabels),
      pointSegment: Int32Array.from(cloud.pointSegment),
      segments: (cloud.segments || []).map((s) => ({
        id: s.id,
        classId: s.classId,
        indices: Int32Array.from(s.indices),
      })),
    })
    cloud.pointLabels = new Int32Array(cloud.pointCount).fill(-1)
    cloud.pointSegment = new Int32Array(cloud.pointCount).fill(-1)
    cloud.segments = []
    this.selectedSegmentId = null
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(null)
  }

  /** 统计各类别已标注点数：Map<classId, count> */
  labelStats() {
    const cloud = this.currentCloud
    const stats = new Map()
    if (!cloud || !cloud.pointLabels) return stats
    for (let i = 0; i < cloud.pointLabels.length; i++) {
      const id = cloud.pointLabels[i]
      if (id < 0) continue
      stats.set(id, (stats.get(id) || 0) + 1)
    }
    return stats
  }

  /** 导出当前帧点标签（未标注为 -1）；附带片段信息便于后续编辑 */
  exportCurrentLabels() {
    const cloud = this.currentCloud
    if (!cloud) return null
    const labels = cloud.pointLabels ? Array.from(cloud.pointLabels) : new Array(cloud.pointCount).fill(-1)
    const segments = (cloud.segments || []).map((s) => ({ classId: s.classId, indices: Array.from(s.indices) }))
    return { pointCount: cloud.pointCount, labels, segments }
  }

  /** 释放所有 GPU 资源与事件监听 */
  dispose() {
    this.running = false
    this.clearPrefetch()
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.removeEventListener('pointerup', this._onPointerUp)
    this.renderer.domElement.removeEventListener('dblclick', this._onDoubleClick)
    this.transform.dispose()
    this.controls.dispose()
    for (const box of this.boxes.values()) box.dispose()
    this.boxes.clear()
    for (const mark of this.marks.values()) mark.dispose()
    this.marks.clear()
    for (const h of this.vertexHandles) h.material.dispose()
    this.vertexHandles = []
    this.vertexGeo.dispose()
    if (this._drawPreview) disposeObject(this._drawPreview)
    this.labelsByKey.clear()
    this.pointLabelTemplates.clear()
    this.pointLabelFiles.clear()
    this.pointLabelFailed.clear()
    this.scaleHandleGeo.dispose()
    for (const h of this.scaleHandles) h.material.dispose()
    if (this.pointGeometry) this.pointGeometry.dispose()
    this.pointMaterial.dispose()
    this.grid.geometry.dispose()
    this.grid.material.dispose()
    this._clearCommentLabels()
    if (this.labelRenderer?.domElement?.parentNode) {
      this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement)
    }
    this.labelRenderer = null
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }
}

/** 递归释放一个 Object3D 子树中的几何体与材质 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function toIdSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value)
  return new Set(value ? [value] : [])
}

function disposeObject(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose()
    if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose())
    else if (node.material) node.material.dispose()
  })
}

/** 射线法判断点是否在多边形内（套索选择用） */
function pointInPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

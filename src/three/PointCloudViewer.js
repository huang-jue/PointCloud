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
import { BBox3D } from './helpers/BBox3D.js'
import { loadPointCloud } from './loaders/index.js'
import { intensityToColor, heightToColor, labelsToColor } from './helpers/PointColorizer.js'

/** 帧级点云缓存上限（超出后按 LRU 淘汰） */
const MAX_CACHE = 8

/** 标签数据缓存上限（点云被淘汰后标签仍保留，避免切帧丢失标注） */
const MAX_LABEL_FRAMES = 16

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.appendChild(this.renderer.domElement)

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

    /* ---------- 编辑手柄（平移/旋转/缩放） ---------- */
    this.transform = new TransformControls(this.camera, this.renderer.domElement)
    this.transform.setSize(0.9)
    this._draggingGizmo = false // 正在拖动编辑手柄
    // 拖动手柄时禁用轨道控制器，避免相机与框一起动
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value
      this._draggingGizmo = e.value
      if (!e.value && this.gizmoObjectId && this.boxes.has(this.gizmoObjectId)) {
        // 松手：把最终变换回传（期间不回写，避免与手柄相互覆盖）
        this.callbacks.onBoxChange?.(this.gizmoObjectId, this.boxes.get(this.gizmoObjectId).readTransform())
      }
    })
    // 手柄变换后把新的位姿回传给上层（写回 store）
    this.transform.addEventListener('objectChange', () => {
      if (this.gizmoObjectId && this.boxes.has(this.gizmoObjectId)) {
        const box = this.boxes.get(this.gizmoObjectId)
        this.callbacks.onBoxChange?.(this.gizmoObjectId, box.readTransform())
      }
    })
    this.scene.add(this.transform.getHelper())
    this.gizmoObjectId = null

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
    this.labelsByKey = new Map() // 按帧缓存键保存点级标签，独立于点云 LRU 缓存
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

    /* ---------- 事件绑定 ---------- */
    this._onResize = this._onResize.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._animate = this._animate.bind(this)

    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.addEventListener('pointerup', this._onPointerUp)

    this.resizeObserver = new ResizeObserver(this._onResize)
    this.resizeObserver.observe(container)
    this._onResize()

    this.running = true
    this.renderer.setAnimationLoop(this._animate)
  }

  /** 渲染循环 */
  _animate() {
    this.controls.update() // damping 需要每帧 update
    this.renderer.render(this.scene, this.camera)
  }

  /** 容器尺寸变化时同步相机宽高比与渲染器大小 */
  _onResize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
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

  /** 指针按下：优先抓取缩放手柄；分割模式下左键开始框选；否则记录起点用于区分点击/拖动 */
  _onPointerDown(event) {
    this._down = { x: event.clientX, y: event.clientY, t: performance.now() }
    // 缩放工具：命中手柄则开始拖动缩放
    if (this.activeTool === 'scale' && !this.segEnabled && event.button === 0) {
      const idx = this._pickScaleHandle(event)
      if (idx !== -1) {
        this._startScale(idx)
        return
      }
    }
    if (this.segEnabled && event.button === 0 && this.transform.axis === null && this.currentCloud) {
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

  /** 指针移动：优先处理缩放拖动，其次更新分割框选图形 */
  _onPointerMove(event) {
    if (this._scaleState) {
      this._updateScale(event)
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
    // 标签模式下单击优先拾取语义标签
    if (this.segEnabled || this.colorMode === 'label') {
      this.selectSegmentAt(event)
      return
    }
    this._updatePointer(event)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.boxRoot.children, true)
    for (const hit of hits) {
      const pick = hit.object.userData.pick
      if (pick && pick.kind === 'box') {
        this.callbacks.onSelect?.(pick.ref.objectId)
        return
      }
    }
    this.callbacks.onSelect?.(null)
  }

  /* ---------------- 点云加载 / 显示 ---------------- */

  /** 计算帧的缓存键：URL 帧用 URL，本地文件用「名字:大小:修改时间」 */
  cacheKeyFor(frame) {
    if (frame.source.url) return frame.source.url
    const f = frame.source.file
    return `${frame.name}:${f ? f.size : 0}:${f ? f.lastModified : 0}`
  }

  /** 取帧点云（命中缓存则提升为最近使用，否则加载并写入 LRU 缓存） */
  async getCloud(frame) {
    const key = this.cacheKeyFor(frame)
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)
      this.cache.delete(key)
      this.cache.set(key, entry)
      return entry
    }
    const cloud = await loadPointCloud(frame.source)
    cloud.key = key
    this._attachSavedLabels(cloud)
    this.cache.set(key, cloud)
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value
      this.cache.delete(oldest)
    }
    return cloud
  }

  /** 显示某一帧（加载 + 构建几何体） */
  async showFrame(frame) {
    const cloud = await this.getCloud(frame)
    this.setCloud(cloud)
    frame.pointCount = cloud.pointCount
    return cloud
  }

  /** 用点云数据构建 BufferGeometry 并替换当前显示对象 */
  setCloud(cloud) {
    this.currentCloud = cloud
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    // baseColors 保存「真实颜色」，renderColors 是叠加选中高亮后的渲染颜色
    this.baseColors = Float32Array.from(this._computeColors(cloud))
    this.renderColors = Float32Array.from(this.baseColors)
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

    // 切换帧后清空上一次的选中
    this.selectionMask = null
    this.selectionCount = 0
    this.selectedSegmentId = null
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
    const mask = this.selectionMask
    const cloud = this.currentCloud
    const segId = this.selectedSegmentId
    const pointSeg = segId != null ? cloud?.pointSegment : null
    const n = base.length / 3
    for (let i = 0; i < n; i++) {
      const j = i * 3
      if (mask && mask[i]) {
        // 待提交的选中点：黄色
        out[j] = 1
        out[j + 1] = 0.92
        out[j + 2] = 0.25
      } else if (pointSeg && pointSeg[i] === segId) {
        // 被选中用于编辑的标签片段：白色描亮
        out[j] = 1
        out[j + 1] = 1
        out[j + 2] = 1
      } else {
        out[j] = base[j]
        out[j + 1] = base[j + 1]
        out[j + 2] = base[j + 2]
      }
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
  syncBoxes(objects, classes, selectedId) {
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
        box.setSelected(obj.id === selectedId)
        continue
      }
      box.apply(obj, colorOf(obj.classId))
      box.setSelected(obj.id === selectedId)
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

  /** 绑定/解绑编辑手柄：平移/旋转用 TransformControls，缩放用自定义手柄 */
  attachGizmo(objectId) {
    this.gizmoObjectId = objectId
    const usable =
      objectId && this.boxes.has(objectId) && this.activeTool !== 'select' && this.activeTool !== 'scale'
    if (usable) this.transform.attach(this.boxes.get(objectId).group)
    else this.transform.detach()
    this._refreshScaleHandles()
  }

  /** 切换工具：平移/旋转 -> TransformControls；缩放 -> 自定义面手柄 */
  setGizmoMode(mode) {
    if (!['select', 'translate', 'rotate', 'scale'].includes(mode)) return
    this.activeTool = mode
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

  /** 把轨道控制器焦点移动到某个对象 */
  focusObject(obj) {
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
    this.segEnabled = !!enabled
    this.controls.mouseButtons = this.segEnabled ? { ...MOUSE_SEGMENT } : { ...MOUSE_DEFAULT }
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
      this.selectionCount = 0
    }
    return this.selectionMask
  }

  /** 掩码变化后：重算选中数、刷新高亮颜色、通知上层 */
  _afterMaskChange() {
    let count = 0
    const mask = this.selectionMask
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++
    this.selectionCount = count
    this._paintColors()
    this.callbacks.onSelection?.(count)
  }

  /** 世界坐标 -> 屏幕像素坐标（并返回 NDC 深度 z 用于裁剪判断） */
  _projectToScreen(pos, i, W, H) {
    const v = this._projector
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(this.camera)
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z }
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
      if (p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy) mask[i] = 1
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
      if (dx * dx + dy * dy <= r2) mask[i] = 1
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
      if (pointInPolygon(p.x, p.y, points)) mask[i] = 1
    }
    this._afterMaskChange()
  }

  /** 清空待提交的选中（不影响已生成的标签） */
  clearSelection() {
    this.selectionMask = null
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

  /**
   * 把已保存的标签挂到新加载的点云上（点云缓存被淘汰后重新加载也能恢复标注）
   */
  _attachSavedLabels(cloud) {
    const saved = this.labelsByKey.get(cloud.key)
    cloud.pointLabels = saved ? saved.pointLabels : null
    cloud.pointSegment = saved ? saved.pointSegment : null
    cloud.segments = saved ? saved.segments : null
    cloud.labelHistory = saved ? saved.labelHistory : null
  }

  /** 把当前标签写回按帧保存的缓存（引用共享，LRU 淘汰点云后标签仍在） */
  _persistLabels(cloud = this.currentCloud) {
    if (!cloud || !cloud.key) return
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

  /** 记录一次可撤销快照 */
  _pushHistory() {
    const cloud = this.currentCloud
    if (!cloud) return
    this._ensureSegmentStructures(cloud)
    cloud.labelHistory.push({
      labels: cloud.pointLabels.slice(),
      pointSegment: cloud.pointSegment.slice(),
      segments: cloud.segments.map((s) => ({ id: s.id, classId: s.classId, indices: s.indices })),
    })
    if (cloud.labelHistory.length > 30) cloud.labelHistory.shift()
  }

  /**
   * 把待提交掩码中的点提交为一个新标签片段，返回实际标记的点数。
   * `segOverwrite=false` 时跳过已有标签的点（不覆盖）。
   */
  _commitLabelToMask(classId) {
    const cloud = this.currentCloud
    const mask = this.selectionMask
    if (!cloud || !mask) return 0
    this._ensureSegmentStructures(cloud)
    const indices = []
    const skipExisting = !this.segOverwrite
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      // 不覆盖模式：已经标注过的点保持原标签
      if (skipExisting && cloud.pointLabels[i] >= 0) continue
      indices.push(i)
    }
    if (!indices.length) return 0
    this._pushHistory()
    const id = ++this.segmentSeq
    cloud.segments.push({ id, classId, indices: Int32Array.from(indices) })
    for (const i of indices) {
      cloud.pointLabels[i] = classId
      cloud.pointSegment[i] = id
    }
    // 自动切到标签着色，使点显示为类别颜色
    this.colorMode = 'label'
    this.refreshColors()
    this._persistLabels(cloud)
    return indices.length
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
    const seg = cloud?.segments?.find((s) => s.id === this.selectedSegmentId)
    if (!seg) return 0
    this._pushHistory()
    seg.classId = classId
    for (const i of seg.indices) {
      if (cloud.pointSegment[i] === seg.id) cloud.pointLabels[i] = classId
    }
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(this.getSelectedSegment())
    return seg.indices.length
  }

  /** 删除选中片段（其点回到未标注） */
  deleteSelectedSegment() {
    const cloud = this.currentCloud
    const seg = cloud?.segments?.find((s) => s.id === this.selectedSegmentId)
    if (!seg) return 0
    this._pushHistory()
    let count = 0
    for (const i of seg.indices) {
      if (cloud.pointSegment[i] === seg.id) {
        cloud.pointLabels[i] = -1
        cloud.pointSegment[i] = -1
        count++
      }
    }
    cloud.segments = cloud.segments.filter((s) => s.id !== seg.id)
    this.selectedSegmentId = null
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(null)
    return count
  }

  /** 从快照恢复标签数据 */
  _restoreSnapshot(snap) {
    const cloud = this.currentCloud
    if (!cloud || !snap) return
    cloud.pointLabels = snap.labels ? snap.labels.slice() : new Int32Array(cloud.pointCount).fill(-1)
    cloud.pointSegment = snap.pointSegment
      ? snap.pointSegment.slice()
      : new Int32Array(cloud.pointCount).fill(-1)
    cloud.segments = (snap.segments || []).map((s) => ({ ...s }))
    this.selectedSegmentId = null
    this.refreshColors()
    this._persistLabels(cloud)
    this.callbacks.onSegmentSelect?.(null)
  }

  /** 撤销上一步标签操作 */
  undoLabel() {
    const cloud = this.currentCloud
    if (!cloud || !cloud.labelHistory || !cloud.labelHistory.length) return false
    this._restoreSnapshot(cloud.labelHistory.pop())
    return true
  }

  /** 清空当前帧全部点标签（可撤销） */
  clearLabels() {
    const cloud = this.currentCloud
    if (!cloud || !cloud.pointSegment) return
    this._pushHistory()
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
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.removeEventListener('pointerup', this._onPointerUp)
    this.transform.dispose()
    this.controls.dispose()
    for (const box of this.boxes.values()) box.dispose()
    this.boxes.clear()
    this.labelsByKey.clear()
    this.scaleHandleGeo.dispose()
    for (const h of this.scaleHandles) h.material.dispose()
    if (this.pointGeometry) this.pointGeometry.dispose()
    this.pointMaterial.dispose()
    this.grid.geometry.dispose()
    this.grid.material.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }
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

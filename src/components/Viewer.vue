<script setup>
/**
 * Viewer —— 3D 视口组件
 * 负责：创建/销毁 PointCloudViewer 实例，把 store 的状态变化同步到 three 视口，
 * 并把视口回调（选中、gizmo 变更、框选图形、选中点数）写回 store。
 * 另外用一个 2D 覆盖层 canvas 绘制分割框选时的矩形/套索。
 */
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { PointCloudViewer } from '../three/PointCloudViewer.js'
import { viewerRef } from '../three/viewerRef.js'
import {
  state,
  currentFrame,
  currentObjects,
  selectedObject,
  selectObject,
  updateObject,
  loadLocalFiles,
} from '../stores/useAnnotationStore.js'

const viewportEl = ref(null)
const sketchEl = ref(null) // 分割框选的可视化覆盖层（不接收鼠标事件）
const dragging = ref(false)

let viewer = null
let loadToken = 0 // 用于丢弃过期的异步加载结果（快速切帧时）
let fitPending = true // 新数据集加载后是否需要自动适应视角
let currentSketch = null

/** 把当前帧对象同步到视口，并刷新编辑手柄 */
function syncBoxes() {
  if (!viewer) return
  viewer.syncBoxes(currentObjects.value, state.classes, state.selectedObjectId)
  applyGizmo()
}

/** 仅当选中对象且工具为变换类时才挂载手柄 */
function applyGizmo() {
  if (!viewer) return
  const transformTools = ['translate', 'rotate', 'scale']
  const obj = selectedObject.value
  if (obj && transformTools.includes(state.tool)) viewer.attachGizmo(obj.id)
  else viewer.attachGizmo(null)
}

/** 加载并显示当前帧点云 */
async function loadCurrent() {
  const frame = currentFrame.value
  if (!viewer) return
  if (!frame) {
    // 无数据：清空点云显示
    if (viewer.pointObject) {
      viewer.scene.remove(viewer.pointObject)
      viewer.pointObject = null
      viewer.pointGeometry = null
      viewer.currentCloud = null
    }
    return
  }
  const token = ++loadToken
  state.loading = true
  state.error = ''
  try {
    // 先把着色模式设好，showFrame 构建几何体时即可直接按该模式着色（避免加载后再全量重算一次）
    viewer.presetColorMode(state.colorMode)
    await viewer.showFrame(frame)
    if (token !== loadToken) return // 已有更新的加载请求，丢弃本次
    viewer.setPointSize(state.pointSize)
    if (fitPending) {
      // 数据集自带相机则用它，否则按包围球自适应
      if (state.camera) viewer.setView(state.camera.position, state.camera.target)
      else viewer.fitView()
      fitPending = false
    }
    syncBoxes()
  } catch (err) {
    if (token === loadToken) state.error = err?.message || String(err)
  } finally {
    if (token === loadToken) state.loading = false
  }
}

/** 在覆盖层上绘制分割框选图形（矩形/套索） */
function drawSketch() {
  const canvas = sketchEl.value
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const s = currentSketch
  if (!s) return
  ctx.strokeStyle = '#ffd166'
  ctx.lineWidth = 1.5
  ctx.fillStyle = 'rgba(255, 209, 102, 0.14)'
  if (s.mode === 'rect') {
    const x = Math.min(s.x0, s.x1)
    const y = Math.min(s.y0, s.y1)
    const rw = Math.abs(s.x1 - s.x0)
    const rh = Math.abs(s.y1 - s.y0)
    ctx.fillRect(x, y, rw, rh)
    ctx.strokeRect(x, y, rw, rh)
  } else if (s.mode === 'lasso' && s.points.length > 1) {
    ctx.beginPath()
    ctx.moveTo(s.points[0][0], s.points[0][1])
    for (const [px, py] of s.points) ctx.lineTo(px, py)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

/** 视口回调：框选图形变化时重绘覆盖层 */
function onSketch(sketch) {
  currentSketch = sketch
  drawSketch()
}

/** 拖拽文件到视口加载点云 */
function onDrop(event) {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
    /\.(pcd|ply|bin|las|laz|xyz|csv|txt)$/i.test(f.name),
  )
  if (!files.length) {
    state.error = '未识别到支持的点云文件'
    return
  }
  fitPending = true
  loadLocalFiles(files)
}

onMounted(() => {
  viewer = new PointCloudViewer(viewportEl.value, {
    onSelect: (id) => selectObject(id), // 视口点选 3D 框
    onBoxChange: (id, transform) => updateObject(id, transform), // gizmo 拖动回写
    onSketch,
    onSelection: (count) => {
      state.selectionCount = count
    },
    // 松手自动赋标签后：记录本次结果、切到标签着色并通知面板刷新
    onLabelApplied: (classId, count) => {
      state.lastLabel = { classId, count }
      // 必须同步到全局着色模式，否则切走再切回该帧会退回「强度」着色，看不到标签
      state.colorMode = 'label'
      state.labelVersion++
    },
    // 点击选中/取消选中标签片段（用于编辑）
    onSegmentSelect: (segment) => {
      state.selectedSegment = segment
      if (segment) state.colorMode = 'label'
    },
    getClasses: () => state.classes, // 供标签着色使用
    getActiveClassId: () => state.activeClassId, // 自动赋标签所用类别
  })
  viewerRef.current = viewer
  loadCurrent()
})

/* ---- store -> 视口 的同步 ---- */
watch(() => state.currentIndex, loadCurrent)

watch(
  // 数据集切换（名称或帧数变化）后需要重新适应视角
  () => state.datasetName + '#' + state.frames.length,
  () => {
    fitPending = true
    loadCurrent()
  },
)

watch(
  // 对象增删改（含 gizmo 拖动）后同步框
  () => currentObjects.value,
  () => syncBoxes(),
  { deep: true },
)

watch(
  () => [state.selectedObjectId, state.tool],
  () => {
    if (viewer) viewer.setGizmoMode(state.tool)
    applyGizmo()
  },
)

watch(() => state.colorMode, (mode) => viewer?.setColorMode(mode))
watch(() => state.pointSize, (size) => viewer?.setPointSize(size))
watch(() => state.backgroundColor, (color) => viewer?.setBackground(color))
watch(() => state.segEnabled, (on) => viewer?.setSegEnabled(on))
watch(() => state.segMode, (mode) => viewer?.setSegMode(mode))
watch(() => state.segOverwrite, (v) => viewer?.setSegOverwrite(v))
watch(() => state.brushSize, (size) => viewer?.setBrushSize(size))

// 切帧/换数据集后清空覆盖层
watch(
  () => [state.datasetName, state.frames.length, state.currentIndex],
  () => nextTick(drawSketch),
)

onBeforeUnmount(() => {
  viewer?.dispose()
  viewerRef.current = null
  viewer = null
})
</script>

<template>
  <div
    ref="viewportEl"
    class="viewport"
    v-loading="state.loading"
    element-loading-text="加载点云…"
    element-loading-background="rgba(13, 17, 23, 0.55)"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- 分割框选可视化层：pointer-events 由样式置为 none，不拦截视口交互 -->
    <canvas ref="sketchEl" class="sketch"></canvas>
    <div v-if="!state.loading && !state.frames.length" class="overlay">
      <div class="badge">拖入 .pcd / .ply / .bin / .las 文件，或从工具栏加载示例数据</div>
    </div>
    <div v-if="dragging" class="drop-target">松开以加载点云</div>
  </div>
</template>

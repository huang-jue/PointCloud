<script setup>
/**
 * Viewer —— 3D 视口组件
 * 负责：创建/销毁 PointCloudViewer 实例，把 store 的状态变化同步到 three 视口，
 * 并把视口回调（选中、gizmo 变更、框选图形、选中点数）写回 store。
 * 另外用一个 2D 覆盖层 canvas 绘制分割框选时的矩形/套索。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { PointCloudViewer } from '../three/PointCloudViewer.js'
import { viewerRef } from '../three/viewerRef.js'
import { canEditCurrentFrame, reviewState } from '../stores/useReviewStore.js'
import { flushDrafts } from '../stores/useDraftStore.js'
import {
  state,
  currentFrame,
  currentObjects,
  selectedObject,
  selectedObjects,
  selectObject,
  updateObject,
  translateObjects,
  rotatePolyline,
  markingCentroid,
  loadLocalFiles,
  addPolyline,
  setPolylinePoint,
  deletePolylinePoint,
  setTool,
  markFrameEdited,
} from '../stores/useAnnotationStore.js'

const viewportEl = ref(null)
const sketchEl = ref(null) // 分割框选的可视化覆盖层（不接收鼠标事件）
const dragging = ref(false)
const perfEnabled = new URLSearchParams(location.search).has('perf')
const perfText = ref('')
let perfTimer = null

/** 没有关联到具体对象的帧级批注，在视口右上角显示最新一条 */
const frameOnlyComments = computed(() =>
  reviewState.comments.filter(
    (c) => c.frameIndex === state.currentIndex && !c.objectId && !c.resolved,
  ),
)
const frameCommentLatest = computed(() => frameOnlyComments.value[frameOnlyComments.value.length - 1] || null)

let viewer = null
let loadToken = 0 // 用于丢弃过期的异步加载结果（快速切帧时）
let loadAbort = null // 取消上一次尚未完成的帧请求
let loadKey = null // 当前正在加载的帧缓存键（避免同帧重复加载被自己取消）
let fitPending = true // 新数据集加载后是否需要自动适应视角
let currentSketch = null
let loadingTimer = null
let syncRaf = 0
let lastDataset = ''

/** 开始加载：延迟 150ms 再显示遮罩，避免缓存命中时闪烁 */
function beginLoading(token) {
  if (loadingTimer) clearTimeout(loadingTimer)
  loadingTimer = setTimeout(() => {
    loadingTimer = null
    if (token === loadToken && state.loading) state.loadingVisible = true
  }, 150)
}

/** 结束加载：点云一上屏就调用，不等待标注同步 */
function finishLoading() {
  if (loadingTimer) {
    clearTimeout(loadingTimer)
    loadingTimer = null
  }
  state.loading = false
  state.loadingVisible = false
}

/** 合并多次同步请求，避免切帧/GT 导入时同一 tick 全量同步多次 */
function scheduleSyncBoxes() {
  if (!viewer || state.loading || syncRaf) return
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0
    syncBoxes()
  })
}

/** 把当前帧对象（3D 框 + 标线）同步到视口，并刷新编辑手柄 */
function syncBoxes() {
  if (!viewer) return
  const boxObjects = currentObjects.value.filter((o) => o.shape !== 'line' && o.shape !== 'arrow')
  viewer.syncBoxes(boxObjects, state.classes, state.selectedObjectIds)
  viewer.syncMarks(currentObjects.value, state.classes, state.selectedObjectIds)
  applyGizmo()
  // 对象位置/数量变化后同步批注气泡（已解决的批注不再显示）
  viewer.syncCommentLabels(
    reviewState.comments.filter((c) => !c.resolved),
    currentObjects.value,
    state.currentIndex,
  )
}

/** 把绘制选项同步到视口 */
function applyDrawOptions() {
  if (!viewer) return
  viewer.setDrawOptions({
    width: state.tool === 'arrow' ? state.arrowWidth : state.lineWidth,
    template: state.arrowTemplate,
    heading: state.drawHeading,
    groundZ: -state.sensorHeight,
  })
}

/** 绘制完成 → 生成标线对象 */
function onDrawFinish(draft) {
  addPolyline(
    {
      ...draft,
      classId: state.activeClassId,
    },
    { propagate: state.multiFrame },
  )
  state.draftCount = 0
}

/** 仅当选中对象且工具为变换类时才挂载手柄 */
function applyGizmo() {
  if (!viewer) return
  if (!canEditCurrentFrame.value) {
    viewer.attachGizmo(null)
    return
  }
  const objects = selectedObjects.value
  if (objects.length > 1) {
    // 多选只支持整体平移；旋转/缩放请单个编辑
    if (state.tool === 'translate') viewer.attachGroupGizmo(objects.map((o) => o.id))
    else viewer.attachGizmo(null)
    return
  }
  const transformTools = ['translate', 'rotate', 'scale']
  const obj = selectedObject.value
  const isMark = obj?.shape === 'line' || obj?.shape === 'arrow'
  // 单条线/箭头：移动/旋转工具显示整体手柄（顶点手柄仍可单独拖拽）
  if (obj && isMark && (state.tool === 'translate' || state.tool === 'rotate')) {
    viewer.attachGroupGizmo([obj.id], state.tool, markingCentroid(obj))
    return
  }
  if (obj && !isMark && transformTools.includes(state.tool)) viewer.attachGizmo(obj.id)
  else viewer.attachGizmo(null)
}

/** 加载并显示当前帧点云 */
async function loadCurrent() {
  const frame = currentFrame.value
  if (!viewer) return
  if (!frame) {
    // 无数据：清空点云显示并终止进行中的加载
    loadToken++
    loadAbort?.abort()
    loadAbort = null
    loadKey = null
    finishLoading()
    if (viewer.pointObject) {
      viewer.scene.remove(viewer.pointObject)
      viewer.pointGeometry?.dispose()
      viewer.pointObject = null
      viewer.pointGeometry = null
      viewer.currentCloud = null
      viewer.currentKey = null
    }
    return
  }
  const key = viewer.cacheKeyFor(frame)
  // 数据加载完成时 currentIndex/dataset 两个 watcher 可能同时触发；同帧只保留一个请求
  if (state.loading && loadKey === key) return
  if (loadKey !== key) {
    loadAbort?.abort()
    viewer.clearPrefetch() // 切帧时丢弃旧预取，避免后台任务影响当前帧
  }
  loadKey = key
  const token = ++loadToken
  const controller = new AbortController()
  loadAbort = controller
  state.loading = true
  state.error = ''
  beginLoading(token)
  try {
    // 先把着色模式设好，showFrame 构建几何体时即可直接按该模式着色（避免加载后再全量重算一次）
    viewer.presetColorMode(state.colorMode)
    await viewer.showFrame(frame, { signal: controller.signal })
    if (token !== loadToken) return // 已有更新的加载请求，丢弃本次
    // 点云已经可见：先结束“加载点云”，标注同步在遮罩外完成
    finishLoading()
    viewer.setPointSize(state.pointSize)
    if (fitPending) {
      // 数据集自带相机则用它，否则按包围球自适应
      if (state.camera) viewer.setView(state.camera.position, state.camera.target)
      else viewer.fitView()
      fitPending = false
    }
    syncBoxes()
    viewer.prefetchFrames(state.frames, state.currentIndex)
  } catch (err) {
    if (token === loadToken && !err?.canceled) state.error = err?.message || String(err)
  } finally {
    if (token === loadToken) finishLoading()
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
async function onDrop(event) {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
    /\.(pcd|ply|bin|las|laz|xyz|csv|txt)$/i.test(f.name),
  )
  if (!files.length) {
    state.error = '未识别到支持的点云文件'
    return
  }
  await flushDrafts().catch(() => {})
  fitPending = true
  loadLocalFiles(files)
}

onMounted(() => {
  viewer = new PointCloudViewer(viewportEl.value, {
    onSelect: (id, options) => selectObject(id, options), // 视口点选 3D 框（支持 Ctrl 多选）
    onBoxChange: (id, transform) => updateObject(id, transform), // gizmo 拖动回写
    onGroupCommit: (ids, delta) => {
      translateObjects(ids, delta)
      syncBoxes()
    },
    onGroupRotate: (id, angle) => {
      rotatePolyline(id, angle)
      syncBoxes()
    },
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
    // 点标签后台加载完成后刷新分割统计
    onLabelsLoaded: () => {
      state.labelVersion++
    },
    // 任何点标签编辑都进入草稿自动保存
    onLabelsChanged: () => {
      markFrameEdited()
    },
    getClasses: () => state.classes, // 供标签着色使用
    getActiveClassId: () => state.activeClassId, // 自动赋标签所用类别
    // 标线绘制
    onDrawFinish,
    onDrawChange: (count) => {
      state.draftCount = count
    },
    onVertexChange: (objId, index, point, pathIndex) => {
      setPolylinePoint(objId, index, point, pathIndex)
      // 拖动过程中也实时刷新标线几何（顶点手柄保持不重建）
      scheduleSyncBoxes()
    },
    onVertexDelete: (objId, index, pathIndex) => {
      deletePolylinePoint(objId, index, pathIndex)
    },
    onMeasure: (info) => {
      if (!info) {
        state.measureText = ''
      } else if (info.pending) {
        state.measureText = '已选第一个点，请点击第二个点'
      } else {
        state.measureText = `距离 ${info.distance.toFixed(2)}m · 水平 ${info.horizontal.toFixed(2)}m · 高差 ${info.height.toFixed(2)}m`
      }
    },
  })
  viewerRef.current = viewer
  viewer.setReadOnly(!canEditCurrentFrame.value)
  viewer.setMeasureEnabled(state.measureEnabled)
  viewer.setSnapEnabled(state.snapToPoints)
  if (perfEnabled) {
    perfTimer = setInterval(() => {
      const p = viewer?.getPerfStats?.()
      if (!p) return
      perfText.value = `${p.fps} FPS · ${p.frameMs}ms · draw ${p.calls} · ${(p.points / 1000).toFixed(0)}k pts`
    }, 500)
  }
  loadCurrent()
})

/* ---- store -> 视口 的同步 ---- */
watch(() => state.currentIndex, loadCurrent)

watch(
  // 数据集切换（名称或帧数变化）后需要重新适应视角
  () => state.datasetName + '#' + state.frames.length,
  () => {
    if (state.datasetName !== lastDataset) {
      lastDataset = state.datasetName
      // 旧数据集的点云/标签缓存不再需要，释放内存与 LRU 名额
      viewer?.clearCache()
    }
    fitPending = true
    viewer?.clearPrefetch()
    loadCurrent()
  },
)

watch(
  // 对象增删改（含 gizmo 拖动）后同步框；rAF 合并，且加载点云期间跳过
  () => currentObjects.value,
  () => scheduleSyncBoxes(),
  { deep: true },
)

watch(
  () => [state.selectedObjectIds.join('|'), state.selectedObjectId, state.tool],
  () => {
    if (!viewer) return
    viewer.setGizmoMode(state.tool)
    viewer.setDrawMode(state.tool === 'line' || state.tool === 'arrow' ? state.tool : null)
    applyDrawOptions()
    // 选中变化也要刷新标线顶点手柄（syncBoxes 内部会调用 applyGizmo）
    scheduleSyncBoxes()
  },
)

watch(canEditCurrentFrame, (allowed) => {
  viewer?.setReadOnly(!allowed)
  if (!allowed) {
    viewer?.setDrawMode(null)
    viewer?.setSegEnabled(false)
  }
  syncBoxes()
})
watch(
  () => reviewState.comments,
  () => {
    viewer?.syncCommentLabels(
      reviewState.comments.filter((c) => !c.resolved),
      currentObjects.value,
      state.currentIndex,
    )
  },
  { deep: true },
)
watch(() => state.colorMode, (mode) => viewer?.setColorMode(mode))
watch(() => state.pointSize, (size) => viewer?.setPointSize(size))
watch(() => state.backgroundColor, (color) => viewer?.setBackground(color))
watch(
  () => [state.lineWidth, state.arrowWidth, state.arrowTemplate, state.drawHeading, state.sensorHeight, state.tool],
  () => applyDrawOptions(),
)
watch(() => state.segEnabled, (on) => {
  // 分割与标线绘制/测量互斥：开启分割时退出绘制
  if (on) {
    if (state.tool === 'line' || state.tool === 'arrow') setTool('select')
    if (state.measureEnabled) state.measureEnabled = false
  }
  viewer?.setSegEnabled(on)
})

watch(() => state.measureEnabled, (on) => {
  if (on) {
    state.segEnabled = false
    if (state.tool !== 'select') setTool('select')
  }
  viewer?.setMeasureEnabled(on)
})
watch(() => state.segMode, (mode) => viewer?.setSegMode(mode))
watch(() => state.segOverwrite, (v) => viewer?.setSegOverwrite(v))
watch(() => state.brushSize, (size) => viewer?.setBrushSize(size))
watch(() => state.snapToPoints, (on) => viewer?.setSnapEnabled(on))

// 切帧/换数据集后清空覆盖层
watch(
  () => [state.datasetName, state.frames.length, state.currentIndex],
  () => nextTick(drawSketch),
)

onBeforeUnmount(() => {
  loadToken++
  loadAbort?.abort()
  loadAbort = null
  if (loadingTimer) clearTimeout(loadingTimer)
  loadingTimer = null
  if (syncRaf) cancelAnimationFrame(syncRaf)
  syncRaf = 0
  if (perfTimer) clearInterval(perfTimer)
  perfTimer = null
  viewer?.dispose()
  viewerRef.current = null
  viewer = null
})
</script>

<template>
  <div
    ref="viewportEl"
    class="viewport"
    :class="{ 'is-drawing': state.tool === 'line' || state.tool === 'arrow' }"
    v-loading="state.loadingVisible"
    element-loading-text="加载点云…"
    element-loading-background="rgba(13, 17, 23, 0.55)"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- 分割框选可视化层：pointer-events 由样式置为 none，不拦截视口交互 -->
    <canvas ref="sketchEl" class="sketch"></canvas>
    <div v-if="perfEnabled" class="perf-overlay">{{ perfText }}</div>
    <div v-if="frameCommentLatest" class="frame-comment-badge">
      <div class="frame-comment-head">
        本帧批注 · {{ frameCommentLatest.author }}
        <span v-if="frameOnlyComments.length > 1">+{{ frameOnlyComments.length - 1 }}</span>
      </div>
      <div class="frame-comment-text">{{ frameCommentLatest.text }}</div>
    </div>
    <div v-if="!state.loadingVisible && !state.frames.length" class="overlay">
      <div class="badge">拖入 .pcd / .ply / .bin / .las 文件，或从工具栏加载示例数据</div>
    </div>
    <div v-if="dragging" class="drop-target">松开以加载点云</div>
  </div>
</template>

<script setup>
/** 2D 相机图像联动：显示当前帧合成/真实图像，并把 3D 框投影到图像上 */
import { computed, ref } from 'vue'
import { state, currentFrame, selectObject } from '../stores/useAnnotationStore.js'
import { uiState } from '../stores/useUiStore.js'
import { BOX_EDGES, buildExtrinsics, convexHull, pointInPolygon, projectBox } from '../utils/projection.js'

const open = computed({
  get: () => uiState.imageOpen,
  set: (value) => {
    uiState.imageOpen = value
  },
})

const zoomEl = ref(null)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const panning = ref(false)
let panStart = null
let suppressClick = false

function resetView() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

function onWheel(event) {
  const factor = event.deltaY < 0 ? 1.15 : 0.87
  scale.value = Math.min(8, Math.max(0.5, scale.value * factor))
}

function startPan(event) {
  if (event.button !== 0) return
  panning.value = true
  suppressClick = false
  panStart = { x: event.clientX - tx.value, y: event.clientY - ty.value, moved: false }
  window.addEventListener('pointermove', onPan)
  window.addEventListener('pointerup', endPan, { once: true })
}

function onPan(event) {
  if (!panning.value || !panStart) return
  const nextX = event.clientX - panStart.x
  const nextY = event.clientY - panStart.y
  if (Math.abs(nextX - tx.value) > 3 || Math.abs(nextY - ty.value) > 3) {
    panStart.moved = true
    suppressClick = true
  }
  tx.value = nextX
  ty.value = nextY
}

function endPan() {
  panning.value = false
  panStart = null
  window.removeEventListener('pointermove', onPan)
}

const intrinsics = computed(() => state.camera?.intrinsics || null)
const extrinsics = computed(() =>
  state.camera?.position && state.camera?.target
    ? buildExtrinsics(state.camera.position, state.camera.target)
    : null,
)

const imageUrl = computed(() => currentFrame.value?.imageUrl || '')

const projected = computed(() => {
  if (!extrinsics.value || !intrinsics.value || !currentFrame.value) return []
  return (currentFrame.value.objects || [])
    .filter((obj) => obj.shape !== 'line' && obj.shape !== 'arrow')
    .map((obj) => {
      const corners = projectBox(obj, extrinsics.value, intrinsics.value)
      if (!corners) return null
      const selected = state.selectedObjectIds.includes(obj.id)
      const hull = convexHull(corners)
      return {
        id: obj.id,
        label: obj.type || 'Object',
        selected,
        corners: hull,
        polygon: hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        edges: BOX_EDGES.map(([a, b]) => ({ x1: corners[a].x, y1: corners[a].y, x2: corners[b].x, y2: corners[b].y })),
      }
    })
    .filter(Boolean)
})

function onClick(event) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (!intrinsics.value || !zoomEl.value) return
  const rect = zoomEl.value.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * intrinsics.value.width
  const y = ((event.clientY - rect.top) / rect.height) * intrinsics.value.height
  for (let i = projected.value.length - 1; i >= 0; i--) {
    const box = projected.value[i]
    if (pointInPolygon(x, y, box.corners)) {
      selectObject(box.id)
      return
    }
  }
}
</script>

<template>
  <el-dialog v-model="open" title="2D 图像联动" width="960px" append-to-body>
    <div v-if="!currentFrame" class="hint image-empty">请先加载数据</div>
    <div v-else-if="!imageUrl" class="hint image-empty">
      当前帧没有相机图像。示例数据可运行
      <code>npm run gen:images -- --only urban</code>
      生成合成图像。
    </div>
    <div v-else-if="!intrinsics || !extrinsics" class="hint image-empty">
      当前数据集缺少相机内参/位姿，无法投影。
    </div>
    <div v-else class="image-stage" @wheel.prevent="onWheel" @mousedown="startPan">
      <div
        ref="zoomEl"
        class="image-zoom"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        @click="onClick"
      >
        <img :src="imageUrl" alt="camera frame" draggable="false" />
        <svg
          class="image-overlay"
          :viewBox="`0 0 ${intrinsics.width} ${intrinsics.height}`"
          preserveAspectRatio="none"
        >
          <g v-for="box in projected" :key="box.id">
            <polygon
              :points="box.polygon"
              :class="{ selected: box.selected }"
              class="box-fill"
            />
            <line
              v-for="(edge, i) in box.edges"
              :key="i"
              :x1="edge.x1"
              :y1="edge.y1"
              :x2="edge.x2"
              :y2="edge.y2"
              :class="{ selected: box.selected }"
              class="box-edge"
            />
          </g>
        </svg>
      </div>
      <div class="image-zoom-bar">
        <span>{{ (scale * 100).toFixed(0) }}%</span>
        <el-button link size="small" @click.stop="resetView">重置视图</el-button>
      </div>
    </div>
    <div v-if="imageUrl" class="hint image-foot">
      {{ currentFrame?.name }} · 滚轮缩放、拖拽平移；点击 2D 框可选中对应 3D 对象；3D 中选中的框会高亮。
    </div>
  </el-dialog>
</template>

<style scoped>
.image-empty {
  padding: 28px 0;
  text-align: center;
}

.image-stage {
  position: relative;
  width: 100%;
  background: #06090d;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  cursor: grab;
}

.image-stage:active {
  cursor: grabbing;
}

.image-zoom {
  position: relative;
  width: 100%;
  transform-origin: 0 0;
  will-change: transform;
}

.image-zoom-bar {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(6, 9, 13, 0.72);
  color: var(--text-dim);
  font-size: 11px;
}

.image-stage img {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
}

.image-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.box-fill {
  fill: rgba(79, 155, 255, 0.06);
  stroke: none;
}

.box-fill.selected {
  fill: rgba(255, 209, 102, 0.14);
}

.box-edge {
  stroke: rgba(79, 155, 255, 0.75);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.box-edge.selected {
  stroke: #ffd166;
  stroke-width: 2.5;
}

.image-foot {
  margin-top: 6px;
}

code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-3);
  color: var(--text);
}
</style>

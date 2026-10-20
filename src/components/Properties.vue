<script setup>
/**
 * Properties —— 右侧选中对象的属性编辑面板
 *  - 3D 框：类别 / 尺寸 l,w,h / 中心 x,y,z / 偏航 ry；多帧物体额外显示起始帧并支持同步到后续帧
 *  - 标线（line/arrow）：类别 / 线宽 / 顶点表（可编辑、删除）/ 旋转缩放
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  state,
  selectedObject,
  updateObject,
  classColor,
  syncTrackForward,
  countTrackFrames,
  isMarking,
  setPolylinePoint,
  deletePolylinePoint,
  rotatePolyline,
  scalePolyline,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { radToDeg, degToRad } from '../utils/math.js'
import { polylineLength } from '../utils/polyline.js'

const obj = selectedObject // 当前选中对象（computed ref）

/** 该 trackId 出现在多少帧 */
const trackFrames = computed(() => (obj.value?.trackId ? countTrackFrames(obj.value.trackId) : 0))

/** 偏航角以「度」展示/输入，内部存弧度 */
const ryDeg = computed({
  get: () => (obj.value ? Number(radToDeg(obj.value.ry).toFixed(1)) : 0),
  set: (v) => obj.value && updateObject(obj.value.id, { ry: degToRad(Number(v)) }),
})

const FIELDS = [
  { key: 'l', label: '长 l' },
  { key: 'w', label: '宽 w' },
  { key: 'h', label: '高 h' },
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
]

const isMark = computed(() => isMarking(obj.value))

/** 标线的路径列表（线视为单条路径） */
const markingPaths = computed(() => {
  const o = obj.value
  if (!o) return []
  if (o.shape === 'line') return [{ pathIndex: 0, points: o.points || [] }]
  return (o.paths || []).map((points, pathIndex) => ({ pathIndex, points }))
})

/** 标线总长度（所有路径相加） */
const markingLength = computed(() => {
  let total = 0
  for (const p of markingPaths.value) total += polylineLength(p.points)
  return total
})

/** 数值字段变更写回对象 */
function setField(key, value) {
  if (!obj.value || value === null || value === undefined) return
  updateObject(obj.value.id, { [key]: Number(value) })
}

function setClass(value) {
  if (obj.value) updateObject(obj.value.id, { classId: value })
}

/** 修改顶点坐标 */
function setPoint(pathIndex, index, axis, value) {
  const o = obj.value
  if (!o || value === null || value === undefined) return
  const arr = o.shape === 'line' ? o.points : o.paths?.[pathIndex]
  if (!arr || !arr[index]) return
  const point = [...arr[index]]
  point[axis] = Number(value)
  setPolylinePoint(o.id, index, point, pathIndex)
}

/** 删除顶点 */
function removePoint(pathIndex, index) {
  if (!obj.value) return
  if (!deletePolylinePoint(obj.value.id, index, pathIndex)) {
    ElMessage.warning('至少需要保留 2 个顶点')
  }
}

/** 旋转标线（度） */
function rotateMark(deg) {
  if (!obj.value) return
  rotatePolyline(obj.value.id, degToRad(deg))
}

/** 缩放标线 */
function scaleMark(factor) {
  if (!obj.value) return
  scalePolyline(obj.value.id, factor)
}

/** 视口聚焦到该对象 */
function focusMe() {
  if (obj.value) viewerRef.current?.focusObject(obj.value)
}

/** 把本帧位姿/尺寸同步到之后所有帧的同 trackId 对象 */
function syncForward() {
  if (!obj.value) return
  const n = syncTrackForward(obj.value.id)
  if (n) ElMessage.success(`已同步到之后 ${n} 帧`)
  else ElMessage.info('之后没有该物体的帧')
}
</script>

<template>
  <div class="section">
    <h3 class="section-title">
      <span>对象属性</span>
      <el-button v-if="obj" link @click="focusMe">
        <el-icon><Aim /></el-icon>
        <span style="margin-left: 4px">居中</span>
      </el-button>
    </h3>
    <el-empty v-if="!obj" :image-size="50" description="未选中对象" style="padding: 6px 0" />
    <template v-else>
      <div class="field" style="margin-bottom: 10px">
        <label>类别</label>
        <el-select :model-value="obj.classId" style="width: 100%" @change="setClass">
          <el-option v-for="c in state.classes" :key="c.id" :label="c.name" :value="c.id">
            <span class="obj-dot" :style="{ background: c.color, marginRight: '6px' }"></span>{{ c.name }}
          </el-option>
        </el-select>
      </div>

      <!-- 标线属性 -->
      <template v-if="isMark">
        <div class="grid-2">
          <div class="field">
            <label>线宽 (m)</label>
            <el-input-number
              :model-value="Number((obj.width ?? 0.15).toFixed(3))"
              :step="0.05"
              :min="0.02"
              :max="2"
              :controls="false"
              size="small"
              style="width: 100%"
              @change="(v) => setField('width', v)"
            />
          </div>
          <div class="field">
            <label>长度 (m)</label>
            <el-input :model-value="markingLength.toFixed(2)" size="small" disabled />
          </div>
        </div>
        <div class="row" style="margin-top: 8px">
          <el-tag size="small" type="info" effect="dark">{{ obj.shape === 'arrow' ? '箭头' : '线' }}</el-tag>
          <span class="hint">{{ markingPaths.length }} 条路径 · {{ obj.template || '自由绘制' }}</span>
        </div>
        <div class="row" style="margin-top: 8px">
          <el-button size="small" @click="rotateMark(-15)">左转 15°</el-button>
          <el-button size="small" @click="rotateMark(15)">右转 15°</el-button>
        </div>
        <div class="row" style="margin-top: 8px">
          <el-button size="small" @click="scaleMark(1.1)">放大 10%</el-button>
          <el-button size="small" @click="scaleMark(0.9)">缩小 10%</el-button>
        </div>

        <div style="margin-top: 10px">
          <div class="hint" style="margin-bottom: 4px">顶点（可编辑坐标，或直接拖拽视口中的黄色手柄）</div>
          <div
            v-for="path in markingPaths"
            :key="path.pathIndex"
            style="margin-bottom: 6px"
          >
            <div v-if="markingPaths.length > 1" class="hint" style="margin-bottom: 2px">
              路径 {{ path.pathIndex + 1 }} · {{ path.points.length }} 点
            </div>
            <div
              v-for="(p, i) in path.points"
              :key="`${path.pathIndex}-${i}`"
              class="vertex-row"
            >
              <span class="vertex-idx">{{ i + 1 }}</span>
              <el-input-number
                v-for="(axis, ai) in ['x', 'y', 'z']"
                :key="axis"
                :model-value="Number((p[ai] ?? 0).toFixed(2))"
                :step="0.1"
                :controls="false"
                size="small"
                style="width: 100%"
                @change="(v) => setPoint(path.pathIndex, i, ai, v)"
              />
              <el-button link type="danger" size="small" @click="removePoint(path.pathIndex, i)">
                <el-icon><Close /></el-icon>
              </el-button>
            </div>
          </div>
        </div>
      </template>

      <!-- 3D 框属性 -->
      <template v-else>
        <div class="grid-2">
          <div v-for="f in FIELDS" :key="f.key" class="field">
            <label>{{ f.label }}</label>
            <el-input-number
              :model-value="Number(obj[f.key].toFixed(4))"
              :step="0.1"
              :controls="false"
              size="small"
              style="width: 100%"
              @change="(v) => setField(f.key, v)"
            />
          </div>
          <div class="field">
            <label>偏航 ry°</label>
            <el-input-number
              v-model="ryDeg"
              :step="1"
              :controls="false"
              size="small"
              style="width: 100%"
            />
          </div>
        </div>
      </template>

      <div class="row" style="margin-top: 10px">
        <span class="obj-dot" :style="{ background: classColor(obj.classId) }"></span>
        <span class="hint">trackId {{ obj.trackId }} · {{ obj.source }}</span>
      </div>
      <div v-if="obj.multiFrame" class="row" style="margin-top: 6px">
        <el-tag size="small" type="warning" effect="dark">多帧物体</el-tag>
        <span class="hint">起始帧 {{ (obj.startFrame ?? 0) + 1 }} · 共 {{ trackFrames }} 帧</span>
      </div>
      <div v-if="obj.trackId" class="row" style="margin-top: 8px">
        <el-button size="small" @click="syncForward">同步本帧位姿到后续帧</el-button>
      </div>
    </template>
  </div>
</template>

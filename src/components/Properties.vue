<script setup>
/**
 * Properties —— 右侧选中对象的属性编辑面板
 * 类别 / 尺寸 l,w,h / 中心 x,y,z / 偏航 ry；多帧物体额外显示起始帧并支持同步到后续帧
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
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { radToDeg, degToRad } from '../utils/math.js'

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

/** 数值字段变更写回对象 */
function setField(key, value) {
  if (!obj.value || value === null || value === undefined) return
  updateObject(obj.value.id, { [key]: Number(value) })
}

function setClass(value) {
  if (obj.value) updateObject(obj.value.id, { classId: value })
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

<script setup>
/**
 * ObjectList —— 左侧当前帧标注对象列表
 * 单击选中、双击把视口焦点移到该对象、右侧按钮删除（多帧物体走确认流程）
 */
import { computed, ref, watch } from 'vue'
import {
  state,
  currentObjects,
  currentFrame,
  classColor,
  selectObject,
  selectObjects,
  clearSelection,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { requestRemoveObject } from '../utils/actions.js'
import { polylineLength } from '../utils/polyline.js'
import { canEditCurrentFrame } from '../stores/useReviewStore.js'

let anchorId = null
const PAGE_SIZE = 200
const keyword = ref('')
const classFilter = ref(null)
const limit = ref(PAGE_SIZE)

/** 过滤后仍保留全部对象，超出上限只渲染前 limit 条，避免大帧卡顿 */
const filteredObjects = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return currentObjects.value.filter((obj) => {
    if (classFilter.value !== null && classFilter.value !== undefined && obj.classId !== classFilter.value) {
      return false
    }
    if (!text) return true
    return `${obj.type || ''} ${obj.trackId || ''} ${obj.source || ''}`.toLowerCase().includes(text)
  })
})

const visibleObjects = computed(() => filteredObjects.value.slice(0, limit.value))
const hasMore = computed(() => filteredObjects.value.length > visibleObjects.value.length)

watch(
  () => [state.datasetName, state.currentIndex, keyword.value, classFilter.value],
  () => {
    anchorId = null
    limit.value = PAGE_SIZE
  },
)

/** 对象列表点击：普通单选、Ctrl 切换、Shift 范围选择 */
function onItemClick(obj, event) {
  if (event.shiftKey && anchorId) {
    const ids = currentObjects.value.map((o) => o.id)
    const a = ids.indexOf(anchorId)
    const b = ids.indexOf(obj.id)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      selectObjects(ids.slice(lo, hi + 1))
      return
    }
  }
  if (event.ctrlKey || event.metaKey) {
    selectObject(obj.id, { additive: true })
  } else {
    selectObject(obj.id)
  }
  anchorId = obj.id
}

function selectAll() {
  selectObjects(currentObjects.value.map((o) => o.id))
}

function isSelected(id) {
  return state.selectedObjectIds.includes(id)
}

/** 双击让视口聚焦到该对象 */
function focusObject(obj) {
  selectObject(obj.id)
  viewerRef.current?.focusObject(obj)
}

/** 尺寸/形状展示文案 */
function dims(obj) {
  if (obj.shape === 'line') {
    const n = obj.points?.length || 0
    return `${n} 点 · ${polylineLength(obj.points).toFixed(1)}m`
  }
  if (obj.shape === 'arrow') {
    const paths = obj.paths || []
    const n = paths.reduce((s, p) => s + p.length, 0)
    const len = paths.reduce((s, p) => s + polylineLength(p), 0)
    return `${paths.length} 路径 · ${n} 点 · ${len.toFixed(1)}m`
  }
  return `${obj.l.toFixed(1)}×${obj.w.toFixed(1)}×${obj.h.toFixed(1)}`
}

/** 对象类型标签 */
function kindTag(obj) {
  if (obj.shape === 'line') return '线'
  if (obj.shape === 'arrow') return '箭头'
  return ''
}

function remove(obj) {
  requestRemoveObject(obj)
}
</script>

<template>
  <aside class="panel panel-left">
    <div class="section">
      <h3 class="section-title">
        <span>标注对象</span>
        <span>
          <el-tag v-if="state.multiFrame" size="small" type="warning" effect="dark">多帧</el-tag>
          <el-tag size="small" type="info" effect="dark" style="margin-left: 4px">
            {{ currentObjects.length }}
          </el-tag>
        </span>
      </h3>
      <div class="hint" v-if="currentFrame">{{ currentFrame.name }}</div>
      <div v-if="currentObjects.length" class="row" style="margin-top: 8px; gap: 8px">
        <span class="hint">已选 {{ state.selectedObjectIds.length }}</span>
        <el-button link size="small" @click="selectAll">全选</el-button>
        <el-button
          link
          size="small"
          :disabled="!state.selectedObjectIds.length"
          @click="clearSelection"
        >
          取消选择
        </el-button>
      </div>
      <div v-if="currentObjects.length" class="obj-filters">
        <el-input
          v-model="keyword"
          size="small"
          placeholder="搜索类型 / trackId"
          clearable
          style="width: 100%"
        />
        <el-select v-model="classFilter" size="small" placeholder="全部类别" clearable style="width: 100%">
          <el-option v-for="c in state.classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div v-if="keyword || classFilter !== null" class="hint" style="margin-top: 4px">
        匹配 {{ filteredObjects.length }} / {{ currentObjects.length }} 个对象
      </div>
    </div>
    <el-scrollbar class="panel-scroll">
      <el-empty
        v-if="!filteredObjects.length"
        class="list-empty"
        :image-size="60"
        :description="currentObjects.length ? '没有匹配的对象' : '本帧暂无标注'"
      />
      <template v-else>
        <div
          v-for="obj in visibleObjects"
          :key="obj.id"
          class="obj-item"
          :class="{ selected: isSelected(obj.id) }"
          @click="onItemClick(obj, $event)"
          @dblclick="focusObject(obj)"
        >
          <span class="obj-dot" :style="{ background: classColor(obj.classId) }"></span>
          <div class="obj-main">
            <div class="obj-name">
              {{ obj.type }}
              <el-tag v-if="kindTag(obj)" size="small" type="info" effect="plain">{{ kindTag(obj) }}</el-tag>
              <el-tag v-if="obj.trackId" size="small" type="warning" effect="plain">T{{ obj.trackId }}</el-tag>
            </div>
            <div class="obj-sub">
              {{ dims(obj) }}<template v-if="obj.shape !== 'line' && obj.shape !== 'arrow'">
                · ry {{ (obj.ry * 57.2958).toFixed(0) }}°</template>
            </div>
          </div>
          <el-button v-if="canEditCurrentFrame" link type="danger" @click.stop="remove(obj)">
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
        <div v-if="hasMore" class="obj-more">
          <el-button link size="small" @click="limit += PAGE_SIZE">
            显示更多（剩余 {{ filteredObjects.length - visibleObjects.length }}）
          </el-button>
        </div>
      </template>
    </el-scrollbar>
  </aside>
</template>

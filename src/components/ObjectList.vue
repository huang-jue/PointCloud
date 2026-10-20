<script setup>
/**
 * ObjectList —— 左侧当前帧标注对象列表
 * 单击选中、双击把视口焦点移到该对象、右侧按钮删除（多帧物体走确认流程）
 */
import {
  state,
  currentObjects,
  currentFrame,
  classColor,
  selectObject,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { requestRemoveObject } from '../utils/actions.js'
import { polylineLength } from '../utils/polyline.js'

/** 双击让视口聚焦到该对象 */
function focusObject(obj) {
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
    </div>
    <el-scrollbar class="panel-scroll">
      <el-empty
        v-if="!currentObjects.length"
        class="list-empty"
        :image-size="60"
        description="本帧暂无标注"
      />
      <template v-else>
        <div
          v-for="obj in currentObjects"
          :key="obj.id"
          class="obj-item"
          :class="{ selected: obj.id === state.selectedObjectId }"
          @click="selectObject(obj.id)"
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
          <el-button link type="danger" @click.stop="remove(obj)">
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
      </template>
    </el-scrollbar>
  </aside>
</template>

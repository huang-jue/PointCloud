<script setup>
/**
 * StatusBar —— 底部信息栏
 * 显示数据集名、当前帧与点数、本帧对象数、坐标约定、累计点数与快捷键提示
 */
import { computed } from 'vue'
import { state, currentFrame, currentObjects } from '../stores/useAnnotationStore.js'

/** 所有帧点数之和（部分帧未加载则只统计已加载的） */
const totalPoints = computed(() => {
  let total = 0
  for (const f of state.frames) total += f.pointCount || 0
  return total
})

/** 坐标约定文案 */
const coordText = computed(
  () => `up=${state.coordinate.up} forward=${state.coordinate.forward} right=${state.coordinate.right}`,
)
</script>

<template>
  <div class="statusbar">
    <el-tag size="small" effect="dark" type="info">{{ state.datasetName || '未加载' }}</el-tag>
    <span v-if="currentFrame" class="mono">
      帧 {{ state.currentIndex + 1 }}/{{ state.frames.length }} · 点数
      {{ (currentFrame.pointCount || 0).toLocaleString() }}
    </span>
    <span v-else>无数据</span>
    <span>本帧对象 <b>{{ currentObjects.length }}</b></span>
    <span v-if="state.tool === 'line' || state.tool === 'arrow'" class="mono">
      绘制中 · 已落点 {{ state.draftCount }}
    </span>
    <el-tooltip :content="`坐标约定 ${coordText}`" placement="top">
      <span style="cursor: help">坐标 Z↑</span>
    </el-tooltip>
    <span class="spacer"></span>
    <span v-if="totalPoints" class="mono">累计点数 {{ totalPoints.toLocaleString() }}</span>
    <el-tooltip
      placement="top"
      content="← → 切帧 · 空格 播放 · Q/W/E/R 选择/移动/旋转/缩放 · L 画线 · A 画箭头 · 绘制时 Enter 完成 / Esc 取消 / Backspace 退点 · Alt+点击顶点删除 · B 分割模式 · F 适应视角 · Del 删除 · Ctrl+Z 撤销标签 · 左键拖拽平移 · 右键拖拽旋转"
    >
      <span class="hint" style="cursor: help">快捷键 ⓘ</span>
    </el-tooltip>
  </div>
</template>

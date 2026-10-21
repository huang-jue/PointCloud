<script setup>
/** 演示引导：按顺序介绍标注、批注、提交、审核与工作台 */
import { ref, watch } from 'vue'
import { uiState } from '../stores/useUiStore.js'

const current = ref(0)

const steps = [
  {
    target: '.toolbar',
    title: '① 加载示例数据',
    description: '从“数据”下拉选择数据集，或把点云文件拖入视口。加载后会自动导入真值。',
    placement: 'bottom',
  },
  {
    target: '.viewport',
    title: '② 检查与编辑标注',
    description: '左键平移、右键旋转、滚轮缩放；Q/W/E/R 切换选择/移动/旋转/缩放。',
    placement: 'right',
  },
  {
    target: '.review-summary',
    title: '③ 查看审核进度',
    description: '这里汇总当前数据集的通过、待审核、打回数量；“工作台”可查看全部帧。',
    placement: 'left',
  },
  {
    target: '.review-actions',
    title: '④ 提交与审核',
    description: '标注员提交本帧后锁定；批注员/管理员可通过或打回。打回需要选择原因分类。',
    placement: 'left',
  },
  {
    target: '.batch-actions',
    title: '⑤ 批量操作',
    description: '提交全部、撤销全部、全部通过；已提交/已通过帧会自动跳过。',
    placement: 'left',
  },
  {
    target: '.timeline',
    title: '⑥ 时间轴状态',
    description: '刻度颜色表示审核状态，圆点表示未解决批注；点击刻度快速跳帧。',
    placement: 'top',
  },
  {
    target: '.comment-head',
    title: '⑦ 批注讨论',
    description: '每条批注可回复、切换处理状态（待处理/处理中/已完成），标注员也能直接回复。',
    placement: 'left',
  },
]

watch(
  () => uiState.tourOpen,
  (open) => {
    if (open) current.value = 0
  },
)

function onClose() {
  uiState.tourOpen = false
}
</script>

<template>
  <el-tour
    v-model="uiState.tourOpen"
    v-model:current="current"
    :mask="true"
    :show-close="true"
    @close="onClose"
  >
    <el-tour-step
      v-for="(step, index) in steps"
      :key="index"
      :target="step.target"
      :title="step.title"
      :description="step.description"
      :placement="step.placement"
    />
  </el-tour>
</template>

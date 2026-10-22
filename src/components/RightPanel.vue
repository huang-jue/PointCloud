<script setup>
/**
 * RightPanel —— 右侧面板容器
 * 把审核、对象属性、类别、点级分割收进标签页，避免四块内容纵向堆叠。
 */
import { computed, watch } from 'vue'
import { ChatDotRound, EditPen, PriceTag, Brush } from '@element-plus/icons-vue'
import CommentPanel from './CommentPanel.vue'
import Properties from './Properties.vue'
import ClassManager from './ClassManager.vue'
import SegmentPanel from './SegmentPanel.vue'
import { state, activeClass } from '../stores/useAnnotationStore.js'
import { canAnnotate } from '../stores/useAuthStore.js'
import {
  unresolvedCommentCountForFrame,
} from '../stores/useReviewStore.js'
import { uiState } from '../stores/useUiStore.js'

const ALL_TABS = [
  { id: 'review', label: '审核', title: '批注与审核', icon: ChatDotRound },
  { id: 'properties', label: '属性', title: '选中对象属性', icon: EditPen },
  { id: 'classes', label: '类别', title: '类别管理', icon: PriceTag },
  { id: 'segment', label: '分割', title: '点级语义分割', icon: Brush },
]

const tabs = computed(() => (canAnnotate.value ? ALL_TABS : ALL_TABS.slice(0, 1)))

/** 角色切换后如果当前标签不可用，回退到审核 */
const activeTab = computed(() => {
  const allowed = tabs.value.some((tab) => tab.id === uiState.rightTab)
  return allowed ? uiState.rightTab : 'review'
})

watch(
  () => canAnnotate.value,
  (allowed) => {
    if (!allowed) uiState.rightTab = 'review'
  },
)

const reviewBadge = computed(() => {
  const count = unresolvedCommentCountForFrame(state.currentIndex)
  return count > 0 ? (count > 99 ? '99+' : String(count)) : ''
})

const selectedCount = computed(() => state.selectedObjectIds.length)
const propertiesBadge = computed(() => (selectedCount.value > 1 ? String(selectedCount.value) : ''))
const propertiesDot = computed(() => selectedCount.value === 1)
const activeClassColor = computed(() => activeClass.value?.color || '#8899aa')
const segmentDot = computed(() => state.segEnabled)
</script>

<template>
  <aside class="panel panel-right">
    <div class="right-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="right-tab"
        :class="{ active: activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        :title="tab.title"
        @click="uiState.rightTab = tab.id"
      >
        <el-icon class="right-tab-icon"><component :is="tab.icon" /></el-icon>
        <span class="right-tab-label">{{ tab.label }}</span>

        <span v-if="tab.id === 'review' && reviewBadge" class="right-tab-badge">
          {{ reviewBadge }}
        </span>
        <span
          v-else-if="tab.id === 'properties' && propertiesBadge"
          class="right-tab-badge"
        >
          {{ propertiesBadge }}
        </span>
        <span v-else-if="tab.id === 'properties' && propertiesDot" class="right-tab-dot"></span>
        <span
          v-else-if="tab.id === 'classes'"
          class="right-tab-dot"
          :style="{ background: activeClassColor }"
        ></span>
        <span v-else-if="tab.id === 'segment' && segmentDot" class="right-tab-dot is-on"></span>
      </button>
    </div>

    <div class="right-panel-body">
      <CommentPanel v-show="activeTab === 'review'" />
      <template v-if="canAnnotate">
        <Properties v-show="activeTab === 'properties'" />
        <ClassManager v-show="activeTab === 'classes'" />
        <SegmentPanel v-show="activeTab === 'segment'" />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.right-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 5px 6px 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}

.right-tab {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  height: 34px;
  padding: 0 4px;
  border: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.right-tab:hover {
  background: var(--bg-2);
  color: var(--text);
}

.right-tab.active {
  background: var(--bg-0, var(--bg-1));
  color: var(--accent);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.right-tab-icon {
  font-size: 14px;
  flex: none;
}

.right-tab-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.right-tab-badge {
  position: absolute;
  top: 2px;
  right: 4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--danger, #ff6b6b);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}

.right-tab-dot {
  position: absolute;
  top: 5px;
  right: 7px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.right-tab-dot.is-on {
  background: var(--success, #57d9a3);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--success, #57d9a3) 25%, transparent);
}

.right-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.right-panel-body :deep(.section) {
  border-bottom: none;
  padding-top: 10px;
}

.right-panel-body :deep(.section-title) {
  margin-bottom: 8px;
}
</style>

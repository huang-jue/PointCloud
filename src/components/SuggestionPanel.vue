<script setup>
/** AI 预标注建议（演示 mock，可替换为真实推理接口） */
import { computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../stores/useAnnotationStore.js'
import { uiState } from '../stores/useUiStore.js'
import { canEditCurrentFrame } from '../stores/useReviewStore.js'
import {
  acceptAllSuggestions,
  acceptSuggestion,
  loadSuggestions,
  rejectAllSuggestions,
  rejectSuggestion,
  suggestionState,
  suggestionSummary,
} from '../stores/useSuggestionStore.js'

const open = computed({
  get: () => uiState.suggestionsOpen,
  set: (value) => {
    uiState.suggestionsOpen = value
  },
})

const frameLabel = computed(() => {
  const frame = state.frames[state.currentIndex]
  return frame ? frame.name : '当前帧'
})

watch(
  () => uiState.suggestionsOpen,
  (visible) => {
    if (visible) loadSuggestions().catch((err) => (suggestionState.error = err.message || String(err)))
  },
)

watch(
  () => state.currentIndex,
  () => {
    if (uiState.suggestionsOpen) loadSuggestions().catch(() => {})
  },
)

function accept(item) {
  try {
    acceptSuggestion(item.id)
    ElMessage.success(`已接受建议：${item.label}`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function reject(item) {
  rejectSuggestion(item.id)
}

function acceptAll() {
  try {
    const n = acceptAllSuggestions()
    if (n) ElMessage.success(`已接受 ${n} 条建议`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function rejectAll() {
  const n = rejectAllSuggestions()
  if (n) ElMessage.info(`已忽略 ${n} 条建议`)
}
</script>

<template>
  <el-dialog v-model="open" title="AI 预标注建议" width="460px" append-to-body>
    <div class="sug-head">
      <div>
        <el-tag size="small" type="warning" effect="plain">演示模型</el-tag>
        <span class="hint" style="margin-left: 6px">{{ frameLabel }}</span>
      </div>
      <span class="hint">
        {{ suggestionSummary.add }} 个新增 · {{ suggestionSummary.refine }} 个优化建议
      </span>
    </div>

    <div v-if="!canEditCurrentFrame" class="hint sug-empty">当前帧已锁定，不能接受建议。</div>
    <div v-else-if="suggestionState.loading" class="hint sug-empty">正在生成建议…</div>
    <div v-else-if="suggestionState.error" class="hint sug-empty">{{ suggestionState.error }}</div>
    <div v-else-if="!suggestionState.items.length" class="hint sug-empty">
      本帧暂无可用的 mock 建议；可以切换帧或先清空本帧标注再试。
    </div>
    <div v-else class="sug-list">
      <div v-for="item in suggestionState.items" :key="item.id" class="sug-item">
        <div class="sug-main">
          <div class="sug-title">
            <el-tag size="small" :type="item.kind === 'add' ? 'primary' : 'warning'" effect="plain">
              {{ item.kind === 'add' ? '新增' : '优化' }}
            </el-tag>
            <span>{{ item.label }}</span>
          </div>
          <div class="sug-score">置信度 {{ (item.score * 100).toFixed(0) }}%</div>
        </div>
        <div class="sug-actions">
          <el-button size="small" type="primary" plain @click="accept(item)">接受</el-button>
          <el-button size="small" @click="reject(item)">忽略</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="rejectAll">忽略全部</el-button>
      <el-button size="small" type="primary" :disabled="!suggestionState.items.length" @click="acceptAll">
        接受全部
      </el-button>
      <el-button size="small" @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.sug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.sug-empty {
  padding: 18px 0;
  text-align: center;
}

.sug-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}

.sug-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 6px;
  padding: 8px 10px;
}

.sug-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}

.sug-score {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
}

.sug-actions {
  display: flex;
  gap: 4px;
  flex: none;
}
</style>

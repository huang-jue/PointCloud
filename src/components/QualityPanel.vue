<script setup>
/** 标注质量检查面板 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { state, store, selectObject } from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { uiState } from '../stores/useUiStore.js'
import { downloadJson } from '../utils/io.js'
import { checkDataset, checkFrame, summarizeIssues } from '../utils/qa.js'

const issues = ref([])
const scope = ref('current')
const running = ref(false)
const onlyErrors = ref(false)

const open = computed({
  get: () => uiState.qualityOpen,
  set: (value) => {
    uiState.qualityOpen = value
  },
})

const filtered = computed(() =>
  onlyErrors.value ? issues.value.filter((i) => i.severity === 'error') : issues.value,
)
const summary = computed(() => summarizeIssues(issues.value))

function run() {
  running.value = true
  try {
    issues.value =
      scope.value === 'current'
        ? checkFrame(state.frames[state.currentIndex], state.currentIndex, {
            sensorHeight: state.sensorHeight,
          })
        : checkDataset(state.frames, { sensorHeight: state.sensorHeight })
    ElMessage.success(
      issues.value.length
        ? `检查完成：${issues.value.length} 个问题`
        : '检查完成：没有发现问题',
    )
  } finally {
    running.value = false
  }
}

watch(
  () => uiState.qualityOpen,
  (visible) => {
    if (visible) run()
  },
)

function locate(issue) {
  if (issue.frameIndex !== state.currentIndex) store.setCurrentIndex(issue.frameIndex)
  if (!issue.objectId) return
  const obj = state.frames[issue.frameIndex]?.objects.find((o) => o.id === issue.objectId)
  if (!obj) return
  selectObject(obj.id)
  viewerRef.current?.focusObject?.(obj)
}

function exportReport() {
  downloadJson(`${state.datasetName || 'dataset'}-qa-report.json`, {
    dataset: state.datasetName,
    exportedAt: new Date().toISOString(),
    summary: summary.value,
    issues: issues.value,
  })
}
</script>

<template>
  <el-dialog v-model="open" title="标注质量检查" width="600px" append-to-body>
    <div class="qa-toolbar">
      <el-radio-group v-model="scope" size="small">
        <el-radio-button value="current">当前帧</el-radio-button>
        <el-radio-button value="all">全数据集</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="onlyErrors" size="small">只看错误</el-checkbox>
      <span class="spacer"></span>
      <el-button size="small" type="primary" plain :loading="running" @click="run">重新检查</el-button>
      <el-button size="small" :disabled="!issues.length" @click="exportReport">导出报告</el-button>
    </div>

    <div class="qa-summary">
      <span>共 {{ summary.total }} 个问题</span>
      <span class="qa-error">错误 {{ summary.error }}</span>
      <span class="qa-warn">警告 {{ summary.warning }}</span>
    </div>

    <div v-if="!filtered.length" class="hint qa-empty">没有发现质量问题</div>
    <div v-else class="qa-list">
      <div v-for="(issue, index) in filtered" :key="`${issue.frameIndex}-${issue.objectId}-${index}`" class="qa-item">
        <div class="qa-main">
          <div class="qa-title">
            <el-tag size="small" :type="issue.severity === 'error' ? 'danger' : 'warning'" effect="plain">
              {{ issue.severity === 'error' ? '错误' : '警告' }}
            </el-tag>
            <span>{{ issue.rule }}</span>
            <span class="hint">第 {{ issue.frameIndex + 1 }} 帧 · {{ issue.objectLabel }}</span>
          </div>
          <div class="qa-message">{{ issue.message }}</div>
        </div>
        <el-button link size="small" @click="locate(issue)">定位</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.qa-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.qa-toolbar .spacer {
  flex: 1;
}

.qa-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: var(--bg-2);
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-dim);
}

.qa-error {
  color: var(--danger);
}

.qa-warn {
  color: var(--warning, #e6a23c);
}

.qa-empty {
  padding: 24px 0;
  text-align: center;
}

.qa-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 55vh;
  overflow-y: auto;
}

.qa-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 6px;
}

.qa-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text);
}

.qa-message {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-dim);
}
</style>

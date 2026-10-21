<script setup>
/** 版本快照：查看当前帧历史版本、对比与回滚（只保存标注对象） */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../stores/useAnnotationStore.js'
import { canEditCurrentFrame } from '../stores/useReviewStore.js'
import { uiState } from '../stores/useUiStore.js'
import { diffSnapshots, snapshotFrame } from '../utils/diff.js'
import { clearFrameVersions, getVersion, listVersions } from '../utils/versionDb.js'

const versions = ref([])
const loading = ref(false)
const comparison = ref(null)

const open = computed({
  get: () => uiState.versionsOpen,
  set: (value) => {
    uiState.versionsOpen = value
  },
})

const currentFrame = computed(() => state.frames[state.currentIndex] || null)

const KIND_LABELS = {
  submit: '提交快照',
  approve: '通过快照',
  manual: '手动快照',
}

async function refresh() {
  comparison.value = null
  if (!currentFrame.value) {
    versions.value = []
    return
  }
  loading.value = true
  try {
    versions.value = await listVersions(state.datasetName || 'local', state.currentIndex)
  } catch (err) {
    versions.value = []
    ElMessage.warning(`读取版本失败：${err.message || err}`)
  } finally {
    loading.value = false
  }
}

watch(
  () => [uiState.versionsOpen, state.currentIndex, state.datasetName],
  () => {
    if (uiState.versionsOpen) refresh()
  },
)

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''
}

function compare(version) {
  const current = snapshotFrame(currentFrame.value)
  const old = snapshotFrame({ objects: version.objects })
  const diff = diffSnapshots(old, current)
  comparison.value = { id: version.id, counts: diff.counts }
}

async function restore(version) {
  if (!canEditCurrentFrame.value) {
    ElMessage.warning('当前帧已提交/已通过，不能回滚')
    return
  }
  try {
    await ElMessageBox.confirm(
      `回滚到 ${formatTime(version.createdAt)} 的版本？当前未保存的修改会被覆盖。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const record = await getVersion(version.id)
    if (!record) throw new Error('版本不存在')
    const frame = currentFrame.value
    frame.objects.splice(0, frame.objects.length, ...JSON.parse(JSON.stringify(record.objects || [])))
    state.selectedObjectIds = []
    state.selectedObjectId = null
    ElMessage.success('已回滚到所选版本')
    await refresh()
  } catch (err) {
    ElMessage.error(err.message || String(err))
  }
}

async function clearAll() {
  if (!currentFrame.value) return
  try {
    await ElMessageBox.confirm('清空当前帧的全部版本记录？', '清空版本', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await clearFrameVersions(state.datasetName || 'local', state.currentIndex)
  versions.value = []
  comparison.value = null
}
</script>

<template>
  <el-dialog v-model="open" title="版本快照" width="560px" append-to-body>
    <div class="ver-head">
      <span class="hint">
        {{ currentFrame?.name || '未加载帧' }} · 每帧保留最近 10 个版本（仅标注对象）
      </span>
      <el-button size="small" :loading="loading" @click="refresh">刷新</el-button>
    </div>

    <div v-if="!currentFrame" class="hint ver-empty">请先加载数据</div>
    <div v-else-if="!versions.length" class="hint ver-empty">本帧还没有版本记录，提交或通过审核时会自动保存</div>
    <div v-else class="ver-list">
      <div v-for="version in versions" :key="version.id" class="ver-item">
        <div class="ver-main">
          <div class="ver-title">
            <el-tag size="small" type="info" effect="plain">
              {{ KIND_LABELS[version.kind] || version.kind }}
            </el-tag>
            <span>第 {{ version.round || 1 }} 轮</span>
            <span class="hint">{{ formatTime(version.createdAt) }}</span>
          </div>
          <div class="ver-sub">
            {{ version.actor || '系统' }} · {{ version.objects.length }} 个对象
            <template v-if="comparison?.id === version.id">
              · 与当前对比
              <span class="ver-add">+{{ comparison.counts.added }}</span>
              <span class="ver-chg">~{{ comparison.counts.changed }}</span>
              <span class="ver-del">-{{ comparison.counts.removed }}</span>
            </template>
          </div>
        </div>
        <div class="ver-actions">
          <el-button link size="small" @click="compare(version)">对比</el-button>
          <el-button link type="primary" size="small" @click="restore(version)">回滚</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button size="small" type="danger" plain :disabled="!versions.length" @click="clearAll">清空本帧版本</el-button>
      <el-button size="small" @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ver-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.ver-empty {
  padding: 22px 0;
  text-align: center;
}

.ver-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
}

.ver-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 6px;
  padding: 7px 9px;
}

.ver-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text);
}

.ver-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
}

.ver-add {
  color: var(--success, #57d9a3);
}

.ver-chg {
  color: var(--warning, #e6a23c);
}

.ver-del {
  color: var(--danger);
}

.ver-actions {
  display: flex;
  gap: 2px;
  flex: none;
}
</style>

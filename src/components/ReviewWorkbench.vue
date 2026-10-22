<script setup>
/**
 * ReviewWorkbench —— 审核工作台
 *  - 帧队列：状态/批注/轮次/diff 一览，筛选与跳转
 *  - 统计：通过率、轮次、耗时、打回分类、人员工作量
 *  - 复用批量提交/撤销/通过
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state, store } from '../stores/useAnnotationStore.js'
import { canAnnotate, canComment } from '../stores/useAuthStore.js'
import { uiState } from '../stores/useUiStore.js'
import { downloadJson } from '../utils/io.js'
import {
  COMMENT_STATUS,
  REJECT_CATEGORIES,
  statusLabelOf,
  statusTypeOf,
} from '../stores/reviewCore.js'
import {
  approveAllFrames,
  approveFrame,
  batchSubmitSummary,
  canApproveAllFrames,
  canSubmitAllFrames,
  canWithdrawAllFrames,
  frameStatus,
  rejectFrame,
  reviewState,
  reviewSummary,
  submittedIndexes,
  submitAllFrames,
  submitFrame,
  withdrawAllFrames,
  withdrawFrame,
} from '../stores/useReviewStore.js'

const tab = ref('queue')
const statusFilter = ref('all')
const onlyUnresolved = ref(false)
const keyword = ref('')

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'draft', label: '未提交' },
  { value: 'submitted', label: '待审核' },
  { value: 'rejected', label: '已打回' },
  { value: 'approved', label: '已通过' },
]

function commentStatus(comment) {
  return comment.status || (comment.resolved ? COMMENT_STATUS.DONE : COMMENT_STATUS.PENDING)
}

const rows = computed(() =>
  state.frames.map((frame, index) => {
    const workflow = reviewState.workflows[String(index)] || null
    const comments = reviewState.comments.filter((c) => c.frameIndex === index)
    const unresolved = comments.filter((c) => commentStatus(c) !== COMMENT_STATUS.DONE).length
    return {
      index,
      name: frame.name,
      status: frameStatus(index),
      round: workflow?.round || 0,
      comments: comments.length,
      unresolved,
      diff: workflow?.lastDiff?.counts || null,
      submittedBy: workflow?.submittedBy || '',
      reviewedBy: workflow?.reviewedBy || '',
    }
  }),
)

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    if (statusFilter.value !== 'all' && row.status !== statusFilter.value) return false
    if (onlyUnresolved.value && !row.unresolved) return false
    if (keyword.value && !row.name.toLowerCase().includes(keyword.value.toLowerCase())) return false
    return true
  }),
)

const stats = computed(() => {
  const summary = reviewSummary.value
  const workflows = Object.values(reviewState.workflows || {})
  const totalRounds = workflows.reduce((sum, w) => sum + (w.round || 0), 0)
  const reviewed = workflows.filter((w) => w.submittedAt && w.reviewedAt)
  const totalReviewMs = reviewed.reduce((sum, w) => sum + Math.max(0, w.reviewedAt - w.submittedAt), 0)

  const categoryCounts = Object.fromEntries(REJECT_CATEGORIES.map((c) => [c.id, 0]))
  const reviewerCounts = {}
  const submitterCounts = {}
  let unresolved = 0

  for (const comment of reviewState.comments) {
    if (commentStatus(comment) !== COMMENT_STATUS.DONE) unresolved++
    if (comment.kind === 'rejection') {
      const key = comment.category || 'other'
      categoryCounts[key] = (categoryCounts[key] || 0) + 1
    }
  }
  for (const workflow of workflows) {
    if (workflow.reviewedBy) {
      reviewerCounts[workflow.reviewedBy] = (reviewerCounts[workflow.reviewedBy] || 0) + 1
    }
    if (workflow.submittedBy) {
      submitterCounts[workflow.submittedBy] = (submitterCounts[workflow.submittedBy] || 0) + 1
    }
  }

  return {
    summary,
    approvalRate: summary.total ? summary.approved / summary.total : 0,
    avgRounds: summary.total ? totalRounds / summary.total : 0,
    avgReviewMinutes: reviewed.length ? totalReviewMs / reviewed.length / 60000 : 0,
    unresolved,
    categoryCounts,
    reviewerCounts: Object.entries(reviewerCounts).sort((a, b) => b[1] - a[1]),
    submitterCounts: Object.entries(submitterCounts).sort((a, b) => b[1] - a[1]),
    maxCategory: Math.max(1, ...Object.values(categoryCounts)),
  }
})

const statusBars = computed(() => {
  const s = reviewSummary.value
  return [
    { key: 'approved', label: '已通过', count: s.approved, type: 'ok' },
    { key: 'submitted', label: '待审核', count: s.submitted, type: 'pending' },
    { key: 'rejected', label: '已打回', count: s.rejected, type: 'danger' },
    { key: 'draft', label: '未提交', count: s.draft, type: 'muted' },
  ].map((item) => ({ ...item, percent: s.total ? (item.count / s.total) * 100 : 0 }))
})

function goTo(row) {
  store.setCurrentIndex(row.index)
  uiState.workbenchOpen = false
}

async function submitRow(row) {
  try {
    submitFrame(row.index)
    ElMessage.success(`第 ${row.index + 1} 帧已提交`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function withdrawRow(row) {
  try {
    withdrawFrame(row.index)
    ElMessage.success(`已撤销第 ${row.index + 1} 帧提交`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function approveRow(row) {
  try {
    await ElMessageBox.confirm(`确定通过第 ${row.index + 1} 帧？`, '通过审核', {
      type: 'success',
      confirmButtonText: '通过',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    approveFrame(row.index)
    ElMessage.success('已通过')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function rejectRow(row) {
  try {
    const { value } = await ElMessageBox.prompt('请填写打回原因（分类可在当前帧批注面板中调整）', '打回审核', {
      inputType: 'textarea',
      inputValidator: (v) => (String(v || '').trim() ? true : '请输入打回原因'),
      confirmButtonText: '打回',
      cancelButtonText: '取消',
      type: 'warning',
    })
    rejectFrame(value, row.index, 'other')
    ElMessage.success('已打回')
  } catch {
    /* 取消 */
  }
}

async function submitAll() {
  const info = batchSubmitSummary.value
  if (!info.count) return
  try {
    await ElMessageBox.confirm(
      `将提交 ${info.count} 帧，跳过 ${info.skipped} 帧待审核/已通过${info.empty ? `；其中 ${info.empty} 帧没有标注对象` : ''}。确定？`,
      '提交全部帧',
      { type: 'info', confirmButtonText: '全部提交', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const result = submitAllFrames()
    ElMessage.success(`已提交 ${result.submitted} 帧`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function withdrawAll() {
  const count = submittedIndexes.value.length
  if (!count) return
  try {
    await ElMessageBox.confirm(`将撤销 ${count} 帧提交，确定？`, '撤销全部提交', {
      type: 'warning',
      confirmButtonText: '全部撤销',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const result = withdrawAllFrames()
    ElMessage.success(`已撤销 ${result.withdrawn} 帧`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function approveAll() {
  const count = submittedIndexes.value.length
  if (!count) return
  try {
    await ElMessageBox.confirm(`将通过 ${count} 帧待审核标注，确定？`, '全部通过', {
      type: 'success',
      confirmButtonText: '全部通过',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const result = approveAllFrames()
    ElMessage.success(`已通过 ${result.approved} 帧`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function exportStats() {
  downloadJson(`${state.datasetName || 'dataset'}-review-stats.json`, {
    dataset: state.datasetName,
    exportedAt: new Date().toISOString(),
    summary: stats.value.summary,
    approvalRate: stats.value.approvalRate,
    avgRounds: stats.value.avgRounds,
    avgReviewMinutes: stats.value.avgReviewMinutes,
    unresolved: stats.value.unresolved,
    categoryCounts: stats.value.categoryCounts,
    reviewerCounts: Object.fromEntries(stats.value.reviewerCounts),
    submitterCounts: Object.fromEntries(stats.value.submitterCounts),
    frames: rows.value,
  })
  ElMessage.success('统计已导出')
}
</script>

<template>
  <el-dialog
    v-model="uiState.workbenchOpen"
    title="审核工作台"
    width="920px"
    top="5vh"
    append-to-body
    class="review-workbench"
  >
    <el-tabs v-model="tab">
      <el-tab-pane label="帧队列" name="queue">
        <div class="wb-toolbar">
          <el-select v-model="statusFilter" size="small" style="width: 110px">
            <el-option v-for="opt in statusOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <el-input v-model="keyword" size="small" placeholder="搜索帧名" clearable style="width: 150px" />
          <el-checkbox v-model="onlyUnresolved" size="small">只看未解决批注</el-checkbox>
          <span class="spacer"></span>
          <el-button v-if="canAnnotate" size="small" type="primary" plain :disabled="!canSubmitAllFrames" @click="submitAll">
            提交全部（{{ batchSubmitSummary.count }}）
          </el-button>
          <el-button v-if="canAnnotate" size="small" :disabled="!canWithdrawAllFrames" @click="withdrawAll">
            撤销全部（{{ submittedIndexes.length }}）
          </el-button>
          <el-button v-if="canComment" size="small" type="success" plain :disabled="!canApproveAllFrames" @click="approveAll">
            全部通过（{{ submittedIndexes.length }}）
          </el-button>
        </div>

        <div class="wb-table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>帧</th>
                <th>状态</th>
                <th>轮次</th>
                <th>批注</th>
                <th>未解决</th>
                <th>本轮变化</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.index">
                <td class="wb-frame" @click="goTo(row)">
                  <span class="wb-index">{{ row.index + 1 }}</span>
                  <span>{{ row.name }}</span>
                </td>
                <td>
                  <el-tag size="small" :type="statusTypeOf(row.status)" effect="plain">
                    {{ statusLabelOf(row.status) }}
                  </el-tag>
                </td>
                <td class="mono">{{ row.round || '-' }}</td>
                <td class="mono">{{ row.comments }}</td>
                <td class="mono" :class="{ 'wb-warn': row.unresolved }">{{ row.unresolved }}</td>
                <td class="mono">
                  <template v-if="row.diff">
                    <span class="wb-add">+{{ row.diff.added }}</span>
                    <span class="wb-chg">~{{ row.diff.changed }}</span>
                    <span class="wb-del">-{{ row.diff.removed }}</span>
                  </template>
                  <span v-else class="hint">-</span>
                </td>
                <td>
                  <div class="wb-actions">
                    <el-button link size="small" @click="goTo(row)">定位</el-button>
                    <el-button
                      v-if="canAnnotate && (row.status === 'draft' || row.status === 'rejected')"
                      link
                      type="primary"
                      size="small"
                      @click="submitRow(row)"
                    >
                      提交
                    </el-button>
                    <el-button
                      v-if="canAnnotate && row.status === 'submitted'"
                      link
                      size="small"
                      @click="withdrawRow(row)"
                    >
                      撤销
                    </el-button>
                    <template v-if="canComment && row.status === 'submitted'">
                      <el-button link type="success" size="small" @click="approveRow(row)">通过</el-button>
                      <el-button link type="danger" size="small" @click="rejectRow(row)">打回</el-button>
                    </template>
                  </div>
                </td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="7" class="wb-empty">没有符合条件的帧</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="wb-foot hint">
          共 {{ filteredRows.length }} / {{ rows.length }} 帧 · 点击帧编号或“定位”跳转
        </div>
      </el-tab-pane>

      <el-tab-pane label="统计" name="stats">
        <div class="stat-cards">
          <div class="stat-card">
            <div class="stat-label">总帧数</div>
            <div class="stat-value">{{ stats.summary.total }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">通过率</div>
            <div class="stat-value">{{ (stats.approvalRate * 100).toFixed(1) }}%</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">平均轮次</div>
            <div class="stat-value">{{ stats.avgRounds.toFixed(2) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">平均审核耗时</div>
            <div class="stat-value">{{ stats.avgReviewMinutes.toFixed(1) }}<small>min</small></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">未解决批注</div>
            <div class="stat-value wb-warn">{{ stats.unresolved }}</div>
          </div>
        </div>

        <div class="stat-section">
          <div class="stat-title">帧状态分布</div>
          <div v-for="bar in statusBars" :key="bar.key" class="bar-row">
            <span class="bar-label">{{ bar.label }}</span>
            <div class="bar-track">
              <div class="bar-fill" :class="bar.type" :style="{ width: `${bar.percent}%` }"></div>
            </div>
            <span class="bar-value">{{ bar.count }}</span>
          </div>
        </div>

        <div class="stat-columns">
          <div class="stat-section">
            <div class="stat-title">打回原因分类</div>
            <div v-for="cat in REJECT_CATEGORIES" :key="cat.id" class="bar-row">
              <span class="bar-label">{{ cat.label }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill danger"
                  :style="{ width: `${((stats.categoryCounts[cat.id] || 0) / stats.maxCategory) * 100}%` }"
                ></div>
              </div>
              <span class="bar-value">{{ stats.categoryCounts[cat.id] || 0 }}</span>
            </div>
          </div>

          <div class="stat-section">
            <div class="stat-title">审核人工作量</div>
            <div v-if="!stats.reviewerCounts.length" class="hint">暂无审核记录</div>
            <div v-for="[name, count] in stats.reviewerCounts" :key="name" class="people-row">
              <span>{{ name }}</span>
              <span class="mono">{{ count }} 帧</span>
            </div>
            <div class="stat-title" style="margin-top: 12px">提交人工作量</div>
            <div v-if="!stats.submitterCounts.length" class="hint">暂无提交记录</div>
            <div v-for="[name, count] in stats.submitterCounts" :key="`s-${name}`" class="people-row">
              <span>{{ name }}</span>
              <span class="mono">{{ count }} 帧</span>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top: 12px">
          <el-button size="small" @click="exportStats">导出统计 JSON</el-button>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<style scoped>
.wb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.wb-toolbar .spacer {
  flex: 1;
}

.wb-table-wrap {
  max-height: 52vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.wb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.wb-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-3);
  color: var(--text-dim);
  font-weight: 600;
  text-align: left;
  padding: 7px 8px;
  white-space: nowrap;
}

.wb-table td {
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}

.wb-table tbody tr:hover {
  background: var(--bg-2);
}

.wb-frame {
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-index {
  display: inline-block;
  min-width: 26px;
  margin-right: 6px;
  color: var(--accent);
  font-family: var(--mono, monospace);
}

.wb-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.wb-add {
  color: var(--success, #57d9a3);
  margin-right: 4px;
}

.wb-chg {
  color: var(--warning, #e6a23c);
  margin-right: 4px;
}

.wb-del {
  color: var(--danger);
}

.wb-warn {
  color: var(--warning, #e6a23c);
}

.wb-empty {
  text-align: center;
  color: var(--text-dim);
  padding: 24px !important;
}

.wb-foot {
  margin-top: 6px;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.stat-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 10px;
}

.stat-label {
  font-size: 11px;
  color: var(--text-dim);
}

.stat-value {
  margin-top: 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
}

.stat-value small {
  font-size: 11px;
  margin-left: 3px;
  color: var(--text-dim);
}

.stat-section {
  margin-top: 14px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
}

.stat-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.bar-label {
  width: 68px;
  color: var(--text-dim);
  flex: none;
}

.bar-track {
  flex: 1;
  height: 8px;
  background: var(--bg-3);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.2s;
}

.bar-fill.ok {
  background: var(--success, #57d9a3);
}

.bar-fill.pending {
  background: var(--warning, #e6a23c);
}

.bar-fill.danger {
  background: var(--danger);
}

.bar-fill.muted {
  background: var(--text-dim);
}

.bar-value {
  width: 34px;
  text-align: right;
  font-family: var(--mono, monospace);
  color: var(--text);
}

.stat-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.people-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--border);
}

.people-row:last-child {
  border-bottom: none;
}
</style>

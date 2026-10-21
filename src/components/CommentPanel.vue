<script setup>
/**
 * CommentPanel —— 帧级批注与审核
 *  - 当前帧独立提交 / 撤销 / 通过 / 打回 / 重新打开
 *  - 展示提交轮次、审核历史、本轮变更 diff
 *  - 批注支持定位与标记已解决
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state, currentFrame, selectedObjects, selectObject, store } from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import {
  canAnnotate,
  canComment,
  currentRole,
  currentUser,
  roleLabel,
  roleTagType,
} from '../stores/useAuthStore.js'
import {
  COMMENT_STATUS,
  COMMENT_STATUS_META,
  REJECT_CATEGORIES,
  rejectCategoryLabel,
} from '../stores/reviewCore.js'
import { openUi } from '../stores/useUiStore.js'
import {
  addComment,
  addCommentReply,
  approveAllFrames,
  approveFrame,
  batchSubmitSummary,
  canApproveAllFrames,
  canApproveCurrentFrame,
  canRejectCurrentFrame,
  canReopenCurrentFrame,
  canSubmitAllFrames,
  canSubmitCurrentFrame,
  canWithdrawAllFrames,
  canWithdrawCurrentFrame,
  currentFrameComments,
  currentFrameStatus,
  currentWorkflow,
  deleteComment,
  diffForFrame,
  isFrameLocked,
  loadReview,
  rejectFrame,
  reopenFrame,
  reviewSummary,
  setCommentCategory,
  statusLabel,
  statusType,
  submitAllFrames,
  submitFrame,
  submittedIndexes,
  updateCommentStatus,
  updateCommentText,
  withdrawAllFrames,
  withdrawFrame,
} from '../stores/useReviewStore.js'

const commentText = ref('')
const commentFilter = ref('all')
const replyingId = ref(null)
const replyText = ref('')
const rejectOpen = ref(false)
const rejectReason = ref('')
const rejectCategory = ref('other')

const HISTORY_META = {
  submitted: { label: '提交审核', type: 'warning' },
  approved: { label: '审核通过', type: 'success' },
  rejected: { label: '打回', type: 'danger' },
  withdrawn: { label: '撤销提交', type: 'info' },
  reopened: { label: '重新打开', type: 'info' },
  imported: { label: '导入重置', type: 'info' },
}

/** 批注目标：单选对象时挂到对象上，否则为帧级批注 */
const targetObject = computed(() => (selectedObjects.value.length === 1 ? selectedObjects.value[0] : null))
const targetLabel = computed(() => {
  const obj = targetObject.value
  if (!obj) return selectedObjects.value.length > 1 ? '多选对象（帧级批注）' : '当前帧（未选中对象）'
  return `${obj.type || 'Object'}${obj.trackId ? ` T${obj.trackId}` : ''}`
})

const locked = computed(() => isFrameLocked(state.currentIndex))
const lockText = computed(() => {
  if (currentFrameStatus.value === 'submitted') {
    return '本帧已提交，等待审核；标注员可撤销提交后继续编辑。'
  }
  if (currentFrameStatus.value === 'approved') {
    return '本帧已通过审核，已锁定；如需修改请联系管理员重新打开。'
  }
  return ''
})

const summary = computed(() => reviewSummary.value)
const currentUserName = computed(() => currentUser.value?.name || '')
const unresolvedCount = computed(
  () => currentFrameComments.value.filter((c) => c.status !== COMMENT_STATUS.DONE).length,
)

const sortedComments = computed(() => {
  const filtered =
    commentFilter.value === 'all'
      ? currentFrameComments.value
      : currentFrameComments.value.filter((c) => c.status === commentFilter.value)
  return filtered
    .slice()
    .sort(
      (a, b) =>
        Number(a.status === COMMENT_STATUS.DONE) - Number(b.status === COMMENT_STATUS.DONE) ||
        a.createdAt - b.createdAt,
    )
})

const historyEntries = computed(() => (currentWorkflow.value.history || []).slice().reverse())

const canManageComment = (comment) =>
  canComment.value || (comment.author && comment.author === currentUserName.value)

const canDeleteComment = (comment) =>
  comment.author === currentUserName.value || currentRole.value === 'admin'

const commentStatusMeta = (status) => COMMENT_STATUS_META[status] || COMMENT_STATUS_META.pending

const diffTitle = computed(() => {
  const workflow = currentWorkflow.value
  const diff = currentDiff.value
  if (!diff) return ''
  if (currentFrameStatus.value === 'submitted' || currentFrameStatus.value === 'approved') {
    return `第 ${workflow.round} 轮提交较第 ${diff.fromRound} 轮`
  }
  return `较第 ${workflow.round} 轮提交`
})

/** 提交/通过后展示提交时的 diff；打回/草稿时展示当前修改的实时 diff */
const currentDiff = computed(() => {
  const workflow = currentWorkflow.value
  const status = currentFrameStatus.value
  if (status === 'submitted' || status === 'approved') {
    return workflow.lastDiff || null
  }
  if (!workflow.baseline) return null
  const live = diffForFrame()
  return live ? { ...live, fromRound: workflow.round || 0 } : null
})

const diffItems = computed(() => {
  const diff = currentDiff.value
  if (!diff) return []
  const items = []
  for (const item of diff.added || []) items.push({ ...item, kind: 'added', op: '+' })
  for (const item of diff.changed || []) items.push({ ...item, kind: 'changed', op: '~' })
  for (const item of diff.removed || []) items.push({ ...item, kind: 'removed', op: '-' })
  return items.slice(0, 50)
})

const diffTotal = computed(() => {
  const diff = currentDiff.value
  if (!diff) return 0
  const counts = diff.counts || {}
  return (counts.added || 0) + (counts.changed || 0) + (counts.removed || 0)
})

watch(
  () => state.datasetName,
  (name) => {
    commentText.value = ''
    loadReview(name)
  },
  { immediate: true },
)

watch(
  () => state.currentIndex,
  () => {
    commentText.value = ''
    replyingId.value = null
    replyText.value = ''
  },
)

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function historyMeta(type) {
  return HISTORY_META[type] || { label: type, type: 'info' }
}

function changeCommentStatus(comment, status) {
  try {
    updateCommentStatus(comment.id, status)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function startReply(comment) {
  replyingId.value = replyingId.value === comment.id ? null : comment.id
  replyText.value = ''
}

function submitReply(comment) {
  try {
    addCommentReply(comment.id, replyText.value)
    replyText.value = ''
    replyingId.value = null
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function startEdit(comment) {
  try {
    const { value } = await ElMessageBox.prompt('修改批注内容', '编辑批注', {
      inputType: 'textarea',
      inputValue: comment.text,
      inputValidator: (v) => (String(v || '').trim() ? true : '批注内容不能为空'),
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    updateCommentText(comment.id, value)
    ElMessage.success('批注已更新')
  } catch {
    /* 取消 */
  }
}

async function removeComment(comment) {
  try {
    await ElMessageBox.confirm('确定删除这条批注及其回复？', '删除批注', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    deleteComment(comment.id)
    ElMessage.success('批注已删除')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function changeCategory(comment, category) {
  try {
    setCommentCategory(comment.id, category)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function openWorkbench() {
  openUi('workbenchOpen')
}

async function submitComment() {
  try {
    addComment(commentText.value)
    commentText.value = ''
    ElMessage.success('批注已添加')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function submitForReview() {
  const isRejected = currentFrameStatus.value === 'rejected'
  try {
    await ElMessageBox.confirm(
      isRejected
        ? '重新提交本帧后，批注员/管理员可以再次审核。确定提交？'
        : '提交后本帧将锁定，批注员/管理员可以审核并打回。确定提交本帧？',
      isRejected ? '重新提交审核' : '提交审核',
      { type: 'info', confirmButtonText: '提交', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    submitFrame()
    ElMessage.success(`本帧第 ${currentWorkflow.value.round} 轮已提交`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function withdrawCurrent() {
  try {
    await ElMessageBox.confirm('撤销后本帧回到未提交状态，可以继续编辑。确定撤销？', '撤销提交', {
      type: 'warning',
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    withdrawFrame()
    ElMessage.success('已撤销提交')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function submitAll() {
  const info = batchSubmitSummary.value
  if (!info.count) {
    ElMessage.warning('没有可提交的帧')
    return
  }
  const emptyHint = info.empty ? `；其中 ${info.empty} 帧没有标注对象` : ''
  try {
    await ElMessageBox.confirm(
      `将提交 ${info.count} 帧，跳过 ${info.skipped} 帧待审核/已通过${emptyHint}。提交后这些帧将锁定，确定？`,
      '提交全部帧',
      { type: 'info', confirmButtonText: '全部提交', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const result = submitAllFrames()
    ElMessage.success(
      `已提交 ${result.submitted} 帧${result.skipped ? `，跳过 ${result.skipped} 帧` : ''}`,
    )
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function withdrawAll() {
  const count = submittedIndexes.value.length
  if (!count) {
    ElMessage.warning('没有待审核的帧')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将撤销 ${count} 帧的提交，回到未提交状态并可继续编辑，确定？`,
      '撤销全部提交',
      { type: 'warning', confirmButtonText: '全部撤销', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const result = withdrawAllFrames()
    ElMessage.success(`已撤销 ${result.withdrawn} 帧提交`)
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function approveAll() {
  const count = submittedIndexes.value.length
  if (!count) {
    ElMessage.warning('没有待审核的帧')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将通过 ${count} 帧待审核标注，通过后这些帧将锁定，确定？`,
      '全部通过',
      { type: 'success', confirmButtonText: '全部通过', cancelButtonText: '取消' },
    )
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

async function approveCurrent() {
  try {
    await ElMessageBox.confirm('通过后本帧将锁定，标注员不能再修改。确定通过？', '审核通过', {
      type: 'success',
      confirmButtonText: '通过',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    approveFrame()
    ElMessage.success('已通过审核')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

function openRejectDialog() {
  rejectReason.value = ''
  rejectCategory.value = 'other'
  rejectOpen.value = true
}

function confirmReject() {
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请输入打回原因')
    return
  }
  try {
    rejectFrame(rejectReason.value, state.currentIndex, rejectCategory.value)
    rejectOpen.value = false
    ElMessage.success('已打回，标注员可继续修改')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

async function reopenCurrent() {
  let value = ''
  try {
    const result = await ElMessageBox.prompt('重新打开后本帧回到未提交状态，可填写原因。', '重新打开', {
      inputType: 'textarea',
      inputPlaceholder: '可选：说明重新打开的原因',
      confirmButtonText: '重新打开',
      cancelButtonText: '取消',
      type: 'warning',
    })
    value = result.value
  } catch {
    return
  }
  try {
    reopenFrame(state.currentIndex, value)
    ElMessage.success('已重新打开')
  } catch (err) {
    ElMessage.warning(err.message || String(err))
  }
}

/** 切换到批注所在帧并选中关联对象 */
async function locateComment(comment) {
  if (comment.frameIndex !== state.currentIndex) {
    store.setCurrentIndex(comment.frameIndex)
    await nextTick()
  }
  if (!comment.objectId) return
  const obj = state.frames[state.currentIndex]?.objects.find((o) => o.id === comment.objectId)
  if (!obj) {
    ElMessage.info('批注关联的对象已不存在')
    return
  }
  selectObject(obj.id)
  viewerRef.current?.focusObject?.(obj)
}

function locateDiffItem(item) {
  if (item.kind === 'removed') {
    ElMessage.info('该对象已删除，无法定位')
    return
  }
  const obj = state.frames[state.currentIndex]?.objects.find((o) => o.id === item.id)
  if (!obj) {
    ElMessage.info('对象已不在当前帧')
    return
  }
  selectObject(obj.id)
  viewerRef.current?.focusObject?.(obj)
}
</script>

<template>
  <div class="section">
    <h3 class="section-title">
      <span>批注与审核</span>
      <span class="row" style="gap: 4px">
        <el-tag v-if="currentUser" size="small" :type="roleTagType(currentUser.role)" effect="plain">
          {{ roleLabel(currentUser.role) }}
        </el-tag>
        <el-button link size="small" @click="openWorkbench">工作台</el-button>
      </span>
    </h3>

    <div class="review-summary">
      <span class="summary-item">共 {{ summary.total }} 帧</span>
      <span class="summary-item ok">已通过 {{ summary.approved }}</span>
      <span class="summary-item pending">待审核 {{ summary.submitted }}</span>
      <span class="summary-item danger">打回 {{ summary.rejected }}</span>
    </div>

    <div class="review-status">
      <el-tag size="small" :type="statusType" effect="dark">{{ statusLabel }}</el-tag>
      <span v-if="currentWorkflow.round" class="hint">第 {{ currentWorkflow.round }} 轮</span>
      <span v-if="currentWorkflow.submittedBy" class="hint">
        由 {{ currentWorkflow.submittedBy }} 提交
      </span>
      <span v-if="currentWorkflow.reviewedBy" class="hint">
        · {{ currentWorkflow.reviewedBy }} 审核
      </span>
    </div>

    <div v-if="locked" class="lock-box">
      <div class="lock-title">{{ currentFrameStatus === 'approved' ? '已通过锁定' : '待审核锁定' }}</div>
      <div>{{ lockText }}</div>
    </div>

    <div v-if="currentWorkflow.status === 'rejected' && currentWorkflow.reason" class="reject-box">
      <div class="reject-title">打回原因</div>
      <div>{{ currentWorkflow.reason }}</div>
    </div>

    <div v-if="currentDiff" class="diff-box">
      <div class="diff-head">
        <span>{{ diffTitle }}</span>
        <span class="diff-counts">
          <span class="added">+{{ currentDiff.counts?.added || 0 }}</span>
          <span class="changed">~{{ currentDiff.counts?.changed || 0 }}</span>
          <span class="removed">-{{ currentDiff.counts?.removed || 0 }}</span>
        </span>
      </div>
      <div v-if="diffTotal" class="diff-list">
        <div
          v-for="item in diffItems"
          :key="`${item.kind}:${item.id}`"
          class="diff-item"
          :class="item.kind"
          @click="locateDiffItem(item)"
        >
          <span class="diff-op">{{ item.op }}</span>
          <span class="diff-label">{{ item.label }}</span>
        </div>
      </div>
      <div v-else class="hint diff-empty">与上次提交相比没有对象变化</div>
    </div>

    <el-collapse v-if="historyEntries.length" class="review-history">
      <el-collapse-item :title="`审核历史（${historyEntries.length}）`" name="history">
        <div v-for="(item, index) in historyEntries" :key="index" class="history-item">
          <div class="history-head">
            <el-tag size="small" :type="historyMeta(item.type).type" effect="plain">
              {{ historyMeta(item.type).label }}
            </el-tag>
            <span class="history-actor">{{ item.actor || '未知用户' }}</span>
            <span class="hint">{{ formatTime(item.at) }}</span>
          </div>
          <div v-if="item.reason" class="history-reason">{{ item.reason }}</div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <div class="comment-head">
      <span class="hint">本帧批注</span>
      <span class="comment-count">{{ currentFrameComments.length }}</span>
      <span v-if="unresolvedCount" class="hint unresolved-hint">未解决 {{ unresolvedCount }}</span>
      <span class="spacer" style="flex: 1"></span>
      <el-select v-model="commentFilter" size="small" style="width: 92px">
        <el-option label="全部状态" value="all" />
        <el-option label="待处理" value="pending" />
        <el-option label="处理中" value="in_progress" />
        <el-option label="已完成" value="done" />
      </el-select>
    </div>

    <div v-if="!sortedComments.length" class="hint comment-empty">
      {{
        currentFrame
          ? currentFrameComments.length
            ? '没有符合筛选条件的批注'
            : '本帧暂无批注'
          : '请先加载数据'
      }}
    </div>
    <div v-else class="comment-list">
      <div
        v-for="c in sortedComments"
        :key="c.id"
        class="comment-item"
        :class="{
          rejection: c.kind === 'rejection',
          resolved: c.status === 'done',
        }"
      >
        <div class="comment-meta">
          <span class="comment-author">{{ c.author }}</span>
          <el-tag size="small" :type="roleTagType(c.role)" effect="plain">
            {{ roleLabel(c.role) }}
          </el-tag>
          <el-tag v-if="c.objectLabel" size="small" type="info" effect="plain">
            {{ c.objectLabel }}
          </el-tag>
          <el-tag
            size="small"
            :type="commentStatusMeta(c.status).type"
            effect="plain"
          >
            {{ commentStatusMeta(c.status).label }}
          </el-tag>
          <el-tag v-if="c.category" size="small" type="warning" effect="plain">
            {{ rejectCategoryLabel(c.category) }}
          </el-tag>
          <span class="hint">{{ formatTime(c.createdAt) }}</span>
        </div>
        <div class="comment-text">{{ c.text }}</div>

        <div v-if="c.replies?.length" class="comment-replies">
          <div v-for="reply in c.replies" :key="reply.id" class="comment-reply">
            <span class="reply-author">{{ reply.author }}</span>
            <span class="hint">{{ formatTime(reply.createdAt) }}</span>
            <div class="reply-text">{{ reply.text }}</div>
          </div>
        </div>

        <div v-if="replyingId === c.id" class="reply-editor">
          <el-input
            v-model="replyText"
            type="textarea"
            :rows="2"
            maxlength="1000"
            placeholder="回复这条批注…"
            @keyup.ctrl.enter="submitReply(c)"
          />
          <div class="row" style="margin-top: 4px">
            <el-button size="small" type="primary" plain :disabled="!replyText.trim()" @click="submitReply(c)">
              发送回复
            </el-button>
            <el-button size="small" @click="replyingId = null">取消</el-button>
          </div>
        </div>

        <div class="comment-actions">
          <el-button link size="small" @click="locateComment(c)">定位</el-button>
          <el-button link size="small" @click="startReply(c)">
            {{ replyingId === c.id ? '收起回复' : '回复' }}
          </el-button>
          <el-select
            v-if="canManageComment(c)"
            :model-value="c.status"
            size="small"
            style="width: 86px"
            @change="(v) => changeCommentStatus(c, v)"
          >
            <el-option label="待处理" value="pending" />
            <el-option label="处理中" value="in_progress" />
            <el-option label="已完成" value="done" />
          </el-select>
          <el-select
            v-if="canComment"
            :model-value="c.category"
            size="small"
            clearable
            placeholder="分类"
            style="width: 86px"
            @change="(v) => changeCategory(c, v)"
          >
            <el-option
              v-for="cat in REJECT_CATEGORIES"
              :key="cat.id"
              :label="cat.label"
              :value="cat.id"
            />
          </el-select>
          <el-button v-if="canDeleteComment(c)" link size="small" @click="startEdit(c)">编辑</el-button>
          <el-button v-if="canDeleteComment(c)" link type="danger" size="small" @click="removeComment(c)">
            删除
          </el-button>
        </div>
      </div>
    </div>

    <template v-if="canComment">
      <div class="comment-target">
        <span class="hint">批注对象</span>
        <el-tag v-if="targetObject" size="small" type="info" effect="plain">{{ targetLabel }}</el-tag>
        <span v-else class="hint">{{ targetLabel }}</span>
      </div>
      <el-input
        v-model="commentText"
        type="textarea"
        :rows="2"
        maxlength="500"
        show-word-limit
        placeholder="针对当前帧添加批注…"
        style="margin-top: 10px"
      />
      <div class="row" style="margin-top: 8px">
        <el-button size="small" type="primary" plain :disabled="!commentText.trim()" @click="submitComment">
          添加批注
        </el-button>
      </div>
    </template>
    <div v-else-if="currentUser" class="hint" style="margin-top: 10px">
      标注员只能查看批注并标记自己提出的批注，提交后由批注员/管理员审核。
    </div>
    <div v-else class="hint" style="margin-top: 10px">请先登录后使用批注与审核功能。</div>

    <div class="row review-actions">
      <el-button
        v-if="canAnnotate"
        size="small"
        type="primary"
        :disabled="!canSubmitCurrentFrame"
        @click="submitForReview"
      >
        {{ currentFrameStatus === 'rejected' ? '重新提交' : '提交本帧' }}
      </el-button>
      <el-button
        v-if="canAnnotate"
        size="small"
        :disabled="!canWithdrawCurrentFrame"
        @click="withdrawCurrent"
      >
        撤销提交
      </el-button>
      <el-button
        v-if="canComment"
        size="small"
        type="success"
        :disabled="!canApproveCurrentFrame"
        @click="approveCurrent"
      >
        通过
      </el-button>
      <el-button
        v-if="canComment"
        size="small"
        type="danger"
        plain
        :disabled="!canRejectCurrentFrame"
        @click="openRejectDialog"
      >
        打回
      </el-button>
      <el-button
        v-if="currentRole === 'admin'"
        size="small"
        :disabled="!canReopenCurrentFrame"
        @click="reopenCurrent"
      >
        重新打开
      </el-button>
    </div>

    <div v-if="canAnnotate || canComment" class="batch-actions">
      <span class="hint batch-title">批量</span>
      <el-button
        v-if="canAnnotate"
        size="small"
        type="primary"
        plain
        :disabled="!canSubmitAllFrames"
        @click="submitAll"
      >
        提交全部（{{ batchSubmitSummary.count }}）
      </el-button>
      <el-button
        v-if="canAnnotate"
        size="small"
        :disabled="!canWithdrawAllFrames"
        @click="withdrawAll"
      >
        撤销全部（{{ submittedIndexes.length }}）
      </el-button>
      <el-button
        v-if="canComment"
        size="small"
        type="success"
        plain
        :disabled="!canApproveAllFrames"
        @click="approveAll"
      >
        全部通过（{{ submittedIndexes.length }}）
      </el-button>
    </div>

    <el-dialog v-model="rejectOpen" title="打回提交" width="420px" append-to-body>
      <div class="field" style="margin-bottom: 10px">
        <label>打回分类</label>
        <el-select v-model="rejectCategory" style="width: 100%">
          <el-option v-for="cat in REJECT_CATEGORIES" :key="cat.id" :label="cat.label" :value="cat.id" />
        </el-select>
      </div>
      <div class="field">
        <label>打回原因</label>
        <el-input
          v-model="rejectReason"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          placeholder="例如：第 3 帧车辆框未贴地，请修改后重新提交"
        />
      </div>
      <template #footer>
        <el-button @click="rejectOpen = false">取消</el-button>
        <el-button type="danger" :disabled="!rejectReason.trim()" @click="confirmReject">打回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.review-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 11px;
}

.summary-item {
  padding: 2px 6px;
  border-radius: 9px;
  background: var(--bg-3);
  color: var(--text-dim);
}

.summary-item.ok {
  color: var(--success, #57d9a3);
}

.summary-item.pending {
  color: var(--warning, #e6a23c);
}

.summary-item.danger {
  color: var(--danger);
}

.review-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.lock-box {
  border-left: 3px solid var(--warning, #e6a23c);
  background: rgba(230, 162, 60, 0.1);
  border-radius: 4px;
  padding: 7px 9px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text);
}

.lock-title {
  color: var(--warning, #e6a23c);
  font-weight: 600;
  margin-bottom: 3px;
}

.reject-box {
  border-left: 3px solid var(--danger);
  background: rgba(255, 107, 107, 0.1);
  border-radius: 4px;
  padding: 7px 9px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text);
}

.reject-title {
  color: var(--danger);
  font-weight: 600;
  margin-bottom: 3px;
}

.diff-box {
  border: 1px solid var(--border);
  background: var(--bg-2);
  border-radius: 6px;
  padding: 7px 9px;
  margin-bottom: 10px;
  font-size: 12px;
}

.diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text);
  font-weight: 600;
}

.diff-counts {
  display: flex;
  gap: 6px;
  font-family: var(--mono, monospace);
  font-size: 11px;
}

.diff-counts .added,
.diff-item.added .diff-op {
  color: var(--success, #57d9a3);
}

.diff-counts .changed,
.diff-item.changed .diff-op {
  color: var(--warning, #e6a23c);
}

.diff-counts .removed,
.diff-item.removed .diff-op {
  color: var(--danger);
}

.diff-list {
  margin-top: 6px;
  max-height: 130px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.diff-item {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text-dim);
}

.diff-item.removed {
  cursor: default;
}

.diff-op {
  width: 10px;
  text-align: center;
  font-family: var(--mono, monospace);
}

.diff-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-empty {
  margin-top: 5px;
}

.review-history {
  margin-bottom: 10px;
  border-top: none;
  border-bottom: none;
}

.review-history :deep(.el-collapse-item__header) {
  height: 30px;
  line-height: 30px;
  font-size: 12px;
  background: transparent;
  color: var(--text-dim);
}

.review-history :deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: none;
}

.review-history :deep(.el-collapse-item__content) {
  padding-bottom: 6px;
}

.history-item {
  padding: 5px 0;
  border-bottom: 1px dashed var(--border);
}

.history-item:last-child {
  border-bottom: none;
}

.history-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.history-actor {
  font-size: 12px;
  color: var(--text);
}

.history-reason {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  white-space: pre-wrap;
}

.comment-target {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.comment-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.comment-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-3);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.unresolved-hint {
  color: var(--warning, #e6a23c);
}

.comment-empty {
  padding: 6px 0 8px;
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 230px;
  overflow-y: auto;
  padding-right: 2px;
}

.comment-item {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
}

.comment-item.resolved {
  opacity: 0.6;
}

.comment-item.rejection {
  border-color: rgba(255, 107, 107, 0.55);
  background: rgba(255, 107, 107, 0.08);
}

.comment-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.comment-author {
  color: var(--text);
  font-weight: 600;
  font-size: 12px;
}

.comment-text {
  color: var(--text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.comment-replies {
  margin-top: 6px;
  padding-left: 8px;
  border-left: 2px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.comment-reply {
  font-size: 12px;
}

.reply-author {
  color: var(--text);
  font-weight: 600;
  margin-right: 6px;
}

.reply-text {
  color: var(--text-dim);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.reply-editor {
  margin-top: 6px;
}

.comment-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.review-actions {
  margin-top: 10px;
  flex-wrap: wrap;
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.batch-title {
  margin-right: 2px;
}
</style>

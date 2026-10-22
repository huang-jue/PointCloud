/**
 * useReviewStore —— 帧级批注、提交、审核状态（纯前端持久化）
 *
 * 存储结构（schemaVersion=2）：
 *   {
 *     schemaVersion: 2,
 *     updatedAt,
 *     workflows: {
 *       "0": {
 *         status: 'draft' | 'submitted' | 'approved' | 'rejected',
 *         round, submittedBy, submittedAt, reviewedBy, reviewedAt, reason,
 *         baseline: { ids, sigs, labels },
 *         lastDiff: { fromRound, added, removed, changed, labelDelta },
 *         updatedAt, history: [{ type, actor, role, at, round, reason? }]
 *       }
 *     },
 *     comments: [{ id, frameIndex, ..., resolved, round, updatedAt }]
 *   }
 *
 * 兼容 v1 的整集 workflow：读取时铺到所有帧上。
 * 数据保存在 localStorage，多个标签页通过 storage 事件合并（用户身份在 sessionStorage）。
 */
import { computed, watch } from 'vue'
import { state, selectedObjects } from './useAnnotationStore.js'
import { canAnnotate, canComment, canReview, currentRole, currentUser } from './useAuthStore.js'
import { uid } from '../utils/id.js'
import { diffSnapshots, snapshotFrame } from '../utils/diff.js'
import { saveVersion } from '../utils/versionDb.js'
import {
  COMMENT_STATUS,
  REJECT_CATEGORIES,
  REVIEW_SCHEMA_VERSION,
  STATUS,
  cloneWorkflow,
  defaultWorkflow,
  frameStatus,
  frameWorkflow,
  isFrameLocked,
  normalizeComments,
  normalizeWorkflow,
  reviewState,
  statusLabelOf,
  statusTypeOf,
} from './reviewCore.js'

export {
  COMMENT_STATUS,
  REJECT_CATEGORIES,
  reviewState,
  frameStatus,
  frameWorkflow,
  isFrameLocked,
  statusLabelOf,
  statusTypeOf,
}

const STORAGE_PREFIX = 'pc-annotate-review:'
const EMPTY_WORKFLOW = Object.freeze(defaultWorkflow())
let pendingLegacyWorkflow = null

function storageKey(dataset) {
  return `${STORAGE_PREFIX}${encodeURIComponent(dataset || '')}`
}

function currentStorageKey() {
  return reviewState.dataset ? storageKey(reviewState.dataset) : ''
}

function nowStamp(previous = 0) {
  return Math.max(Date.now(), Number(previous || 0) + 1)
}

function clearInMemory() {
  reviewState.workflows = {}
  reviewState.comments = []
  reviewState.updatedAt = 0
  reviewState.storageError = ''
  reviewState.mergeWarning = ''
  pendingLegacyWorkflow = null
}

function workflowForWrite(frameIndex) {
  const key = String(frameIndex)
  if (!reviewState.workflows[key]) reviewState.workflows[key] = defaultWorkflow()
  return reviewState.workflows[key]
}

function frameAt(frameIndex) {
  return state.frames[frameIndex] || null
}

function rememberFrameVersion(frameIndex, kind) {
  const frame = frameAt(frameIndex)
  if (!frame) return
  saveVersion({
    dataset: reviewState.dataset || state.datasetName || 'local',
    frameIndex,
    round: frameWorkflow(frameIndex)?.round || 0,
    kind,
    actor: currentUser.value?.name || '',
    objects: frame.objects,
  }).catch(() => {
    /* IndexedDB 不可用时忽略 */
  })
}

function pushHistory(workflow, type, at, extra = {}) {
  const user = currentUser.value
  workflow.history.push({
    type,
    actor: user?.name || '',
    role: user?.role || '',
    at,
    round: workflow.round || 0,
    ...extra,
  })
}

/** 把 v1 的整集 workflow 转成单帧结构 */
function legacyWorkflow(value) {
  const status = value?.status || STATUS.DRAFT
  const round = status === STATUS.DRAFT ? 0 : 1
  const at = value?.reviewedAt || value?.submittedAt || Date.now()
  const history = []
  if (value?.submittedAt) {
    history.push({
      type: 'submitted',
      actor: String(value.submittedBy || ''),
      role: 'annotator',
      at: value.submittedAt,
      round,
    })
  }
  if (status === STATUS.REJECTED && value?.reviewedAt) {
    history.push({
      type: 'rejected',
      actor: String(value.reviewedBy || ''),
      role: 'reviewer',
      at: value.reviewedAt,
      round,
      reason: value.reason ? String(value.reason) : undefined,
    })
  }
  return normalizeWorkflow({
    ...value,
    status,
    round,
    history,
    updatedAt: at,
  })
}

function parseReviewData(data) {
  if (!data || typeof data !== 'object') {
    return { workflows: {}, comments: [], legacy: null, updatedAt: 0 }
  }
  if (data.workflows && typeof data.workflows === 'object') {
    const workflows = {}
    for (const [key, value] of Object.entries(data.workflows)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) continue
      workflows[String(index)] = normalizeWorkflow(value)
    }
    return {
      workflows,
      comments: normalizeComments(data.comments),
      legacy: null,
      updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
    }
  }
  return {
    workflows: {},
    comments: normalizeComments(data.comments),
    legacy: data.workflow && typeof data.workflow === 'object' ? legacyWorkflow(data.workflow) : null,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
  }
}

function materializeLegacy(workflow) {
  if (!workflow) return
  if (!state.frames.length) {
    pendingLegacyWorkflow = workflow
    return
  }
  for (let i = 0; i < state.frames.length; i++) {
    reviewState.workflows[String(i)] = cloneWorkflow(workflow)
  }
  pendingLegacyWorkflow = null
}

function applyParsed(parsed) {
  reviewState.workflows = {}
  reviewState.comments = []
  pendingLegacyWorkflow = null
  if (parsed.legacy) {
    materializeLegacy(parsed.legacy)
  } else {
    reviewState.workflows = parsed.workflows
  }
  reviewState.comments = parsed.comments
  reviewState.updatedAt = parsed.updatedAt || 0
}

/** 切换数据集时载入对应批注/审核记录 */
export function loadReview(dataset) {
  const name = dataset || ''
  if (reviewState.dataset === name) return
  reviewState.dataset = name
  reviewState.schemaVersion = REVIEW_SCHEMA_VERSION
  clearInMemory()
  if (!name) return
  try {
    const raw = localStorage.getItem(storageKey(name))
    if (!raw) return
    const parsed = parseReviewData(JSON.parse(raw))
    applyParsed(parsed)
    // 旧格式已铺到各帧时立即写回 v2；帧尚未加载则等 watcher 处理
    if (parsed.legacy && state.frames.length) saveReview({ merge: false })
  } catch {
    /* 损坏的记录直接忽略 */
  }
}

/** 导入/读取到新帧后，把 v1 的整集状态铺开 */
watch(
  () => state.frames.length,
  (length) => {
    if (!length || !pendingLegacyWorkflow) return
    const workflow = pendingLegacyWorkflow
    pendingLegacyWorkflow = null
    materializeLegacy(workflow)
    saveReview({ merge: false })
  },
)

export function saveReview({ merge = true } = {}) {
  if (!reviewState.dataset) return
  const key = currentStorageKey()
  if (merge) {
    // 写入前先吸收其他标签页的最新状态，避免覆盖并发操作
    try {
      const raw = localStorage.getItem(key)
      if (raw) mergeRemote(parseReviewData(JSON.parse(raw)))
    } catch {
      /* 忽略损坏数据 */
    }
  }
  reviewState.updatedAt = nowStamp(reviewState.updatedAt)
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        dataset: reviewState.dataset,
        updatedAt: reviewState.updatedAt,
        workflows: reviewState.workflows,
        comments: reviewState.comments,
      }),
    )
    reviewState.storageError = ''
  } catch (err) {
    const quota = err?.name === 'QuotaExceededError' || err?.code === 22
    reviewState.storageError = quota
      ? '本地存储空间不足，批注/审核记录未能保存；请导出数据后清理浏览器存储'
      : `批注/审核记录保存失败：${err?.message || String(err)}`
  }
}

/* ---------------- 跨标签页同步 ---------------- */

/** 两个标签页对同一帧给出不同的终态（通过/打回）才是需要提示的冲突 */
function isConflictingStatus(a, b) {
  const terminal = new Set([STATUS.APPROVED, STATUS.REJECTED])
  return terminal.has(a) && terminal.has(b) && a !== b
}

function mergeRemote(parsed) {
  const next = { ...reviewState.workflows }
  if (parsed.legacy) {
    // 另一个标签页还是旧格式：只在没有本地记录时铺开
    if (state.frames.length) {
      for (let i = 0; i < state.frames.length; i++) {
        const key = String(i)
        if (!next[key]) next[key] = cloneWorkflow(parsed.legacy)
      }
    }
  } else {
    for (const [key, workflow] of Object.entries(parsed.workflows)) {
      const local = next[key]
      if (!local || (workflow.updatedAt || 0) > (local.updatedAt || 0)) {
        if (
          local &&
          isConflictingStatus(local.status, workflow.status) &&
          (workflow.updatedAt || 0) > (local.updatedAt || 0)
        ) {
          reviewState.mergeWarning = `检测到其他标签页并发修改第 ${Number(key) + 1} 帧的审核结果，已采用较新的记录`
        }
        next[key] = workflow
      }
    }
  }
  reviewState.workflows = next

  const comments = new Map(reviewState.comments.map((c) => [c.id, c]))
  for (const comment of parsed.comments) {
    const local = comments.get(comment.id)
    const localAt = local ? local.updatedAt || local.createdAt || 0 : -1
    const remoteAt = comment.updatedAt || comment.createdAt || 0
    if (!local || remoteAt >= localAt) comments.set(comment.id, comment)
  }
  reviewState.comments = Array.from(comments.values())
  reviewState.updatedAt = Math.max(reviewState.updatedAt, parsed.updatedAt || 0)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!reviewState.dataset || event.key !== currentStorageKey()) return
    if (event.newValue == null) {
      clearInMemory()
      return
    }
    try {
      mergeRemote(parseReviewData(JSON.parse(event.newValue)))
    } catch {
      /* 忽略无效数据 */
    }
  })
}

/* ---------------- 派生状态 ---------------- */

/** 当前帧的批注（按时间正序） */
export const currentFrameComments = computed(() =>
  reviewState.comments
    .filter((c) => c.frameIndex === state.currentIndex)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt),
)

export const currentWorkflow = computed(
  () => frameWorkflow(state.currentIndex) || EMPTY_WORKFLOW,
)

export const currentFrameStatus = computed(() => currentWorkflow.value.status)

export const statusLabel = computed(() => statusLabelOf(currentFrameStatus.value))
export const statusType = computed(() => statusTypeOf(currentFrameStatus.value))

export const canEditCurrentFrame = computed(
  () => canAnnotate.value && !isFrameLocked(state.currentIndex),
)

export const canSubmitCurrentFrame = computed(
  () =>
    canAnnotate.value &&
    (currentFrameStatus.value === STATUS.DRAFT || currentFrameStatus.value === STATUS.REJECTED) &&
    state.frames.length > 0 &&
    !state.gtLoading,
)
export const canWithdrawCurrentFrame = computed(
  () => canAnnotate.value && currentFrameStatus.value === STATUS.SUBMITTED,
)
export const canApproveCurrentFrame = computed(
  () => canReview.value && currentFrameStatus.value === STATUS.SUBMITTED && !state.gtLoading,
)
export const canRejectCurrentFrame = computed(
  () => canReview.value && currentFrameStatus.value === STATUS.SUBMITTED && !state.gtLoading,
)
export const canReopenCurrentFrame = computed(
  () => currentRole.value === 'admin' && currentFrameStatus.value === STATUS.APPROVED,
)

/** 数据集维度的审核进度汇总 */
export const reviewSummary = computed(() => {
  const counts = { total: state.frames.length, draft: 0, submitted: 0, approved: 0, rejected: 0 }
  for (let i = 0; i < state.frames.length; i++) {
    counts[frameStatus(i)] = (counts[frameStatus(i)] || 0) + 1
  }
  return counts
})

/** 批量提交范围：所有未提交 / 已打回的帧（含空帧） */
export const batchSubmitSummary = computed(() => {
  const indexes = []
  let objects = 0
  let empty = 0
  for (let i = 0; i < state.frames.length; i++) {
    const status = frameStatus(i)
    if (status !== STATUS.DRAFT && status !== STATUS.REJECTED) continue
    indexes.push(i)
    const count = state.frames[i].objects?.length || 0
    objects += count
    if (!count) empty++
  }
  return {
    indexes,
    count: indexes.length,
    total: state.frames.length,
    skipped: state.frames.length - indexes.length,
    objects,
    empty,
  }
})

/** 所有待审核帧，供“全部通过 / 撤销全部”使用 */
export const submittedIndexes = computed(() => {
  const indexes = []
  for (let i = 0; i < state.frames.length; i++) {
    if (frameStatus(i) === STATUS.SUBMITTED) indexes.push(i)
  }
  return indexes
})

export const canSubmitAllFrames = computed(
  () => canAnnotate.value && !state.gtLoading && batchSubmitSummary.value.count > 0,
)
export const canWithdrawAllFrames = computed(
  () => canAnnotate.value && submittedIndexes.value.length > 0,
)
export const canApproveAllFrames = computed(
  () => canReview.value && !state.gtLoading && submittedIndexes.value.length > 0,
)

/** 当前帧批注数量（供时间轴/列表使用） */
export function commentCountForFrame(frameIndex) {
  return reviewState.comments.filter((c) => c.frameIndex === frameIndex).length
}

export function unresolvedCommentCountForFrame(frameIndex) {
  return reviewState.comments.filter(
    (c) => c.frameIndex === frameIndex && c.status !== COMMENT_STATUS.DONE && !c.resolved,
  ).length
}

/* ---------------- 批注 ---------------- */

/** 当前单选对象（多选或未选中时批注属于整帧） */
function currentCommentTarget() {
  const list = selectedObjects.value
  if (list.length !== 1) return null
  const obj = list[0]
  return {
    objectId: obj.id,
    objectLabel: `${obj.type || 'Object'}${obj.trackId ? ` T${obj.trackId}` : ''}`,
    objectShape: obj.shape === 'line' || obj.shape === 'arrow' ? obj.shape : 'box',
  }
}

/** 添加一条批注（批注员/管理员） */
export function addComment(text) {
  if (!canComment.value || !currentUser.value) throw new Error('当前角色不能添加批注')
  const content = String(text || '').trim().slice(0, 2000)
  if (!content) throw new Error('批注内容不能为空')
  const frame = frameAt(state.currentIndex)
  if (!frame) throw new Error('当前没有可批注的帧')
  const target = currentCommentTarget()
  const workflow = frameWorkflow(state.currentIndex)
  const now = nowStamp()
  const comment = {
    id: uid('cmt'),
    frameIndex: state.currentIndex,
    frameName: frame.name,
    ...(target || {}),
    text: content,
    kind: 'comment',
    author: currentUser.value.name,
    role: currentUser.value.role,
    createdAt: now,
    updatedAt: now,
    round: workflow?.round || 0,
    status: COMMENT_STATUS.PENDING,
    category: null,
    replies: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  }
  reviewState.comments.push(comment)
  saveReview()
  return comment
}

function canManageComment(comment, user) {
  if (!comment || !user) return false
  return canComment.value || comment.author === user.name
}

/** 修改批注处理状态 */
export function updateCommentStatus(id, status) {
  const comment = reviewState.comments.find((c) => c.id === id)
  if (!comment) return null
  const user = currentUser.value
  if (!user) throw new Error('请先登录')
  if (!canManageComment(comment, user)) throw new Error('没有权限修改该批注')
  if (!Object.values(COMMENT_STATUS).includes(status)) throw new Error('无效的批注状态')
  const now = nowStamp(comment.updatedAt || comment.createdAt)
  comment.status = status
  comment.resolved = status === COMMENT_STATUS.DONE
  comment.resolvedBy = comment.resolved ? user.name : null
  comment.resolvedAt = comment.resolved ? now : null
  comment.updatedAt = now
  saveReview()
  return comment
}

/** 标记批注已解决 / 取消解决（兼容旧接口） */
export function resolveComment(id, resolved = true) {
  return updateCommentStatus(id, resolved ? COMMENT_STATUS.DONE : COMMENT_STATUS.PENDING)
}

/** 回复批注（所有登录角色都可以参与讨论） */
export function addCommentReply(id, text) {
  const comment = reviewState.comments.find((c) => c.id === id)
  if (!comment) throw new Error('批注不存在')
  const user = currentUser.value
  if (!user) throw new Error('请先登录后回复')
  const content = String(text || '').trim().slice(0, 1000)
  if (!content) throw new Error('回复内容不能为空')
  if (!Array.isArray(comment.replies)) comment.replies = []
  const now = nowStamp(comment.updatedAt || comment.createdAt)
  comment.replies.push({
    id: uid('rep'),
    author: user.name,
    role: user.role,
    text: content,
    createdAt: now,
  })
  comment.updatedAt = now
  saveReview()
  return comment
}

/** 编辑批注正文（作者或管理员） */
export function updateCommentText(id, text) {
  const comment = reviewState.comments.find((c) => c.id === id)
  if (!comment) throw new Error('批注不存在')
  const user = currentUser.value
  if (!user) throw new Error('请先登录')
  if (comment.author !== user.name && currentRole.value !== 'admin') {
    throw new Error('只有批注作者或管理员可以编辑')
  }
  const content = String(text || '').trim().slice(0, 2000)
  if (!content) throw new Error('批注内容不能为空')
  comment.text = content
  comment.updatedAt = nowStamp(comment.updatedAt || comment.createdAt)
  saveReview()
  return comment
}

/** 删除批注（作者或管理员） */
export function deleteComment(id) {
  const user = currentUser.value
  if (!user) throw new Error('请先登录')
  const index = reviewState.comments.findIndex((c) => c.id === id)
  if (index === -1) return false
  const comment = reviewState.comments[index]
  if (comment.author !== user.name && currentRole.value !== 'admin') {
    throw new Error('只有批注作者或管理员可以删除')
  }
  reviewState.comments.splice(index, 1)
  saveReview()
  return true
}

/** 设置打回分类 */
export function setCommentCategory(id, category) {
  const comment = reviewState.comments.find((c) => c.id === id)
  if (!comment) return null
  if (!canComment.value) throw new Error('当前角色不能修改分类')
  if (category && !REJECT_CATEGORIES.some((c) => c.id === category)) {
    throw new Error('无效的打回分类')
  }
  comment.category = category || null
  comment.updatedAt = nowStamp(comment.updatedAt || comment.createdAt)
  saveReview()
  return comment
}

/* ---------------- 审核流程 ---------------- */

/** 提交单帧（不落盘，批量提交复用） */
function commitSubmit(frameIndex) {
  const frame = frameAt(frameIndex)
  if (!frame) throw new Error('当前没有可提交的帧')
  const workflow = workflowForWrite(frameIndex)
  if (workflow.status !== STATUS.DRAFT && workflow.status !== STATUS.REJECTED) {
    throw new Error('当前帧已提交或已通过，无需重复提交')
  }

  const snapshot = snapshotFrame(frame)
  const previous = workflow.baseline
  const lastDiff = previous
    ? { fromRound: workflow.round || 0, ...diffSnapshots(previous, snapshot) }
    : null
  const now = nowStamp(workflow.updatedAt)
  const nextRound = (workflow.round || 0) + 1

  workflow.status = STATUS.SUBMITTED
  workflow.round = nextRound
  workflow.submittedBy = currentUser.value.name
  workflow.submittedAt = now
  workflow.reviewedBy = null
  workflow.reviewedAt = null
  workflow.reason = null
  workflow.baseline = snapshot
  workflow.lastDiff = lastDiff
  workflow.updatedAt = now
  pushHistory(workflow, 'submitted', now)
  rememberFrameVersion(frameIndex, 'submit')
  return workflow
}

/** 标注员/管理员提交当前帧 */
export function submitFrame(frameIndex = state.currentIndex) {
  if (!canAnnotate.value || !currentUser.value) throw new Error('当前角色不能提交')
  if (state.gtLoading) throw new Error('全量真值正在导入，请稍后再提交')
  const workflow = commitSubmit(frameIndex)
  saveReview()
  return workflow
}

/** 提交当前数据集内所有未提交 / 已打回帧（含空帧） */
export function submitAllFrames() {
  if (!canAnnotate.value || !currentUser.value) throw new Error('当前角色不能提交')
  if (state.gtLoading) throw new Error('全量真值正在导入，请稍后再提交')
  const summary = batchSubmitSummary.value
  if (!summary.count) throw new Error('没有可提交的帧')
  let submitted = 0
  for (const frameIndex of summary.indexes.slice()) {
    try {
      commitSubmit(frameIndex)
      submitted++
    } catch {
      /* 状态在批量期间发生变化时跳过 */
    }
  }
  if (submitted) saveReview()
  return {
    submitted,
    skipped: summary.skipped,
    empty: summary.empty,
    total: summary.total,
  }
}

/** 撤销单帧提交（不落盘，批量撤销复用） */
function commitWithdraw(frameIndex) {
  const workflow = workflowForWrite(frameIndex)
  if (workflow.status !== STATUS.SUBMITTED) throw new Error('只有待审核的帧可以撤销提交')
  const now = nowStamp(workflow.updatedAt)
  workflow.status = STATUS.DRAFT
  workflow.reviewedBy = null
  workflow.reviewedAt = null
  workflow.reason = null
  workflow.updatedAt = now
  pushHistory(workflow, 'withdrawn', now)
  return workflow
}

/** 标注员/管理员撤销当前帧提交 */
export function withdrawFrame(frameIndex = state.currentIndex) {
  if (!canAnnotate.value || !currentUser.value) throw new Error('当前角色不能撤销提交')
  const workflow = commitWithdraw(frameIndex)
  saveReview()
  return workflow
}

/** 撤销当前数据集内所有待审核帧 */
export function withdrawAllFrames() {
  if (!canAnnotate.value || !currentUser.value) throw new Error('当前角色不能撤销提交')
  const indexes = submittedIndexes.value.slice()
  if (!indexes.length) throw new Error('没有待审核的帧')
  let withdrawn = 0
  for (const frameIndex of indexes) {
    try {
      commitWithdraw(frameIndex)
      withdrawn++
    } catch {
      /* 跳过状态变化的帧 */
    }
  }
  if (withdrawn) saveReview()
  return { withdrawn, total: indexes.length }
}

/** 通过单帧（不落盘，批量通过复用） */
function commitApprove(frameIndex, note = '') {
  const workflow = workflowForWrite(frameIndex)
  if (workflow.status !== STATUS.SUBMITTED) throw new Error('只有待审核的帧可以通过')
  const now = nowStamp(workflow.updatedAt)
  workflow.status = STATUS.APPROVED
  workflow.reviewedBy = currentUser.value.name
  workflow.reviewedAt = now
  workflow.reason = null
  workflow.updatedAt = now
  pushHistory(workflow, 'approved', now, note ? { reason: String(note) } : {})
  rememberFrameVersion(frameIndex, 'approve')
  return workflow
}

/** 批注员/管理员通过当前帧 */
export function approveFrame(frameIndex = state.currentIndex, note = '') {
  if (!canReview.value || !currentUser.value) throw new Error('当前角色不能审核')
  if (state.gtLoading) throw new Error('全量真值正在导入，请稍后再审核')
  const workflow = commitApprove(frameIndex, note)
  saveReview()
  return workflow
}

/** 通过当前数据集内所有待审核帧 */
export function approveAllFrames() {
  if (!canReview.value || !currentUser.value) throw new Error('当前角色不能审核')
  if (state.gtLoading) throw new Error('全量真值正在导入，请稍后再审核')
  const indexes = submittedIndexes.value.slice()
  if (!indexes.length) throw new Error('没有待审核的帧')
  let approved = 0
  for (const frameIndex of indexes) {
    try {
      commitApprove(frameIndex)
      approved++
    } catch {
      /* 跳过状态变化的帧 */
    }
  }
  if (approved) saveReview()
  return { approved, total: indexes.length }
}

/** 批注员/管理员打回当前帧 */
export function rejectFrame(reason, frameIndex = state.currentIndex, category = 'other') {
  if (!canReview.value || !currentUser.value) throw new Error('当前角色不能打回')
  if (state.gtLoading) throw new Error('全量真值正在导入，请稍后再审核')
  const workflow = workflowForWrite(frameIndex)
  if (workflow.status !== STATUS.SUBMITTED) throw new Error('只有待审核的帧可以打回')
  const text = String(reason || '').trim() || '请根据批注修改后重新提交'
  const safeCategory = REJECT_CATEGORIES.some((c) => c.id === category) ? category : 'other'
  const now = nowStamp(workflow.updatedAt)
  const target = currentCommentTarget()
  const frame = frameAt(frameIndex)

  workflow.status = STATUS.REJECTED
  workflow.reviewedBy = currentUser.value.name
  workflow.reviewedAt = now
  workflow.reason = text
  workflow.updatedAt = now
  pushHistory(workflow, 'rejected', now, { reason: text })

  if (frame) {
    reviewState.comments.push({
      id: uid('cmt'),
      frameIndex,
      frameName: frame.name,
      ...(target || {}),
      text,
      kind: 'rejection',
      author: currentUser.value.name,
      role: currentUser.value.role,
      createdAt: now,
      updatedAt: now,
      round: workflow.round,
      status: COMMENT_STATUS.PENDING,
      category: safeCategory,
      replies: [],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    })
  }
  saveReview()
  return workflow
}

/** 管理员重新打开已通过的帧 */
export function reopenFrame(frameIndex = state.currentIndex, reason = '') {
  if (currentRole.value !== 'admin' || !currentUser.value) throw new Error('只有管理员可以重新打开')
  const workflow = workflowForWrite(frameIndex)
  if (workflow.status !== STATUS.APPROVED) throw new Error('只有已通过的帧可以重新打开')
  const now = nowStamp(workflow.updatedAt)
  workflow.status = STATUS.DRAFT
  workflow.reviewedBy = null
  workflow.reviewedAt = null
  workflow.reason = String(reason || '').trim() || null
  workflow.updatedAt = now
  pushHistory(workflow, 'reopened', now, workflow.reason ? { reason: workflow.reason } : {})
  saveReview()
  return workflow
}

/** 导入数据覆盖了某些帧后，把这些帧重置为未提交（保留历史与批注） */
export function resetFramesAfterImport(frameIndexes, reason = '导入数据') {
  const list = Array.isArray(frameIndexes) ? frameIndexes : []
  if (!list.length) return 0
  const user = currentUser.value
  let count = 0
  for (const index of list) {
    const workflow = frameWorkflow(index)
    if (!workflow) continue
    if (workflow.status === STATUS.DRAFT) continue
    const now = nowStamp(workflow.updatedAt)
    workflow.status = STATUS.DRAFT
    workflow.reviewedBy = null
    workflow.reviewedAt = null
    workflow.reason = null
    workflow.updatedAt = now
    workflow.history.push({
      type: 'imported',
      actor: user?.name || '',
      role: user?.role || '',
      at: now,
      round: workflow.round || 0,
      reason,
    })
    count++
  }
  if (count) saveReview()
  return count
}

/** 当前帧与上次提交快照的实时 diff（打回后标注员查看） */
export function diffForFrame(frameIndex = state.currentIndex) {
  const workflow = frameWorkflow(frameIndex)
  const frame = frameAt(frameIndex)
  if (!workflow?.baseline || !frame) return null
  return diffSnapshots(workflow.baseline, snapshotFrame(frame))
}

/** 清空当前数据集的审核记录（演示重置） */
export function resetReview() {
  if (!reviewState.dataset) return
  try {
    localStorage.removeItem(currentStorageKey())
  } catch {
    /* 忽略 */
  }
  clearInMemory()
}

/* ---------------- 导入 / 导出 ---------------- */

/** 导出到保存载荷 / 项目 JSON */
export function serializeReview() {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    dataset: reviewState.dataset,
    updatedAt: reviewState.updatedAt,
    workflows: Object.fromEntries(
      Object.entries(reviewState.workflows).map(([key, workflow]) => [key, cloneWorkflow(workflow)]),
    ),
    comments: reviewState.comments.map((c) => ({ ...c })),
  }
}

/** 导入项目 JSON 时恢复批注与审核状态 */
export function applyReview(data) {
  if (!data || typeof data !== 'object') return
  applyParsed(parseReviewData(data))
  saveReview({ merge: false })
}

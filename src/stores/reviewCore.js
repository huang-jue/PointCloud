/**
 * reviewCore —— 批注/审核的纯数据与状态判断
 *
 * 这里不 import 标注 store，避免 useAnnotationStore 与 useReviewStore 循环依赖：
 *   useAnnotationStore -> reviewCore（多帧传播时判断帧是否锁定）
 *   useReviewStore     -> reviewCore + useAnnotationStore + useAuthStore
 */
import { reactive } from 'vue'

export const REVIEW_SCHEMA_VERSION = 2

export const STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
}

export const STATUS_META = {
  draft: { label: '未提交', type: 'info' },
  submitted: { label: '待审核', type: 'warning' },
  approved: { label: '已通过', type: 'success' },
  rejected: { label: '已打回', type: 'danger' },
}

const STATUS_VALUES = new Set(Object.keys(STATUS_META))

export const reviewState = reactive({
  dataset: '',
  schemaVersion: REVIEW_SCHEMA_VERSION,
  workflows: {},
  comments: [],
  updatedAt: 0,
})

export function defaultWorkflow() {
  return {
    status: STATUS.DRAFT,
    round: 0,
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reason: null,
    baseline: null,
    lastDiff: null,
    updatedAt: 0,
    history: [],
  }
}

function normalizeBaseline(value) {
  if (!value || typeof value !== 'object') return null
  const ids = Array.isArray(value.ids) ? value.ids.map(String) : []
  const sigs = Array.isArray(value.sigs) ? value.sigs.map(String) : []
  const labels = Array.isArray(value.labels) ? value.labels.map(String) : []
  return { ids, sigs, labels }
}

function normalizeDiffEntry(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((item) => ({ id: String(item.id), label: String(item.label || item.id) }))
}

function normalizeLastDiff(value) {
  if (!value || typeof value !== 'object') return null
  const added = normalizeDiffEntry(value.added)
  const removed = normalizeDiffEntry(value.removed)
  const changed = normalizeDiffEntry(value.changed)
  return {
    fromRound: Number.isFinite(value.fromRound) ? value.fromRound : 0,
    added,
    removed,
    changed,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    labelDelta: Number.isFinite(value.labelDelta) ? value.labelDelta : 0,
  }
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object' && item.type)
    .map((item) => ({
      type: String(item.type),
      actor: String(item.actor || ''),
      role: String(item.role || ''),
      at: Number.isFinite(item.at) ? item.at : 0,
      round: Number.isFinite(item.round) ? item.round : 0,
      reason: item.reason ? String(item.reason) : undefined,
    }))
}

export function normalizeWorkflow(value) {
  const wf = defaultWorkflow()
  if (!value || typeof value !== 'object') return wf
  return {
    ...wf,
    ...value,
    status: STATUS_VALUES.has(value.status) ? value.status : STATUS.DRAFT,
    round: Number.isFinite(value.round)
      ? value.round
      : value.status && value.status !== STATUS.DRAFT
        ? 1
        : 0,
    reason: value.reason ? String(value.reason) : null,
    baseline: normalizeBaseline(value.baseline),
    lastDiff: normalizeLastDiff(value.lastDiff),
    updatedAt: Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Number.isFinite(value.reviewedAt)
        ? value.reviewedAt
        : Number.isFinite(value.submittedAt)
          ? value.submittedAt
          : 0,
    history: normalizeHistory(value.history),
  }
}

export function cloneWorkflow(wf) {
  const normalized = normalizeWorkflow(wf)
  return {
    ...normalized,
    baseline: normalized.baseline
      ? {
          ids: [...normalized.baseline.ids],
          sigs: [...normalized.baseline.sigs],
          labels: [...normalized.baseline.labels],
        }
      : null,
    lastDiff: normalized.lastDiff
      ? {
          ...normalized.lastDiff,
          added: normalized.lastDiff.added.map((item) => ({ ...item })),
          removed: normalized.lastDiff.removed.map((item) => ({ ...item })),
          changed: normalized.lastDiff.changed.map((item) => ({ ...item })),
        }
      : null,
    history: normalized.history.map((item) => ({ ...item })),
  }
}

export function normalizeComment(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.text !== 'string' || !Number.isFinite(value.frameIndex)) return null
  return {
    ...value,
    id: value.id || `cmt_${value.frameIndex}_${value.createdAt || Date.now()}`,
    frameIndex: value.frameIndex,
    frameName: String(value.frameName || ''),
    text: value.text,
    kind: value.kind === 'rejection' ? 'rejection' : 'comment',
    author: String(value.author || ''),
    role: String(value.role || ''),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
    round: Number.isFinite(value.round) ? value.round : 0,
    resolved: !!value.resolved,
    resolvedBy: value.resolvedBy ? String(value.resolvedBy) : null,
    resolvedAt: Number.isFinite(value.resolvedAt) ? value.resolvedAt : null,
  }
}

export function normalizeComments(list) {
  if (!Array.isArray(list)) return []
  return list.map(normalizeComment).filter(Boolean)
}

export function frameWorkflow(frameIndex) {
  return reviewState.workflows[String(frameIndex)] || null
}

export function frameStatus(frameIndex) {
  return frameWorkflow(frameIndex)?.status || STATUS.DRAFT
}

/** submitted / approved 的帧处于锁定状态，禁止标注员继续编辑 */
export function isFrameLocked(frameIndex) {
  const status = frameStatus(frameIndex)
  return status === STATUS.SUBMITTED || status === STATUS.APPROVED
}

export function statusLabelOf(status) {
  return STATUS_META[status]?.label || STATUS_META.draft.label
}

export function statusTypeOf(status) {
  return STATUS_META[status]?.type || STATUS_META.draft.type
}

/**
 * AI 预标注建议（演示 mock）
 *
 * 不接真实模型：优先用当前帧真值里「尚未标注」的对象生成候选；
 * 如果所有真值对象都已存在，则对现有对象做小幅扰动，生成“模型优化建议”。
 * 后续可把 loadSuggestions 替换为 VITE_PREDICT_API 的真实推理。
 */
import { computed, reactive, watch } from 'vue'
import { state, addObject, updateObject } from './useAnnotationStore.js'
import { get, post } from '../utils/http.js'
import { uid } from '../utils/id.js'

/** 真实推理接口（留空则使用演示 mock） */
const PREDICT_API = import.meta.env.VITE_PREDICT_API || ''

export const suggestionState = reactive({
  loading: false,
  frameIndex: -1,
  items: [],
  error: '',
  source: 'mock',
})

const rejectedIds = new Map()

function jitter(value, amount) {
  return value + (Math.random() * 2 - 1) * amount
}

function objectLabel(obj) {
  return `${obj.type || 'Object'}${obj.trackId ? ` T${obj.trackId}` : ''}`
}

function makeAddSuggestion(obj, score) {
  return {
    id: uid('sug'),
    kind: 'add',
    score,
    label: objectLabel(obj),
    sourceId: obj.id,
    object: {
      ...obj,
      id: undefined,
      trackId: 0,
      multiFrame: false,
      startFrame: state.currentIndex,
      source: 'ai',
      score,
    },
  }
}

function makeRefineSuggestion(obj, score) {
  return {
    id: uid('sug'),
    kind: 'refine',
    score,
    label: objectLabel(obj),
    sourceId: obj.id,
    targetId: obj.id,
    object: {
      ...obj,
      x: jitter(obj.x, 0.18),
      y: jitter(obj.y, 0.18),
      z: obj.z,
      ry: (obj.ry || 0) + jitter(0, 0.04),
    },
  }
}

export const suggestionSummary = computed(() => ({
  count: suggestionState.items.length,
  add: suggestionState.items.filter((s) => s.kind === 'add').length,
  refine: suggestionState.items.filter((s) => s.kind === 'refine').length,
}))

/** 把后端/模型返回的建议转换成内部结构 */
function normalizeModelSuggestion(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const object = raw.object || raw.box || raw
  if (!object || typeof object !== 'object') return null
  const kind = raw.kind === 'refine' || raw.type === 'refine' ? 'refine' : 'add'
  const score = Number(raw.score ?? object.score ?? 0.8)
  const item = {
    id: uid('sug'),
    kind,
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.8,
    label: objectLabel(object),
    sourceId: String(raw.sourceId || object.id || `model_${index}`),
    object: {
      ...object,
      id: undefined,
      trackId: object.trackId ?? 0,
      multiFrame: false,
      startFrame: state.currentIndex,
      source: 'ai',
      score,
    },
  }
  if (kind === 'refine') {
    item.targetId = raw.targetId || object.id
    if (!item.targetId) return null
  }
  return item
}

/** 调用真实推理接口；未配置时返回 null 交由 mock 逻辑处理 */
async function loadFromModel(frame) {
  if (!PREDICT_API) return null
  const data = await post(
    PREDICT_API,
    {
      dataset: state.datasetName,
      frameIndex: state.currentIndex,
      frameName: frame.name,
      pointCount: frame.pointCount ?? null,
      classes: state.classes,
      objects: (frame.objects || []).map((obj) => ({
        id: obj.id,
        type: obj.type,
        classId: obj.classId,
        trackId: obj.trackId,
        h: obj.h,
        w: obj.w,
        l: obj.l,
        x: obj.x,
        y: obj.y,
        z: obj.z,
        ry: obj.ry,
        score: obj.score,
      })),
    },
    { silent: true, timeout: 30000 },
  )
  const list = Array.isArray(data)
    ? data
    : data?.suggestions || data?.items || data?.data?.suggestions || []
  if (!Array.isArray(list)) return []
  return list.slice(0, 50).map(normalizeModelSuggestion).filter(Boolean)
}

/** 加载当前帧建议（优先真实接口，未配置或失败时使用 mock） */
export async function loadSuggestions(frameIndex = state.currentIndex) {
  const frame = state.frames[frameIndex]
  suggestionState.frameIndex = frameIndex
  suggestionState.items = []
  suggestionState.error = ''
  if (!frame) {
    suggestionState.error = '请先加载数据'
    return []
  }
  suggestionState.loading = true
  try {
    let modelItems = null
    if (PREDICT_API) {
      try {
        modelItems = await loadFromModel(frame)
        suggestionState.source = 'model'
      } catch (err) {
        suggestionState.error = `AI 推理接口失败：${err?.message || String(err)}（已回退到演示建议）`
        suggestionState.source = 'mock'
      }
    }
    if (modelItems && modelItems.length) {
      suggestionState.items = modelItems.filter(
        (s) => !rejectedIds.get(frameIndex)?.has(s.sourceId),
      )
      return suggestionState.items
    }
    suggestionState.source = 'mock'
    const existing = frame.objects || []
    const existingIds = new Set(existing.map((o) => o.id))
    const existingTracks = new Set(existing.map((o) => o.trackId).filter(Boolean))
    let candidates = []
    if (frame.labelUrl) {
      try {
        const labels = await get(frame.labelUrl, null, { silent: true })
        candidates = (Array.isArray(labels) ? labels : [])
          .filter((o) => o && o.id && !existingIds.has(o.id) && !existingTracks.has(o.trackId))
          .slice(0, 8)
      } catch {
        candidates = []
      }
    }
    if (candidates.length) {
      suggestionState.items = candidates.map((obj, i) =>
        makeAddSuggestion(obj, Math.max(0.62, 0.95 - i * 0.05)),
      )
    } else {
      // 所有真值都已存在：生成位姿优化建议，避免演示时列表为空
      const pool = existing.filter((o) => o.shape !== 'line' && o.shape !== 'arrow')
      suggestionState.items = pool.slice(0, 5).map((obj, i) =>
        makeRefineSuggestion(obj, Math.max(0.6, 0.9 - i * 0.06)),
      )
    }
    suggestionState.items = suggestionState.items.filter(
      (s) => !rejectedIds.get(frameIndex)?.has(s.sourceId),
    )
    return suggestionState.items
  } finally {
    suggestionState.loading = false
  }
}

export function acceptSuggestion(id) {
  const index = suggestionState.items.findIndex((s) => s.id === id)
  if (index === -1) return false
  const suggestion = suggestionState.items[index]
  if (suggestion.kind === 'refine' && suggestion.targetId) {
    const { x, y, z, ry } = suggestion.object
    updateObject(suggestion.targetId, { x, y, z, ry })
  } else {
    const obj = suggestion.object
    addObject(
      {
        classId: obj.classId,
        type: obj.type,
        h: obj.h,
        w: obj.w,
        l: obj.l,
        x: obj.x,
        y: obj.y,
        z: obj.z,
        ry: obj.ry,
        source: 'ai',
        score: suggestion.score,
      },
      { propagate: false },
    )
  }
  suggestionState.items.splice(index, 1)
  return true
}

export function rejectSuggestion(id) {
  const index = suggestionState.items.findIndex((s) => s.id === id)
  if (index === -1) return false
  const [suggestion] = suggestionState.items.splice(index, 1)
  const frameIndex = suggestionState.frameIndex
  if (!rejectedIds.has(frameIndex)) rejectedIds.set(frameIndex, new Set())
  rejectedIds.get(frameIndex).add(suggestion.sourceId)
  return true
}

export function acceptAllSuggestions() {
  const items = suggestionState.items.slice()
  for (const item of items) acceptSuggestion(item.id)
  return items.length
}

export function rejectAllSuggestions() {
  const items = suggestionState.items.slice()
  for (const item of items) rejectSuggestion(item.id)
  return items.length
}

watch(
  () => [state.datasetName, state.currentIndex],
  () => {
    suggestionState.items = []
    suggestionState.error = ''
  },
)

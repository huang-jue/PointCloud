/**
 * AI 预标注建议（演示 mock）
 *
 * 不接真实模型：优先用当前帧真值里「尚未标注」的对象生成候选；
 * 如果所有真值对象都已存在，则对现有对象做小幅扰动，生成“模型优化建议”。
 * 后续可把 loadSuggestions 替换为 VITE_PREDICT_API 的真实推理。
 */
import { computed, reactive, watch } from 'vue'
import { state, currentFrame, addObject, updateObject } from './useAnnotationStore.js'
import { get } from '../utils/http.js'
import { uid } from '../utils/id.js'

export const suggestionState = reactive({
  loading: false,
  frameIndex: -1,
  items: [],
  error: '',
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

/** 加载当前帧建议（mock） */
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

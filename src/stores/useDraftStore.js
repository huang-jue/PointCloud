/**
 * useDraftStore —— 标注草稿自动保存 / 恢复
 *
 * 只保存「编辑过的帧」（state.editedFrames），对象与点级标签一起写入 IndexedDB。
 * 编辑后 800ms 防抖保存；切帧、页面隐藏、关闭页面前立即 flush。
 * 恢复时机由 App 控制：等示例数据集的全量真值导入完成后再覆盖，避免被真值冲掉。
 */
import { watch } from 'vue'
import { state, refreshClassSequence, refreshTrackSequence } from './useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import {
  clearDrafts,
  listDrafts,
  packLabels,
  putDraft,
  unpackLabels,
} from '../utils/draftDb.js'

const SAVE_DELAY = 800
let saveTimer = null
let savingPromise = null
let restoredKey = ''
let initialized = false

function cloneObjects(objects) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(objects || [])
    } catch {
      /* 退回 JSON */
    }
  }
  return JSON.parse(JSON.stringify(objects || []))
}

function frameByIndex(index) {
  return state.frames[index] || null
}

function labelsForFrame(frame) {
  const viewer = viewerRef.current
  if (!viewer || !frame) return null
  const key = viewer.cacheKeyFor(frame)
  const saved = viewer.labelsByKey?.get(key)
  if (!saved) return null
  return packLabels(saved)
}

/** 把当前所有待保存帧写入 IndexedDB */
export async function savePendingDrafts() {
  const dataset = state.datasetName
  if (!dataset || !state.frames.length) return 0
  const indexes = Array.from(state.editedFrames || []).filter(
    (index) => Number.isInteger(index) && state.frames[index],
  )
  if (!indexes.length) return 0
  if (savingPromise) return savingPromise
  const revision = state.editVersion
  state.draftSaving = true
  state.draftError = ''
  savingPromise = (async () => {
    let saved = 0
    try {
      for (const index of indexes) {
        const frame = frameByIndex(index)
        if (!frame) continue
        await putDraft({
          dataset,
          frameIndex: index,
          frameName: frame.name,
          objects: cloneObjects(frame.objects),
          labels: labelsForFrame(frame),
          classes: state.classes,
          activeClassId: state.activeClassId,
          revision,
        })
        saved++
      }
      if (revision === state.editVersion && state.datasetName === dataset) {
        state.editedFrames.clear()
        state.dirty = false
        state.draftSavedAt = Date.now()
      }
      return saved
    } catch (err) {
      state.draftError = `本地草稿保存失败：${err?.message || String(err)}`
      return 0
    } finally {
      state.draftSaving = false
      savingPromise = null
      if (revision !== state.editVersion && state.editedFrames.size) {
        scheduleDraftSave(200)
      }
    }
  })()
  return savingPromise
}

/** 防抖保存；delay=0 时尽快执行 */
export function scheduleDraftSave(delay = SAVE_DELAY) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    savePendingDrafts()
  }, delay)
}

/** 立即保存并等待完成（切数据集/页面隐藏时调用；如有新编辑会再补一次） */
export async function flushDrafts() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  let saved = 0
  for (let i = 0; i < 3; i++) {
    saved += await savePendingDrafts()
    if (!state.editedFrames.size) break
  }
  return saved
}

/** 把 IndexedDB 里的草稿恢复到帧与视口标签缓存 */
export async function restoreDrafts() {
  const dataset = state.datasetName
  if (!dataset || !state.frames.length) return 0
  if (state.gtPending || state.gtLoading) return 0
  let records = []
  try {
    records = await listDrafts(dataset)
  } catch (err) {
    state.draftError = `读取本地草稿失败：${err?.message || String(err)}`
    return 0
  }
  if (!records.length) {
    state.draftRestored = 0
    return 0
  }
  let count = 0
  let latest = 0
  const viewer = viewerRef.current
  // 类别表是数据集级数据：取最近一次草稿里的版本，保证草稿对象 type 与 classId 一致
  const classRecord = records
    .filter((record) => Array.isArray(record.classes) && record.classes.length)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
  if (classRecord) {
    state.classes = classRecord.classes.map((c) => ({ ...c }))
    if (
      classRecord.activeClassId != null &&
      state.classes.some((c) => c.id === classRecord.activeClassId)
    ) {
      state.activeClassId = classRecord.activeClassId
    } else if (!state.classes.some((c) => c.id === state.activeClassId)) {
      state.activeClassId = state.classes[0]?.id ?? 0
    }
  }
  for (const record of records) {
    const frame = state.frames[record.frameIndex]
    if (!frame) continue
    // 草稿恢复期间用户可能已经在当前帧补了新对象，保留这些新对象
    const kept = frame.objects.filter(
      (obj) =>
        ['manual', 'copy', 'ai', 'interp'].includes(obj.source) &&
        !(record.objects || []).some((item) => item.id === obj.id),
    )
    frame.objects.splice(0, frame.objects.length, ...cloneObjects(record.objects))
    if (kept.length) frame.objects.push(...kept)
    if (record.labels && viewer) {
      const unpacked = unpackLabels(record.labels)
      if (unpacked) {
        const key = viewer.cacheKeyFor(frame)
        viewer.labelsByKey.set(key, { ...unpacked, persisted: true })
        if (viewer.currentCloud?.key === key) viewer.applySavedLabels(frame)
      }
    }
    latest = Math.max(latest, record.updatedAt || 0)
    count++
  }
  state.draftRestored = count
  state.draftUpdatedAt = latest
  state.labelVersion++
  if (count) {
    state.draftSavedAt = latest
    refreshClassSequence()
    refreshTrackSequence()
  }
  return count
}

/** 清除当前数据集的本地草稿（不影响内存中的当前编辑） */
export async function clearDatasetDrafts() {
  if (!state.datasetName) return 0
  const count = await clearDrafts(state.datasetName)
  state.editedFrames.clear()
  state.dirty = false
  state.draftSavedAt = 0
  state.draftUpdatedAt = 0
  state.draftRestored = 0
  return count
}

/** 页面初始化：监听编辑/切帧并自动恢复草稿 */
export function initDraftAutosave() {
  if (initialized) return
  initialized = true

  watch(
    () => state.editVersion,
    () => {
      if (state.editedFrames.size) scheduleDraftSave()
    },
  )

  watch(
    () => state.currentIndex,
    (index, previous) => {
      if (previous >= 0 && state.editedFrames.has(previous)) scheduleDraftSave(0)
      if (index >= 0 && state.editedFrames.has(index)) scheduleDraftSave(0)
    },
  )

  watch(
    () => [state.datasetName, state.frames.length, state.gtPending, state.gtLoading],
    () => {
      const dataset = state.datasetName
      if (!dataset || !state.frames.length) return
      if (state.gtPending || state.gtLoading) return
      const key = `${dataset}#${state.frames.length}`
      if (restoredKey === key) return
      restoredKey = key
      // 等当前 tick 的帧加载逻辑先跑完，再覆盖草稿
      setTimeout(() => {
        if (state.datasetName !== dataset) return
        restoreDrafts().catch(() => {})
      }, 0)
    },
    { immediate: true },
  )

  const flush = () => {
    flushDrafts().catch(() => {})
  }
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
}

export function resetRestoreMarker() {
  restoredKey = ''
}

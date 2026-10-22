/**
 * 本地草稿 IndexedDB
 *
 * 与 localStorage 的审核记录分开：标注对象和点级标签体积大，放 IndexedDB。
 * 每条记录对应「数据集 + 帧」，只保存用户编辑过的帧；恢复时覆盖同帧对象。
 */
const DB_NAME = 'pc-annotate-drafts'
const DB_VERSION = 1
const STORE = 'drafts'
const INDEX = 'dataset'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(INDEX, 'dataset', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

export function draftId(dataset, frameIndex) {
  return `${dataset || 'local'}\u0000${frameIndex}`
}

function clonePlain(value) {
  if (value === null || value === undefined) return value
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* 退回 JSON */
    }
  }
  return JSON.parse(JSON.stringify(value))
}

/** 把点云标签缓存转成可存入 IndexedDB 的结构（保留 Int32Array） */
export function packLabels(saved) {
  if (!saved || !saved.pointLabels || !saved.segments) return null
  return {
    pointCount: saved.pointLabels.length,
    segments: saved.segments.map((segment) => ({
      classId: segment.classId,
      indices: segment.indices instanceof Int32Array
        ? segment.indices
        : Int32Array.from(segment.indices || []),
    })),
  }
}

/** 恢复 packLabels 的结果，得到 viewer.labelsByKey 需要的结构 */
export function unpackLabels(packed) {
  if (!packed || !packed.pointCount) return null
  const pointCount = Number(packed.pointCount) || 0
  const pointLabels = new Int32Array(pointCount).fill(-1)
  const pointSegment = new Int32Array(pointCount).fill(-1)
  const segments = []
  let segId = 0
  for (const source of packed.segments || []) {
    const classId = Number(source.classId)
    const indices = source.indices instanceof Int32Array
      ? Int32Array.from(source.indices)
      : Int32Array.from(source.indices || [])
    if (!indices.length) continue
    const id = ++segId
    segments.push({ id, classId, indices })
    for (let k = 0; k < indices.length; k++) {
      const pointIndex = indices[k]
      if (pointIndex < 0 || pointIndex >= pointCount) continue
      pointLabels[pointIndex] = classId
      pointSegment[pointIndex] = id
    }
  }
  return { pointLabels, pointSegment, segments, labelHistory: [] }
}

/**
 * 写入一帧草稿
 * @param {{dataset:string, frameIndex:number, frameName?:string, objects:Array, labels?:object|null, revision?:number}} draft
 */
export async function putDraft(draft) {
  const db = await openDb()
  const record = {
    id: draftId(draft.dataset, draft.frameIndex),
    dataset: draft.dataset || 'local',
    frameIndex: draft.frameIndex,
    frameName: draft.frameName || '',
    objects: clonePlain(draft.objects || []),
    labels: draft.labels ? clonePlain(draft.labels) : null,
    classes: draft.classes ? clonePlain(draft.classes) : null,
    activeClassId: draft.activeClassId ?? null,
    revision: Number(draft.revision) || 0,
    updatedAt: Date.now(),
  }
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(record)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  return record
}

export async function getDraft(dataset, frameIndex) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(draftId(dataset, frameIndex))
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

export async function listDrafts(dataset) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly')
    const index = store.index(INDEX)
    const req = index.getAll(IDBKeyRange.only(dataset || 'local'))
    req.onsuccess = () => {
      const list = req.result || []
      list.sort((a, b) => a.frameIndex - b.frameIndex)
      resolve(list)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function deleteDraft(dataset, frameIndex) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(draftId(dataset, frameIndex))
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearDrafts(dataset) {
  const list = await listDrafts(dataset)
  if (!list.length) return 0
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite')
    for (const item of list) store.delete(item.id)
    store.transaction.oncomplete = () => resolve()
    store.transaction.onerror = () => reject(store.transaction.error)
  })
  return list.length
}

export async function countDrafts(dataset) {
  const list = await listDrafts(dataset)
  return list.length
}

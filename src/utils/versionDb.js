/** 版本快照 IndexedDB（只保存标注对象，不保存点级标签） */

const DB_NAME = 'pc-annotate-versions'
const DB_VERSION = 1
const STORE = 'snapshots'
const MAX_PER_FRAME = 10

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
        store.createIndex('frame', ['dataset', 'frameIndex'], { unique: false })
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

function cloneObjects(objects) {
  return JSON.parse(JSON.stringify(objects || []))
}

/** 保存一个版本，并清理该帧的旧版本 */
export async function saveVersion({
  dataset,
  frameIndex,
  round = 0,
  kind = 'manual',
  actor = '',
  objects = [],
}) {
  const db = await openDb()
  const id = `${dataset || 'local'}:${frameIndex}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
  const record = {
    id,
    dataset: dataset || 'local',
    frameIndex,
    round,
    kind,
    actor,
    createdAt: Date.now(),
    objects: cloneObjects(objects),
  }
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(record)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  await prune(dataset || 'local', frameIndex)
  return record
}

async function prune(dataset, frameIndex) {
  const list = await listVersions(dataset, frameIndex)
  const extra = list.slice(MAX_PER_FRAME)
  if (!extra.length) return
  const db = await openDb()
  await new Promise((resolve) => {
    const store = tx(db, 'readwrite')
    for (const item of extra) store.delete(item.id)
    store.transaction.oncomplete = () => resolve()
    store.transaction.onerror = () => resolve()
  })
}

export async function listVersions(dataset, frameIndex) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly')
    const index = store.index('frame')
    const req = index.getAll(IDBKeyRange.only([dataset || 'local', frameIndex]))
    req.onsuccess = () => {
      const list = (req.result || []).sort((a, b) => b.createdAt - a.createdAt)
      resolve(list)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getVersion(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteVersion(id) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearFrameVersions(dataset, frameIndex) {
  const list = await listVersions(dataset, frameIndex)
  const db = await openDb()
  await new Promise((resolve) => {
    const store = tx(db, 'readwrite')
    for (const item of list) store.delete(item.id)
    store.transaction.oncomplete = () => resolve()
    store.transaction.onerror = () => resolve()
  })
}

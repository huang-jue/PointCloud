/**
 * useAnnotationStore —— 全局标注状态与业务逻辑（单例模块）
 *
 * 采用模块级 reactive 单例（不引入 Pinia），组件直接 import 使用：
 *   state          响应式状态树
 *   currentFrame   当前帧（computed）
 *   currentObjects 当前帧标注对象（computed）
 *
 * 数据结构：
 *   frame = {
 *     index, name, timestamp, ext,
 *     source: { kind: 'url' | 'file', url?, file?, ext },
 *     labelUrl,      真值文件地址（可选）
 *     pointCount,    点云点数（加载后回填）
 *     objects: []    该帧的标注对象
 *   }
 *   object = {
 *     id, trackId, startFrame, multiFrame,
 *     classId, type, h, w, l, x, y, z, ry, score, source
 *   }
 *   marking = {
 *     id, shape: 'line' | 'arrow', trackId, startFrame, multiFrame,
 *     classId, type, width, source,
 *     points: [[x,y,z], ...]        // shape=line
 *     paths: [[[x,y,z], ...], ...]  // shape=arrow（可多路径，如直行+左转）
 *     template: string | null
 *   }
 *
 * 多帧物体：`multiFrame=true` 的对象在多帧中共享同一 `trackId`，
 * 起始帧=startFrame，起始帧之前不创建（即隐藏）。
 */

import { reactive, computed } from 'vue'
import { uid } from '../utils/id.js'
import { pathExt } from '../utils/math.js'
import { objectsToKittiText, kittiTextToObjects } from '../utils/kitti.js'
import { get } from '../utils/http.js'
import { isFrameLocked } from './reviewCore.js'
import { defaultIntrinsics } from '../utils/projection.js'
import {
  clonePoints,
  clonePaths,
  polylineCentroid,
  rotatePoints,
  scalePoints,
} from '../utils/polyline.js'
import {
  bindHistory,
  canRedo,
  canUndo,
  clearHistory,
  cloneData,
  historyState,
  pushCommand,
  redoCommand,
  undoCommand,
} from './useHistoryStore.js'

/** 默认类别表（加载数据集时会被 scene.classes 覆盖） */
export const DEFAULT_CLASSES = [
  { id: 0, name: 'Car', color: '#4f9bff' },
  { id: 1, name: 'Van', color: '#57d9a3' },
  { id: 2, name: 'Pedestrian', color: '#ff6b6b' },
  { id: 3, name: 'Cyclist', color: '#ffd166' },
  { id: 4, name: 'Pole', color: '#9aa5b1' },
  { id: 5, name: 'Truck', color: '#b07cff' },
  { id: 6, name: 'LaneLine', color: '#f2f4f8' },
  { id: 7, name: 'Crosswalk', color: '#ffd166' },
  { id: 8, name: 'RoadArrow', color: '#3fd0d4' },
  { id: 9, name: 'StopLine', color: '#ff8f3f' },
]

/** 标线类别名（画线/画箭头时自动切换） */
export const MARKING_CLASS = { line: 'LaneLine', arrow: 'RoadArrow' }

let classSeq = 100 // 新增类别自增 id
let trackSeq = 1000 // 多帧物体 trackId 自增（避开真值里的小整数）
let clipboard = [] // 内部复制粘贴剪贴板（普通对象，不进入响应式）
let pasteSerial = 0 // 连续粘贴的偏移序号
let groundTruthToken = 0 // 延迟导入全量真值的代次，切换数据集时丢弃旧任务

function nextTrackId() {
  return ++trackSeq
}

/** 当前帧是否已提交/已通过（锁定） */
function currentFrameLocked() {
  return isFrameLocked(state.currentIndex)
}

/** 传播时遇到锁定帧：跳过并累计一次提示 */
function noteLockedSkip() {
  state.lockSkipCount++
}

export const state = reactive({
  /* 数据集信息 */
  datasetName: '',
  coordinate: { up: 'z', forward: 'x', right: 'y' }, // 坐标约定，用于提示
  sensorHeight: 1.73, // 传感器离地高度，决定地平面 z=-sensorHeight
  camera: null, // 数据集预设相机 { position, target }

  /* 帧与当前索引 */
  frames: [],
  currentIndex: -1,
  groundTruthUrl: null, // 全量真值文件地址（scene.groundTruth）

  /* 类别 */
  classes: DEFAULT_CLASSES.map((c) => ({ ...c })),
  activeClassId: 0,

  /* 交互与显示 */
  tool: 'select', // select | translate | rotate | scale | line | arrow
  colorMode: 'intensity', // intensity | height | source | label
  pointSize: 2, // 像素单位
  playing: false, // 时间轴播放中
  multiFrame: false, // 多帧添加开关
  multiFrameMove: true, // 多帧移动开关：移动/旋转/缩放时联动后续帧
  backgroundColor: '#0d1117',

  /* 标线绘制 */
  lineWidth: 0.15, // 车道线宽（米）
  arrowWidth: 0.35, // 箭头线宽（米）
  arrowTemplate: 'free', // free | straight | left | right | straightLeft | uturn
  drawHeading: 0, // 模板箭头朝向（度）
  draftCount: 0, // 当前绘制草稿的顶点数
  snapToPoints: true, // 拖拽标线顶点时是否吸附到最近的点云
  lastBoxClassId: 0, // 进入绘制前使用的框类别，退出时恢复

  selectedObjectId: null, // 单选主对象（兼容原有属性面板/手柄逻辑）
  selectedObjectIds: [], // 多选集合（当前帧对象 id）
  clipboardCount: 0, // 内部剪贴板对象数
  lockSkipCount: 0, // 多帧传播时跳过已提交/已通过帧的数量（供 UI 提示）
  gtLoading: false, // 正在加载全量真值
  gtPending: false, // 已安排延迟导入全量真值（等待中）

  /* 本地草稿 */
  editVersion: 0, // 标注/点标签变更版本号（驱动草稿自动保存）
  editedFrames: new Set(), // 本次会话中编辑过、待写入草稿的帧
  dirty: false, // 有尚未写入 IndexedDB 的编辑
  draftSaving: false,
  draftSavedAt: 0,
  draftUpdatedAt: 0,
  draftRestored: 0,
  draftError: '',

  /* 点级分割 */
  segEnabled: false,
  segMode: 'rect', // rect | brush | lasso
  segOverwrite: true, // 新画的标签是否覆盖已有标签
  brushSize: 24,
  selectionCount: 0,
  selectedSegment: null, // 当前选中的语义标签片段 { id, classId, count }
  measureEnabled: false, // 测量模式
  measureText: '', // 最近一次测量结果
  lastLabel: null, // 最近一次自动生成的标签 { classId, count }
  labelVersion: 0, // 标签数据版本号，用于触发面板刷新

  /* 加载/错误（error 由 App 监听后弹 message） */
  loading: false, // 点云加载中（逻辑状态）
  loadingVisible: false, // 超过 150ms 才显示的 loading 遮罩
  error: '',
})

bindHistory({ getFrames: () => state.frames })

/** 标记帧被编辑：驱动草稿自动保存与未保存提示 */
export function markFrameEdited(index = state.currentIndex, options = {}) {
  if (Number.isInteger(index) && index >= 0 && state.frames[index]) {
    state.editedFrames.add(index)
  }
  if (options.bumpVersion !== false) {
    state.editVersion++
    state.dirty = true
  }
}

/** 批量标记多个帧（多帧传播时只增加一次版本号） */
export function markFramesEdited(indexes) {
  let changed = false
  for (const index of new Set(indexes || [])) {
    if (Number.isInteger(index) && index >= 0 && state.frames[index]) {
      state.editedFrames.add(index)
      changed = true
    }
  }
  if (changed) {
    state.editVersion++
    state.dirty = true
  }
}

function markAllFramesEdited() {
  if (state.frames.length) markFramesEdited(state.frames.map((_, index) => index))
}

/** 供导入真值/项目后统一写回草稿 */
export function markAllFramesDirty() {
  markAllFramesEdited()
}

function pickValues(obj, keys) {
  const out = {}
  for (const key of keys) out[key] = cloneData(obj[key])
  return out
}

function geometrySnapshot(obj) {
  if (!isMarking(obj)) return null
  return obj.shape === 'line'
    ? { points: cloneData(obj.points) }
    : { paths: cloneData(obj.paths) }
}

function markingGeomFields(obj) {
  return obj?.shape === 'line' ? ['points'] : ['paths']
}

function makeChange(frameIndex, obj, before, after) {
  return { frameIndex, id: obj.id, before, after }
}

function pushChanges(label, changes, options = {}) {
  const list = (changes || []).filter(Boolean)
  if (!list.length) return null
  const frames = Array.from(new Set(list.map((change) => change.frameIndex))).filter(
    (index) => index >= 0,
  )
  return pushCommand({
    label,
    ops: [{ type: 'change', changes: list }],
    frames,
    mergeKey: options.mergeKey,
    mergeWindow: options.mergeWindow,
  })
}

function pushAdded(label, items) {
  if (!items?.length) return null
  return pushCommand({
    label,
    ops: [{ type: 'add', items: cloneData(items) }],
    frames: Array.from(new Set(items.map((item) => item.frameIndex))),
  })
}

function pushRemoved(label, items) {
  if (!items?.length) return null
  return pushCommand({
    label,
    ops: [{ type: 'remove', items: cloneData(items) }],
    frames: Array.from(new Set(items.map((item) => item.frameIndex))),
  })
}

/** 撤销标注编辑（不处理点标签，点标签仍走 viewer.undoLabel） */
export function undo() {
  try {
    const command = undoCommand()
    if (!command) return null
    markFramesEdited(command.frames)
    clearSelection()
    return command
  } catch (err) {
    state.error = err?.message || String(err)
    return null
  }
}

export function redo() {
  try {
    const command = redoCommand()
    if (!command) return null
    markFramesEdited(command.frames)
    clearSelection()
    return command
  } catch (err) {
    state.error = err?.message || String(err)
    return null
  }
}

/** 当前帧对象 */
export const currentFrame = computed(() => state.frames[state.currentIndex] || null)

/** 当前帧的标注列表 */
export const currentObjects = computed(() => {
  const f = currentFrame.value
  return f ? f.objects : []
})

/** 当前选中的全部对象（保持当前帧对象顺序） */
export const selectedObjects = computed(() => {
  const ids = state.selectedObjectIds
  if (!ids.length) return []
  const set = new Set(ids)
  return currentObjects.value.filter((o) => set.has(o.id))
})

/** 单选对象：只有恰好选中一个时返回，属性面板/单对象手柄使用 */
export const selectedObject = computed(() => {
  if (state.selectedObjectIds.length !== 1) return null
  const id = state.selectedObjectIds[0]
  return currentObjects.value.find((o) => o.id === id) || null
})

/** 当前激活类别（新建框时使用） */
export const activeClass = computed(
  () => state.classes.find((c) => c.id === state.activeClassId) || state.classes[0] || null,
)

export function classById(id) {
  return state.classes.find((c) => c.id === id) || null
}

export function classByName(name) {
  return state.classes.find((c) => c.name === name) || null
}

/** 取类别颜色，找不到时给灰色兜底 */
export function classColor(id) {
  const c = classById(id)
  return c ? c.color : '#8899aa'
}

/** 按名称取类别，不存在则新建（导入真值/KITTI 时用） */
export function ensureClass(name) {
  const found = classByName(name)
  if (found) return found.id
  const id = classSeq++
  state.classes.push({ id, name, color: randomColor() })
  return id
}

function randomColor() {
  return hslToHex(Math.floor(Math.random() * 360), 62, 58)
}

/** HSL -> #RRGGBB，用于自动分配新类别颜色 */
function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0')
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`
}

/* ---------------- 数据集 / 帧 ---------------- */

/** 清空数据集相关状态（保留类别与显示设置） */
export function reset() {
  state.datasetName = ''
  state.frames = []
  state.currentIndex = -1
  state.groundTruthUrl = null
  state.selectedObjectId = null
  state.selectedObjectIds = []
  state.selectedSegment = null
  state.lastLabel = null
  state.selectionCount = 0
  state.measureEnabled = false
  state.measureText = ''
  state.gtLoading = false
  state.gtPending = false
  state.loading = false
  state.loadingVisible = false
  state.editVersion++
  state.editedFrames.clear()
  state.dirty = false
  state.draftSaving = false
  state.draftError = ''
  state.draftRestored = 0
  state.draftUpdatedAt = 0
  state.draftSavedAt = 0
  clearHistory()
  groundTruthToken++
  clipboard = []
  pasteSerial = 0
  state.clipboardCount = 0
  state.error = ''
}

/**
 * 由 scene.json 载入数据集
 * @param {object} scene 场景描述（name/coordinate/sensor/classes/camera/frames）
 * @param {string} baseUrl 帧文件与真值文件的基地址
 */
export function setScene(scene, baseUrl) {
  reset()
  state.datasetName = scene.name || 'dataset'
  state.coordinate = scene.coordinate || state.coordinate
  state.sensorHeight = scene.sensor?.height ?? state.sensorHeight
  state.camera = scene.camera
    ? { ...scene.camera, intrinsics: scene.camera.intrinsics || defaultIntrinsics() }
    : null
  state.groundTruthUrl = scene.groundTruth ? joinUrl(baseUrl, scene.groundTruth) : null
  if (Array.isArray(scene.classes) && scene.classes.length) {
    state.classes = scene.classes.map((c) => ({ ...c }))
    classSeq = Math.max(100, ...state.classes.map((c) => c.id)) + 1
  }
  // 类别表可能整体替换，必须把当前类别校正到实际存在的 id
  const firstClassId = state.classes[0]?.id ?? 0
  if (!state.classes.some((c) => c.id === state.activeClassId)) state.activeClassId = firstClassId
  if (!state.classes.some((c) => c.id === state.lastBoxClassId)) state.lastBoxClassId = firstClassId
  state.selectedObjectId = null
  state.selectedObjectIds = []
  // 每帧优先使用 bin，其次 pcd/ply；三个字段任一存在即可
  state.frames = (scene.frames || []).map((f, i) => {
    const file = f.bin || f.pcd || f.ply
    const ext = f.bin ? 'bin' : f.pcd ? 'pcd' : f.ply ? 'ply' : 'bin'
    return {
      index: f.index ?? i,
      name: file || `frame_${String(i).padStart(6, '0')}`,
      timestamp: f.timestamp ?? i,
      ext,
      source: { kind: 'url', ext, url: joinUrl(baseUrl, file) },
      labelUrl: f.label ? joinUrl(baseUrl, f.label) : null,
      pointLabelsUrl: f.pointLabels ? joinUrl(baseUrl, f.pointLabels) : null,
      imageUrl: f.image ? joinUrl(baseUrl, f.image) : null,
      pointCount: f.points ?? null,
      objects: [],
      loaded: false,
    }
  })
  state.currentIndex = state.frames.length ? 0 : -1
}

/** 示例数据集根目录（由 gen-test-data 生成） */
const SAMPLE_BASE = `${import.meta.env.BASE_URL || '/'}test-data/datasets`.replace(/\/{2,}/g, '/')
let sampleIndexCache = null

/** 读取示例数据集索引（带缓存），供工具栏下拉使用 */
export async function listSampleDatasets() {
  if (sampleIndexCache) return sampleIndexCache
  try {
    const data = await get(`${SAMPLE_BASE}/index.json`, null, { silent: true })
    sampleIndexCache = (data && data.datasets) || []
    return sampleIndexCache
  } catch (err) {
    throw new Error(`示例数据集索引不可用 (${err.message})，请先运行 npm run gen:test-data`, {
      cause: err,
    })
  }
}

/** 加载指定 id 的示例数据集 */
export async function loadSampleDataset(id) {
  let scene
  try {
    scene = await get(`${SAMPLE_BASE}/${id}/scene.json`, null, { silent: true })
  } catch (err) {
    throw new Error(`示例数据集「${id}」不可用：${err.message}`, { cause: err })
  }
  setScene(scene, `${SAMPLE_BASE}/${id}`)
  // 延迟导入全量真值：先让第一帧点云独占网络/主线程，避免首屏被 7k+ 对象导入拖慢
  scheduleGroundTruthImport()
  return scene
}

/** 取消尚未执行的延迟真值导入（手动重新导入时调用） */
export function cancelScheduledGroundTruth() {
  groundTruthToken++
}

/** 延迟导入全量真值（仅当数据集提供 groundTruth 文件） */
export function scheduleGroundTruthImport(delay = 600) {
  const url = state.groundTruthUrl
  if (!url) {
    state.gtPending = false
    return
  }
  const token = ++groundTruthToken
  state.gtPending = true
  setTimeout(() => {
    if (token !== groundTruthToken || state.groundTruthUrl !== url) {
      state.gtPending = false
      return
    }
    // 用户在延迟期间已经开始手工标注时，不要覆盖
    const hasManual = state.frames.some((f) =>
      f.objects.some((o) => o.source === 'manual' || o.source === 'copy'),
    )
    if (hasManual) {
      state.gtPending = false
      return
    }
    state.gtLoading = true
    importAllGroundTruth({ preserveManual: true })
      .catch((err) => {
        if (token !== groundTruthToken) return
        state.error = `全量真值加载失败: ${err?.message || String(err)}`
      })
      .finally(() => {
        if (token === groundTruthToken) {
          state.gtLoading = false
          state.gtPending = false
        }
      })
  }, delay)
}

/** 加载第一个示例数据集 */
export async function loadFirstSampleDataset() {
  const list = await listSampleDatasets()
  if (!list.length) throw new Error('没有可用的示例数据集')
  return loadSampleDataset(list[0].id)
}

/**
 * 由本地文件（可多选）构建单/多帧数据集
 * 每个文件视为一帧，按选择顺序排列
 */
export function loadLocalFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  reset()
  // 用首个文件名区分不同的本地批次，避免复用上一次「local」的审核记录
  state.datasetName =
    files.length === 1 ? files[0].name : `local:${files[0].name}+${files.length - 1}`
  state.frames = files.map((file, i) => {
    const ext = pathExt(file.name) || 'bin'
    return {
      index: i,
      name: file.name,
      timestamp: i,
      ext,
      source: { kind: 'file', ext, file },
      labelUrl: null,
      pointLabelsUrl: null,
      pointCount: null,
      objects: [],
      loaded: false,
    }
  })
  state.currentIndex = 0
}

/** 拼接 URL：相对路径补上 base，绝对/协议地址原样返回 */
function joinUrl(base, rel) {
  if (!rel) return null
  if (/^https?:|^\//.test(rel)) return rel
  return `${base.replace(/\/$/, '')}/${rel}`
}

/** 切换当前帧（越界忽略；切换后清空选中） */
export function setCurrentIndex(i) {
  if (i < 0 || i >= state.frames.length) return
  state.currentIndex = i
  state.selectedObjectId = null
  state.selectedObjectIds = []
  state.selectedSegment = null
  state.lastLabel = null
}

/** 相对切换帧 */
export function step(delta) {
  setCurrentIndex(state.currentIndex + delta)
}

/** 标记标签数据已变更（供分割面板刷新统计） */
export function bumpLabelVersion() {
  state.labelVersion++
}

/* ---------------- 标注对象 ---------------- */

/**
 * 新增标注对象
 * @param {object} partial 位置/尺寸/类别等字段（缺省使用当前激活类别与默认尺寸）
 * @param {object} [options]
 * @param {boolean} [options.propagate] 是否多帧添加：true 时在当前帧及之后所有帧各建一份
 *                                      （共享 trackId，startFrame=当前帧，之前帧不含它 => 隐藏）
 * @returns {object|null} 当前帧新建的对象
 */
export function addObject(partial, options = {}) {
  const frame = currentFrame.value
  if (!frame || currentFrameLocked()) return null
  const cls = activeClass.value
  const propagate = options.propagate ?? state.multiFrame
  const trackId = propagate ? nextTrackId() : (partial.trackId ?? 0)
  const startFrame = propagate ? state.currentIndex : (partial.startFrame ?? state.currentIndex)
  const template = {
    trackId,
    startFrame,
    multiFrame: propagate,
    classId: partial.classId ?? (cls ? cls.id : 0),
    type: partial.type ?? (cls ? cls.name : 'Object'),
    h: partial.h ?? 1.5,
    w: partial.w ?? 1.7,
    l: partial.l ?? 4.0,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    z: partial.z ?? 0,
    ry: partial.ry ?? 0,
    truncated: partial.truncated ?? 0,
    occluded: partial.occluded ?? 0,
    alpha: partial.alpha ?? 0,
    difficulty: partial.difficulty ?? 0,
    score: partial.score ?? 1,
    source: partial.source ?? 'manual',
  }
  const last = propagate ? state.frames.length - 1 : state.currentIndex
  let first = null
  const created = []
  const edited = []
  for (let j = state.currentIndex; j <= last; j++) {
    if (j !== state.currentIndex && isFrameLocked(j)) {
      noteLockedSkip()
      continue
    }
    const obj = { ...template, id: uid('obj') } // 每帧独立 id，靠 trackId 关联
    state.frames[j].objects.push(obj)
    created.push({ frameIndex: j, index: state.frames[j].objects.length - 1, obj })
    edited.push(j)
    if (!first) first = obj
  }
  if (created.length) {
    markFramesEdited(edited)
    pushAdded('添加对象', created)
  }
  state.selectedObjectIds = first ? [first.id] : []
  syncSelectedObjectId()
  return first
}

/**
 * 新增标线（线 / 箭头）
 * @param {object} partial
 * @param {'line'|'arrow'} partial.shape
 * @param {number[][]} [partial.points] 线顶点
 * @param {number[][][]} [partial.paths] 箭头路径
 * @param {number} [partial.width] 线宽（米）
 * @param {object} [options] { propagate }
 * @returns {object|null} 当前帧新建的标线
 */
export function addPolyline(partial, options = {}) {
  const frame = currentFrame.value
  if (!frame || currentFrameLocked()) return null
  const shape = partial.shape === 'arrow' ? 'arrow' : 'line'
  const clsName = partial.type || MARKING_CLASS[shape]
  let cls = partial.classId != null ? classById(partial.classId) : classByName(clsName)
  if (!cls && partial.classId == null) cls = classById(ensureClass(clsName))
  const propagate = options.propagate ?? state.multiFrame
  const trackId = propagate ? nextTrackId() : (partial.trackId ?? 0)
  const startFrame = propagate ? state.currentIndex : (partial.startFrame ?? state.currentIndex)
  const template = {
    shape,
    trackId,
    startFrame,
    multiFrame: propagate,
    classId: partial.classId ?? cls?.id ?? state.activeClassId,
    type: partial.type ?? cls?.name ?? (shape === 'arrow' ? 'RoadArrow' : 'LaneLine'),
    width: partial.width ?? (shape === 'arrow' ? state.arrowWidth : state.lineWidth),
    source: partial.source ?? 'manual',
  }
  if (shape === 'line') template.points = clonePoints(partial.points)
  else {
    template.paths = clonePaths(partial.paths)
    template.template = partial.template ?? null
  }
  const last = propagate ? state.frames.length - 1 : state.currentIndex
  let first = null
  const created = []
  const edited = []
  for (let j = state.currentIndex; j <= last; j++) {
    if (j !== state.currentIndex && isFrameLocked(j)) {
      noteLockedSkip()
      continue
    }
    const item = { ...template, id: uid('mark') }
    if (shape === 'line') item.points = clonePoints(template.points)
    else item.paths = clonePaths(template.paths)
    state.frames[j].objects.push(item)
    created.push({ frameIndex: j, index: state.frames[j].objects.length - 1, obj: item })
    edited.push(j)
    if (!first) first = item
  }
  if (created.length) {
    markFramesEdited(edited)
    pushAdded(shape === 'arrow' ? '添加箭头' : '添加标线', created)
  }
  state.selectedObjectIds = first ? [first.id] : []
  syncSelectedObjectId()
  return first
}

/** 判断是否为标线对象 */
export function isMarking(obj) {
  return !!obj && (obj.shape === 'line' || obj.shape === 'arrow')
}

/**
 * 更新标线的单个顶点（line.points / arrow.paths[pathIndex]）
 * @param {string} id 对象 id
 * @param {number} index 顶点索引
 * @param {[number,number,number]} point 新坐标
 * @param {number} [pathIndex] 箭头路径索引（线忽略）
 */
export function setPolylinePoint(id, index, point, pathIndex = 0) {
  if (currentFrameLocked()) return
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  const arr = obj.shape === 'line' ? obj.points : obj.paths?.[pathIndex]
  if (!arr || index < 0 || index >= arr.length) return
  const before = geometrySnapshot(obj)
  arr[index] = [point[0], point[1], point[2] ?? arr[index][2] ?? 0]
  const changes = [makeChange(state.currentIndex, obj, before, geometrySnapshot(obj))]
  changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges('编辑标线顶点', changes, {
    mergeKey: `vertex:${id}:${index}:${pathIndex}`,
    mergeWindow: 1200,
  })
}

/** 删除标线的单个顶点（至少保留 2 个） */
export function deletePolylinePoint(id, index, pathIndex = 0) {
  if (currentFrameLocked()) return false
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return false
  const arr = obj.shape === 'line' ? obj.points : obj.paths?.[pathIndex]
  if (!arr || arr.length <= 2 || index < 0 || index >= arr.length) return false
  const before = geometrySnapshot(obj)
  arr.splice(index, 1)
  if (obj.shape === 'line') obj.template = null
  const changes = [makeChange(state.currentIndex, obj, before, geometrySnapshot(obj))]
  changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges('删除标线顶点', changes)
  return true
}

/** 在指定顶点之后插入一个顶点（默认取两点中点） */
export function insertPolylinePoint(id, index, pathIndex = 0) {
  if (currentFrameLocked()) return false
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return false
  const arr = obj.shape === 'line' ? obj.points : obj.paths?.[pathIndex]
  if (!arr || index < 0 || index >= arr.length - 1) return false
  const a = arr[index]
  const b = arr[index + 1]
  const point = [
    (Number(a[0]) + Number(b[0])) / 2,
    (Number(a[1]) + Number(b[1])) / 2,
    (Number(a[2] ?? 0) + Number(b[2] ?? 0)) / 2,
  ]
  const before = geometrySnapshot(obj)
  arr.splice(index + 1, 0, point)
  const changes = [makeChange(state.currentIndex, obj, before, geometrySnapshot(obj))]
  changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges('插入标线顶点', changes)
  return true
}

/**
 * 绕质心旋转标线（弧度）
 * @param {string} id
 * @param {number} angle 弧度，正值逆时针（俯视）
 */
export function rotatePolyline(id, angle) {
  if (currentFrameLocked()) return
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  const before = geometrySnapshot(obj)
  if (obj.shape === 'line') {
    obj.points = rotatePoints(obj.points, angle, polylineCentroid(obj.points))
  } else {
    const center = markingCentroid(obj)
    obj.paths = obj.paths.map((p) => rotatePoints(p, angle, center))
  }
  const changes = [makeChange(state.currentIndex, obj, before, geometrySnapshot(obj))]
  changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges('旋转标线', changes, { mergeKey: `rotate-mark:${id}`, mergeWindow: 800 })
}

/** 绕质心缩放标线 */
export function scalePolyline(id, factor) {
  if (currentFrameLocked()) return
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  const before = geometrySnapshot(obj)
  if (obj.shape === 'line') {
    obj.points = scalePoints(obj.points, factor, polylineCentroid(obj.points))
  } else {
    const center = markingCentroid(obj)
    obj.paths = obj.paths.map((p) => scalePoints(p, factor, center))
  }
  const changes = [makeChange(state.currentIndex, obj, before, geometrySnapshot(obj))]
  changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges('缩放标线', changes, { mergeKey: `scale-mark:${id}`, mergeWindow: 800 })
}

/** 箭头所有路径合起来的质心 */
export function markingCentroid(obj) {
  if (!isMarking(obj)) return [0, 0, 0]
  const all = obj.shape === 'line' ? obj.points : (obj.paths || []).flat()
  return polylineCentroid(all)
}

/** 标线变更同步到后续帧同一 track（多帧移动开启时），返回每帧的变化记录 */
function propagateMarkingChange(obj, { points, paths }) {
  const changes = []
  if (!state.multiFrameMove || !obj.multiFrame || !(obj.trackId > 0)) return changes
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    const targets = state.frames[j].objects.filter(
      (o) => o.trackId === obj.trackId && isMarking(o),
    )
    if (!targets.length) continue
    if (isFrameLocked(j)) {
      noteLockedSkip()
      continue
    }
    for (const o of targets) {
      const before = geometrySnapshot(o)
      if (o.shape === 'line' && points) o.points = clonePoints(points)
      if (o.shape === 'arrow' && paths) o.paths = clonePaths(paths)
      const after = geometrySnapshot(o)
      changes.push(makeChange(j, o, before, after))
    }
  }
  return changes
}

/**
 * 切换工具，并在进入/退出标线绘制时自动切换类别
 *  - line  -> LaneLine
 *  - arrow -> RoadArrow
 *  - 退出绘制 -> 恢复进入前的框类别
 */
export function setTool(tool) {
  if (tool !== 'select' && state.measureEnabled) state.measureEnabled = false
  const wasDraw = state.tool === 'line' || state.tool === 'arrow'
  const isDraw = tool === 'line' || tool === 'arrow'
  if (isDraw && !wasDraw) state.lastBoxClassId = state.activeClassId
  if (!isDraw && wasDraw) state.activeClassId = state.lastBoxClassId
  if (isDraw) {
    const cls = classByName(MARKING_CLASS[tool])
    if (cls) state.activeClassId = cls.id
    state.segEnabled = false
    state.selectedObjectId = null
  }
  state.tool = tool
  if (!isDraw) state.draftCount = 0
}

/**
 * 更新当前帧某个对象（改类别时同步 type 名称）
 * 若开启「多帧移动」且该对象属于某条 track，则把本次的**增量**同步到之后所有帧的
 * 同一 track 对象上（保持各帧之间的相对运动不被抹平）。
 */
export function updateObject(id, patch, options = {}) {
  if (currentFrameLocked()) return []
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!obj) return []
  const keys = Object.keys(patch)
  if (!keys.length) return []
  // 改类别时 type 会跟着变，撤销/重做必须一起恢复
  const changedKeys = patch.classId !== undefined
    ? Array.from(new Set([...keys, 'type']))
    : keys
  const changes = []
  // 记录变更前的值，用于计算增量与撤销
  const before = pickValues(obj, changedKeys)

  Object.assign(obj, patch)
  if (patch.classId !== undefined) {
    const c = classById(patch.classId)
    if (c) obj.type = c.name
  }
  const after = pickValues(obj, changedKeys)
  changes.push(makeChange(state.currentIndex, obj, before, after))

  if (isMarking(obj)) {
    // 标线的几何由顶点描述，走 setPolylinePoint 等专用接口；
    // 这里只同步类别/线宽等标量字段
    if (patch.width !== undefined) {
      // 记住最近一次使用的线宽：下次画同类标线时沿用（在属性面板改宽也会同步到工具栏）
      if (obj.shape === 'arrow') state.arrowWidth = obj.width
      else state.lineWidth = obj.width
    }
    if (state.multiFrameMove && obj.multiFrame && obj.trackId > 0) {
      const syncKeys = ['classId', 'type', 'width']
      for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
        const targets = state.frames[j].objects.filter(
          (o) => o.trackId === obj.trackId && isMarking(o),
        )
        if (!targets.length) continue
        if (isFrameLocked(j)) {
          noteLockedSkip()
          continue
        }
        for (const o of targets) {
          const targetBefore = pickValues(o, syncKeys)
          if (patch.classId !== undefined) o.classId = obj.classId
          if (patch.classId !== undefined || patch.type !== undefined) o.type = obj.type
          if (patch.width !== undefined) o.width = obj.width
          changes.push(makeChange(j, o, targetBefore, pickValues(o, syncKeys)))
        }
      }
    }
  } else if (state.multiFrameMove && obj.multiFrame && obj.trackId > 0) {
    propagateDeltaToTrack(obj, patch, before, changedKeys, changes)
  }

  if (options.record === false) return changes
  markFramesEdited(changes.map((change) => change.frameIndex))
  pushChanges(options.label || (isMarking(obj) ? '修改标线' : '修改对象'), changes, {
    mergeKey: options.mergeKey ?? `update:${id}`,
    mergeWindow: options.mergeWindow ?? 800,
  })
  return changes
}

/** 只有位姿/尺寸字段按增量同步，类别、分数、属性字段直接取同值 */
const DELTA_FIELDS = new Set(['x', 'y', 'z', 'h', 'w', 'l', 'ry'])

/** 把 patch 的增量应用到之后所有帧中同一 trackId 的对象 */
function propagateDeltaToTrack(obj, patch, before, changedKeys, changes) {
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    const targets = state.frames[j].objects.filter((o) => o.trackId === obj.trackId)
    if (!targets.length) continue
    if (isFrameLocked(j)) {
      noteLockedSkip()
      continue
    }
    for (const o of targets) {
      const targetBefore = pickValues(o, changedKeys)
      for (const k of Object.keys(patch)) {
        if (
          DELTA_FIELDS.has(k) &&
          typeof patch[k] === 'number' &&
          typeof before[k] === 'number'
        ) {
          o[k] = o[k] + (patch[k] - before[k])
        } else {
          o[k] = cloneData(patch[k]) // 类别等非增量字段直接取同值
        }
      }
      if (patch.classId !== undefined) {
        const c = classById(patch.classId)
        if (c) o.type = c.name
      }
      changes.push(makeChange(j, o, targetBefore, pickValues(o, changedKeys)))
    }
  }
}

/**
 * 删除对象
 * @param {string} id 当前帧对象 id
 * @param {object} [options]
 * @param {boolean} [options.propagate] 是否从当前帧起删除后续所有帧中同 trackId 的对象
 *                                      （默认对多帧物体生效）
 */
export function removeObject(id, options = {}) {
  const frame = currentFrame.value
  if (!frame || currentFrameLocked()) return
  const obj = frame.objects.find((o) => o.id === id)
  if (!obj) return
  const propagate = options.propagate ?? !!obj.multiFrame
  const removed = []
  const edited = []
  if (propagate && obj.trackId > 0) {
    for (let j = state.currentIndex; j < state.frames.length; j++) {
      const objects = state.frames[j].objects
      if (!objects.some((o) => o.trackId === obj.trackId)) continue
      if (j !== state.currentIndex && isFrameLocked(j)) {
        noteLockedSkip()
        continue
      }
      for (let k = objects.length - 1; k >= 0; k--) {
        if (objects[k].trackId === obj.trackId) {
          removed.push({ frameIndex: j, index: k, obj: cloneData(objects[k]) })
          objects.splice(k, 1)
          if (!edited.includes(j)) edited.push(j)
        }
      }
    }
  } else {
    const idx = frame.objects.findIndex((o) => o.id === id)
    if (idx !== -1) {
      removed.push({ frameIndex: state.currentIndex, index: idx, obj: cloneData(frame.objects[idx]) })
      frame.objects.splice(idx, 1)
      edited.push(state.currentIndex)
    }
  }
  if (removed.length) {
    markFramesEdited(edited)
    pushRemoved(obj.multiFrame ? '删除多帧对象' : '删除对象', removed)
  }
  state.selectedObjectIds = state.selectedObjectIds.filter((x) => x !== id)
  syncSelectedObjectId()
}

/** 删除一条轨迹（可指定从某一帧起） */
export function removeTrack(trackId, { fromFrame = 0 } = {}) {
  if (!trackId) return { removed: 0, skipped: 0 }
  if (currentFrameLocked()) return { removed: 0, skipped: 0 }
  const removed = []
  const edited = []
  let skipped = 0
  for (let j = Math.max(0, fromFrame); j < state.frames.length; j++) {
    const objects = state.frames[j].objects
    const matches = objects.filter((o) => o.trackId === trackId)
    if (!matches.length) continue
    if (j !== state.currentIndex && isFrameLocked(j)) {
      skipped++
      continue
    }
    for (let k = objects.length - 1; k >= 0; k--) {
      if (objects[k].trackId === trackId) {
        removed.push({ frameIndex: j, index: k, obj: cloneData(objects[k]) })
        objects.splice(k, 1)
        if (!edited.includes(j)) edited.push(j)
      }
    }
  }
  if (removed.length) {
    markFramesEdited(edited)
    pushRemoved('删除轨迹', removed)
    state.selectedObjectIds = state.selectedObjectIds.filter(
      (id) => !removed.some((item) => item.obj.id === id),
    )
    syncSelectedObjectId()
  }
  if (skipped) state.lockSkipCount += skipped
  return { removed: removed.length, skipped }
}

/** 把 fromTrackId 合并到 toTrackId：冲突帧保留目标对象，其余帧改 trackId */
export function mergeTracks(fromTrackId, toTrackId) {
  if (!fromTrackId || !toTrackId || fromTrackId === toTrackId) {
    return { merged: 0, removed: 0, skipped: 0 }
  }
  const changes = []
  const removed = []
  const edited = []
  let skipped = 0
  for (let j = 0; j < state.frames.length; j++) {
    const objects = state.frames[j].objects
    const sources = objects.filter((o) => o.trackId === fromTrackId)
    if (!sources.length) continue
    if (isFrameLocked(j)) {
      skipped++
      continue
    }
    const hasTarget = objects.some((o) => o.trackId === toTrackId)
    for (const source of sources) {
      if (hasTarget) {
        const index = objects.findIndex((o) => o.id === source.id)
        if (index !== -1) {
          removed.push({ frameIndex: j, index, obj: cloneData(source) })
          objects.splice(index, 1)
        }
      } else {
        const before = pickValues(source, ['trackId', 'multiFrame'])
        source.trackId = toTrackId
        source.multiFrame = true
        changes.push(makeChange(j, source, before, pickValues(source, ['trackId', 'multiFrame'])))
      }
      if (!edited.includes(j)) edited.push(j)
    }
  }
  const ops = []
  if (changes.length) ops.push({ type: 'change', changes })
  if (removed.length) ops.push({ type: 'remove', items: removed })
  if (ops.length) {
    markFramesEdited(edited)
    pushCommand({ label: '合并轨迹', ops, frames: edited })
  }
  if (skipped) state.lockSkipCount += skipped
  return { merged: changes.length, removed: removed.length, skipped }
}

/** 从指定帧起把轨迹拆分到一个新 trackId */
export function splitTrack(trackId, frameIndex = state.currentIndex) {
  if (!trackId) return { split: 0, newTrackId: 0, skipped: 0 }
  let maxTrack = trackSeq
  state.frames.forEach((f) =>
    f.objects.forEach((o) => {
      if (o.trackId > maxTrack) maxTrack = o.trackId
    }),
  )
  const newTrackId = maxTrack + 1
  const changes = []
  const edited = []
  let skipped = 0
  for (let j = frameIndex; j < state.frames.length; j++) {
    const objects = state.frames[j].objects.filter((o) => o.trackId === trackId)
    if (!objects.length) continue
    if (isFrameLocked(j)) {
      skipped++
      continue
    }
    for (const obj of objects) {
      const before = pickValues(obj, ['trackId'])
      obj.trackId = newTrackId
      changes.push(makeChange(j, obj, before, pickValues(obj, ['trackId'])))
      if (!edited.includes(j)) edited.push(j)
    }
  }
  if (changes.length) {
    trackSeq = Math.max(trackSeq, newTrackId)
    markFramesEdited(edited)
    pushChanges('拆分轨迹', changes)
  }
  if (skipped) state.lockSkipCount += skipped
  return { split: changes.length, newTrackId, skipped }
}

/** 统计某 trackId 出现在多少帧中 */
export function countTrackFrames(trackId) {
  let count = 0
  for (const f of state.frames) {
    if (f.objects.some((o) => o.trackId === trackId)) count++
  }
  return count
}

/** 汇总所有轨迹，供轨迹管理面板使用 */
export function listTracks() {
  const map = new Map()
  state.frames.forEach((frame, frameIndex) => {
    for (const obj of frame.objects) {
      if (!(obj.trackId > 0)) continue
      let info = map.get(obj.trackId)
      if (!info) {
        info = {
          trackId: obj.trackId,
          type: obj.type || 'Object',
          classId: obj.classId,
          shape: obj.shape || 'box',
          source: obj.source || '',
          multiFrame: !!obj.multiFrame,
          first: frameIndex,
          last: frameIndex,
          frameCount: 0,
          frames: [],
          instances: [],
        }
        map.set(obj.trackId, info)
      }
      info.last = frameIndex
      info.frameCount++
      info.frames.push(frameIndex)
      info.instances.push({ frameIndex, id: obj.id })
      info.type = obj.type || info.type
      info.classId = obj.classId ?? info.classId
      info.multiFrame = info.multiFrame || !!obj.multiFrame
    }
  })
  return Array.from(map.values()).sort(
    (a, b) => a.first - b.first || a.trackId - b.trackId,
  )
}

/** 跨帧搜索对象（按类别/类型/trackId/source），最多返回 limit 条 */
export function searchObjects({ keyword = '', classId = null, source = '', limit = 200 } = {}) {
  const text = String(keyword || '').trim().toLowerCase()
  const max = Math.max(1, Number(limit) || 200)
  const results = []
  for (let frameIndex = 0; frameIndex < state.frames.length; frameIndex++) {
    const frame = state.frames[frameIndex]
    for (const obj of frame.objects) {
      if (classId !== null && classId !== undefined && obj.classId !== classId) continue
      if (source && obj.source !== source) continue
      if (text) {
        const haystack = `${obj.type || ''} ${obj.trackId || ''} ${obj.id || ''} ${obj.source || ''}`.toLowerCase()
        if (!haystack.includes(text)) continue
      }
      results.push({ frameIndex, frameName: frame.name, object: obj })
      if (results.length >= max) return results
    }
  }
  return results
}

/**
 * 把当前对象的位姿/尺寸/类别同步到之后所有帧的同 trackId 对象
 * @returns {number} 被更新的对象数量
 */
export function syncTrackForward(id) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!obj || !obj.trackId || currentFrameLocked()) return 0
  const props = isMarking(obj)
    ? {
        classId: obj.classId,
        type: obj.type,
        width: obj.width,
        ...(obj.shape === 'line'
          ? { points: clonePoints(obj.points), template: null }
          : { paths: clonePaths(obj.paths), template: obj.template }),
      }
    : {
        classId: obj.classId,
        type: obj.type,
        h: obj.h,
        w: obj.w,
        l: obj.l,
        x: obj.x,
        y: obj.y,
        z: obj.z,
        ry: obj.ry,
      }
  let count = 0
  const changes = []
  const edited = []
  const keys = isMarking(obj)
    ? ['classId', 'type', 'width', ...markingGeomFields(obj)]
    : ['classId', 'type', 'h', 'w', 'l', 'x', 'y', 'z', 'ry']
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    const targets = state.frames[j].objects.filter((o) => o.trackId === obj.trackId)
    if (!targets.length) continue
    if (isFrameLocked(j)) {
      noteLockedSkip()
      continue
    }
    for (const o of targets) {
      const before = pickValues(o, keys)
      Object.assign(o, props)
      if (isMarking(o)) {
        // 深拷贝，避免后续帧共享同一顶点数组
        if (o.shape === 'line' && props.points) o.points = clonePoints(props.points)
        if (o.shape === 'arrow' && props.paths) o.paths = clonePaths(props.paths)
      }
      changes.push(makeChange(j, o, before, pickValues(o, keys)))
      if (!edited.includes(j)) edited.push(j)
      count++
    }
  }
  if (count) {
    markFramesEdited(edited)
    pushChanges('同步轨迹位姿', changes)
  }
  return count
}

/**
 * 轨迹插值：在当前对象前后两个已存在帧之间补齐缺失帧。
 * @param {string} id 当前帧对象 id
 * @returns {{filled:number, skipped:number, from:number, to:number}}
 */
export function interpolateTrack(id) {
  if (currentFrameLocked()) throw new Error('当前帧已提交/已通过，不能插值')
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!obj) throw new Error('请先选中一个对象')
  if (isMarking(obj)) throw new Error('轨迹插值目前只支持 3D 框')
  if (!obj.trackId) throw new Error('该对象没有 trackId，无法插值')

  let prev = null
  let next = null
  for (let index = 0; index < state.frames.length; index++) {
    const found = state.frames[index].objects.find((o) => o.trackId === obj.trackId)
    if (!found) continue
    if (index < state.currentIndex) prev = { index, object: found }
    else if (index > state.currentIndex && !next) next = { index, object: found }
  }
  const start = prev || { index: state.currentIndex, object: obj }
  const end = next || { index: state.currentIndex, object: obj }
  if (!prev && !next) throw new Error('该轨迹没有可插值的相邻帧')

  let filled = 0
  let skipped = 0
  const span = end.index - start.index
  const created = []
  const edited = []
  for (let index = start.index + 1; index < end.index; index++) {
    const frame = state.frames[index]
    if (frame.objects.some((o) => o.trackId === obj.trackId)) continue
    if (isFrameLocked(index)) {
      skipped++
      continue
    }
    const t = (index - start.index) / span
    let ryDelta = (end.object.ry || 0) - (start.object.ry || 0)
    while (ryDelta > Math.PI) ryDelta -= Math.PI * 2
    while (ryDelta < -Math.PI) ryDelta += Math.PI * 2
    const createdObj = {
      id: uid('obj'),
      trackId: obj.trackId,
      startFrame: start.index,
      multiFrame: true,
      classId: start.object.classId,
      type: start.object.type,
      h: start.object.h,
      w: start.object.w,
      l: start.object.l,
      x: start.object.x + (end.object.x - start.object.x) * t,
      y: start.object.y + (end.object.y - start.object.y) * t,
      z: start.object.z + (end.object.z - start.object.z) * t,
      ry: (start.object.ry || 0) + ryDelta * t,
      truncated: start.object.truncated ?? 0,
      occluded: start.object.occluded ?? 0,
      alpha: start.object.alpha ?? 0,
      difficulty: start.object.difficulty ?? 0,
      score: 1,
      source: 'interp',
    }
    frame.objects.push(createdObj)
    created.push({ frameIndex: index, index: frame.objects.length - 1, obj: createdObj })
    edited.push(index)
    filled++
  }
  if (created.length) {
    markFramesEdited(edited)
    pushAdded('轨迹插值', created)
  }
  if (skipped) state.lockSkipCount += skipped
  return { filled, skipped, from: start.index, to: end.index }
}

/** 清空当前帧的全部标注 */
export function clearObjects() {
  if (currentFrameLocked()) return
  const frame = currentFrame.value
  if (!frame) return
  const objects = cloneData(frame.objects)
  if (!objects.length) return
  const frameIndex = state.currentIndex
  frame.objects.splice(0, frame.objects.length)
  markFramesEdited([frameIndex])
  pushCommand({
    label: '清空本帧',
    ops: [{ type: 'clear', frameIndex, objects }],
    frames: [frameIndex],
  })
  state.selectedObjectIds = []
  state.selectedObjectId = null
}

/** 同步单选主 id（供原有单对象逻辑使用） */
function syncSelectedObjectId() {
  const ids = state.selectedObjectIds
  state.selectedObjectId = ids.length === 1 ? ids[0] : null
}

/** 直接设置选中集合 */
export function selectObjects(ids) {
  const valid = new Set(currentObjects.value.map((o) => o.id))
  state.selectedObjectIds = Array.from(new Set(ids || [])).filter((id) => valid.has(id))
  syncSelectedObjectId()
}

/**
 * 选中/取消选中
 * @param {string|null} id
 * @param {{additive?:boolean}} [options] additive=true 时切换该对象（Ctrl/Cmd 点击）
 */
export function selectObject(id, options = {}) {
  const additive = !!options.additive
  if (!id) {
    if (!additive) clearSelection()
    return
  }
  if (!additive) {
    state.selectedObjectIds = [id]
    syncSelectedObjectId()
    return
  }
  const set = new Set(state.selectedObjectIds)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  state.selectedObjectIds = Array.from(set)
  syncSelectedObjectId()
}

/** 清空选择 */
export function clearSelection() {
  if (!state.selectedObjectIds.length && state.selectedObjectId === null) return
  state.selectedObjectIds = []
  state.selectedObjectId = null
}

/* ---------------- 复制 / 粘贴 ---------------- */

/** 复制当前选中的对象到内部剪贴板 */
export function copySelected() {
  const objects = selectedObjects.value
  if (!objects.length) return 0
  clipboard = objects.map(cloneObject)
  pasteSerial = 0
  state.clipboardCount = clipboard.length
  return clipboard.length
}

/** 把对象类别 id 重新映射到当前数据集 */
function resolvePastedClassId(obj) {
  if (classById(obj.classId)) return obj.classId
  const byName = classByName(obj.type)
  if (byName) return byName.id
  return ensureClass(obj.type || 'Object')
}

/**
 * 粘贴剪贴板对象到当前帧
 * @param {{inPlace?:boolean}} [options] inPlace=true 时不偏移
 * @returns {number} 粘贴的对象数
 */
export function pasteObjects({ inPlace = false } = {}) {
  const frame = currentFrame.value
  if (!frame || !clipboard.length || currentFrameLocked()) return 0
  const offset = inPlace ? 0 : ++pasteSerial
  const created = []
  const items = []
  for (const src of clipboard) {
    const item = cloneObject(src)
    item.id = uid(isMarking(item) ? 'mark' : 'obj')
    item.classId = resolvePastedClassId(item)
    item.type = classById(item.classId)?.name || item.type
    item.trackId = 0
    item.multiFrame = false
    item.startFrame = state.currentIndex
    item.source = 'copy'
    if (item.shape === 'line') {
      item.points = (item.points || []).map(([x, y, z]) => [x + offset, y, z || 0])
    } else if (item.shape === 'arrow') {
      item.paths = (item.paths || []).map((p) =>
        p.map(([x, y, z]) => [x + offset, y, z || 0]),
      )
    } else {
      item.x = (item.x ?? 0) + offset
    }
    frame.objects.push(item)
    created.push(item)
    items.push({ frameIndex: state.currentIndex, index: frame.objects.length - 1, obj: item })
  }
  if (items.length) {
    markFramesEdited([state.currentIndex])
    pushAdded('粘贴对象', items)
  }
  state.selectedObjectIds = created.map((o) => o.id)
  syncSelectedObjectId()
  return created.length
}

/** 原地复制选中对象（不改变剪贴板内容） */
export function duplicateSelected() {
  const objects = selectedObjects.value
  if (!objects.length) return 0
  const previous = clipboard
  const previousSerial = pasteSerial
  clipboard = objects.map(cloneObject)
  pasteSerial = 0
  const count = pasteObjects({ inPlace: true })
  clipboard = previous
  pasteSerial = previousSerial
  state.clipboardCount = clipboard.length
  return count
}

/**
 * 批量平移当前帧选中对象（多选整体平移提交时调用）
 * @param {string[]} ids
 * @param {{dx?:number,dy?:number,dz?:number}} delta
 */
export function translateObjects(ids, { dx = 0, dy = 0, dz = 0 } = {}) {
  if ((!dx && !dy && !dz) || currentFrameLocked()) return 0
  const wanted = new Set(ids || [])
  const objects = currentObjects.value.filter((o) => wanted.has(o.id))
  const changes = []
  for (const obj of objects) {
    if (isMarking(obj)) {
      const before = geometrySnapshot(obj)
      if (obj.shape === 'line') {
        obj.points = (obj.points || []).map(([x, y, z]) => [x + dx, y + dy, (z || 0) + dz])
      } else {
        obj.paths = (obj.paths || []).map((p) =>
          p.map(([x, y, z]) => [x + dx, y + dy, (z || 0) + dz]),
        )
      }
      changes.push(makeChange(state.currentIndex, obj, before, geometrySnapshot(obj)))
      changes.push(...propagateMarkingChange(obj, { points: obj.points, paths: obj.paths }))
    } else {
      changes.push(
        ...updateObject(
          obj.id,
          {
            x: (obj.x ?? 0) + dx,
            y: (obj.y ?? 0) + dy,
            z: (obj.z ?? 0) + dz,
          },
          { record: false },
        ),
      )
    }
  }
  if (changes.length) {
    markFramesEdited(changes.map((change) => change.frameIndex))
    pushChanges('批量平移', changes, {
      mergeKey: `translate-group:${Array.from(wanted).sort().join('|')}`,
      mergeWindow: 800,
    })
  }
  return objects.length
}

/* ---------------- 类别 ---------------- */

/** 按当前类别表重算自增 id，草稿恢复后避免新类别撞号 */
export function refreshClassSequence() {
  classSeq = Math.max(100, ...state.classes.map((c) => Number(c.id) || 0)) + 1
}

/** 按当前帧对象重算 trackId 自增序号（草稿恢复/导入后调用） */
export function refreshTrackSequence() {
  let maxTrack = trackSeq
  state.frames.forEach((frame) =>
    frame.objects.forEach((obj) => {
      if (obj.trackId > maxTrack) maxTrack = obj.trackId
    }),
  )
  trackSeq = maxTrack
}

/** 新增类别，返回新 id */
export function addClass(name, color) {
  const id = classSeq++
  state.classes.push({ id, name: name || `Class ${id}`, color: color || randomColor() })
  markAllFramesEdited()
  return id
}

/** 更新类别名称/颜色（改名时同步所有对象的 type） */
export function updateClass(id, patch) {
  const c = classById(id)
  if (!c) return
  Object.assign(c, patch)
  if (patch.name !== undefined) {
    const name = c.name
    state.frames.forEach((f) => f.objects.forEach((o) => {
      if (o.classId === id) o.type = name
    }))
  }
  markAllFramesEdited()
}

/** 删除类别，并把引用该类别对象回退到第一个类别 */
export function removeClass(id) {
  const idx = state.classes.findIndex((c) => c.id === id)
  if (idx === -1) return
  state.classes.splice(idx, 1)
  const fallback = state.classes[0] || { id: 0, name: 'Object' }
  state.frames.forEach((f) =>
    f.objects.forEach((o) => {
      if (o.classId === id) {
        o.classId = fallback.id
        o.type = fallback.name
      }
    }),
  )
  if (state.activeClassId === id) state.activeClassId = fallback.id
  if (state.lastBoxClassId === id) state.lastBoxClassId = fallback.id
  markAllFramesEdited()
}

/* ---------------- 导入 / 导出 ---------------- */

/** 对象深拷贝（标线的顶点数组需要复制，避免导出后与运行时共享引用） */
function cloneObject(o) {
  const copy = { ...o }
  if (o.shape === 'line') copy.points = clonePoints(o.points)
  if (o.shape === 'arrow') copy.paths = clonePaths(o.paths)
  return copy
}

/** 序列化为项目标注 JSON（含全部帧对象与类别） */
export function serializeProject() {
  return {
    format: 'pointcloud-annotation',
    version: 1,
    dataset: state.datasetName,
    coordinate: state.coordinate,
    classes: state.classes.map((c) => ({ ...c })),
    frames: state.frames.map((f) => ({
      index: f.index,
      name: f.name,
      timestamp: f.timestamp,
      objects: f.objects.map(cloneObject),
    })),
  }
}

/**
 * 导入项目标注
 * @param {object} data serializeProject 的输出（或单帧真值结构）
 * @param {object} [options]
 * @param {boolean} [options.merge] true 追加到现有对象，false 覆盖
 *
 * 匹配规则：优先按帧名匹配；仅当导入帧数与当前帧数一致时才允许按序号回退匹配，
 * 避免把单帧真值误写到其它帧。
 */
export function applyProject(data, { merge = true, preserveManual = false } = {}) {
  if (!data || !Array.isArray(data.frames)) throw new Error('标注文件格式无效')
  if (data.classes) {
    state.classes = data.classes.map((c) => ({ ...c }))
    classSeq = Math.max(100, ...state.classes.map((c) => c.id)) + 1
    const firstClassId = state.classes[0]?.id ?? 0
    if (!state.classes.some((c) => c.id === state.activeClassId)) state.activeClassId = firstClassId
    if (!state.classes.some((c) => c.id === state.lastBoxClassId)) state.lastBoxClassId = firstClassId
  }
  const byName = new Map(data.frames.map((f) => [f.name, f]))
  const positional = data.frames.length === state.frames.length
  const matchedIndexes = []
  state.frames.forEach((frame, i) => {
    const incoming = byName.get(frame.name) || (positional ? data.frames[i] : null)
    if (!incoming || !Array.isArray(incoming.objects)) return
    matchedIndexes.push(i)
    const objects = incoming.objects.map((o) => {
      const classId = o.classId ?? ensureClass(o.type || 'Object')
      if (o.shape === 'line' || o.shape === 'arrow') {
        const item = {
          id: o.id || uid('mark'),
          shape: o.shape,
          trackId: o.trackId ?? 0,
          startFrame: o.startFrame ?? frame.index,
          multiFrame: !!o.multiFrame,
          classId,
          type: o.type || (o.shape === 'arrow' ? 'RoadArrow' : 'LaneLine'),
          width: o.width ?? (o.shape === 'arrow' ? 0.35 : 0.15),
          source: o.source || 'import',
        }
        if (o.shape === 'line') item.points = clonePoints(o.points)
        else {
          item.paths = clonePaths(o.paths)
          item.template = o.template ?? null
        }
        return item
      }
      return {
        id: o.id || uid('obj'),
        trackId: o.trackId ?? 0,
        startFrame: o.startFrame ?? frame.index,
        multiFrame: !!o.multiFrame,
        classId,
        type: o.type || 'Object',
        h: o.h,
        w: o.w,
        l: o.l,
        x: o.x,
        y: o.y,
        z: o.z,
        ry: o.ry,
        truncated: o.truncated ?? 0,
        occluded: o.occluded ?? 0,
        alpha: o.alpha ?? 0,
        difficulty: o.difficulty ?? 0,
        score: o.score ?? 1,
        bbox2d: o.bbox2d,
        source: o.source || 'import',
      }
    })
    if (merge) frame.objects.push(...objects)
    else {
      // 首屏真值在后台导入期间用户可能已经手工标注：保留这些对象，避免被真值覆盖
      const kept = preserveManual
        ? frame.objects.filter((o) =>
            ['manual', 'copy', 'ai', 'interp'].includes(o.source),
          )
        : []
      frame.objects = kept.length ? [...objects, ...kept] : objects
    }
  })
  // 导入真实数据集时 trackId 可能大于 1000，必须同步自增序号避免新物体撞号
  let maxTrack = 0
  state.frames.forEach((f) => f.objects.forEach((o) => {
    if (o.trackId > maxTrack) maxTrack = o.trackId
  }))
  trackSeq = Math.max(trackSeq, maxTrack)
  state.selectedObjectIds = []
  state.selectedObjectId = null
  // 导入后对象 id 可能整体变化，历史命令失效
  clearHistory()
  return matchedIndexes
}

/**
 * 导入当前数据集的全量真值（scene.groundTruth）
 * @returns {Promise<number>} 导入的对象总数
 */
export async function importAllGroundTruth(options = {}) {
  if (!state.groundTruthUrl) throw new Error('当前数据集没有全量真值文件')
  const data = await get(state.groundTruthUrl, null, { silent: true })
  if (!data || !Array.isArray(data.frames)) throw new Error('全量真值格式无效')
  applyProject({ frames: data.frames }, { merge: false, preserveManual: options.preserveManual })
  return data.frames.reduce((n, f) => n + (f.objects?.length || 0), 0)
}

/** 导出当前帧为 KITTI 文本（每行一个对象；标线无法用 KITTI 表示，会被跳过） */
export function exportCurrentKitti() {
  const frame = currentFrame.value
  return frame ? objectsToKittiText(frame.objects.filter((o) => !isMarking(o))) : ''
}

/** 当前帧无法导出到 KITTI 的标线数量 */
export function countNonKittiObjects() {
  const frame = currentFrame.value
  return frame ? frame.objects.filter(isMarking).length : 0
}

/** 从 KITTI 文本导入到当前帧 */
export function importKittiText(text, { merge = true } = {}) {
  const frame = currentFrame.value
  if (!frame || currentFrameLocked()) return 0
  const objects = kittiTextToObjects(text, (name) => ensureClass(name)).map((o) => ({
    ...o,
    id: uid('obj'),
    trackId: 0,
  }))
  if (merge) {
    const start = frame.objects.length
    frame.objects.push(...objects)
    if (objects.length) {
      markFramesEdited([state.currentIndex])
      pushAdded(
        '导入 KITTI',
        objects.map((obj, i) => ({
          frameIndex: state.currentIndex,
          index: start + i,
          obj,
        })),
      )
    }
  } else {
    frame.objects = objects
    clearHistory()
  }
  return objects.length
}

/** 拉取并导入当前帧的真值标注（示例数据集自带 labels/*.json） */
export async function importGroundTruth() {
  const frame = currentFrame.value
  if (!frame?.labelUrl) throw new Error('当前帧没有真值文件')
  const objects = await get(frame.labelUrl, null, { silent: true })
  applyProject({ classes: state.classes, frames: [{ name: frame.name, objects }] }, { merge: true })
  return objects.length
}

/** 便于组件以 `store.xxx` 方式统一调用（与上面的具名导出等价） */
export const store = {
  state,
  currentFrame,
  currentObjects,
  selectedObject,
  selectedObjects,
  activeClass,
  reset,
  setScene,
  loadLocalFiles,
  listSampleDatasets,
  loadSampleDataset,
  loadFirstSampleDataset,
  setCurrentIndex,
  step,
  bumpLabelVersion,
  addObject,
  addPolyline,
  isMarking,
  setPolylinePoint,
  insertPolylinePoint,
  deletePolylinePoint,
  rotatePolyline,
  scalePolyline,
  markingCentroid,
  setTool,
  updateObject,
  removeObject,
  removeTrack,
  mergeTracks,
  splitTrack,
  syncTrackForward,
  interpolateTrack,
  countTrackFrames,
  listTracks,
  searchObjects,
  clearObjects,
  undo,
  redo,
  canUndo,
  canRedo,
  historyState,
  markFrameEdited,
  markFramesEdited,
  markAllFramesDirty,
  selectObject,
  selectObjects,
  clearSelection,
  copySelected,
  pasteObjects,
  duplicateSelected,
  translateObjects,
  addClass,
  updateClass,
  removeClass,
  classById,
  classByName,
  classColor,
  ensureClass,
  refreshClassSequence,
  refreshTrackSequence,
  serializeProject,
  applyProject,
  exportCurrentKitti,
  countNonKittiObjects,
  importKittiText,
  importGroundTruth,
  importAllGroundTruth,
  scheduleGroundTruthImport,
  cancelScheduledGroundTruth,
  DEFAULT_CLASSES,
  MARKING_CLASS,
}

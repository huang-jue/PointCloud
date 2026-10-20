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
import {
  clonePoints,
  clonePaths,
  polylineCentroid,
  rotatePoints,
  scalePoints,
} from '../utils/polyline.js'

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

function nextTrackId() {
  return ++trackSeq
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
  lastBoxClassId: 0, // 进入绘制前使用的框类别，退出时恢复

  selectedObjectId: null,

  /* 点级分割 */
  segEnabled: false,
  segMode: 'rect', // rect | brush | lasso
  segOverwrite: true, // 新画的标签是否覆盖已有标签
  brushSize: 24,
  selectionCount: 0,
  selectedSegment: null, // 当前选中的语义标签片段 { id, classId, count }
  lastLabel: null, // 最近一次自动生成的标签 { classId, count }
  labelVersion: 0, // 标签数据版本号，用于触发面板刷新

  /* 加载/错误（error 由 App 监听后弹 message） */
  loading: false,
  error: '',
})

/** 当前帧对象 */
export const currentFrame = computed(() => state.frames[state.currentIndex] || null)

/** 当前帧的标注列表 */
export const currentObjects = computed(() => {
  const f = currentFrame.value
  return f ? f.objects : []
})

/** 当前选中的标注对象 */
export const selectedObject = computed(() => {
  if (!state.selectedObjectId) return null
  return currentObjects.value.find((o) => o.id === state.selectedObjectId) || null
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
  state.selectedObjectId = null
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
  state.camera = scene.camera || null
  if (Array.isArray(scene.classes) && scene.classes.length) {
    state.classes = scene.classes.map((c) => ({ ...c }))
    classSeq = Math.max(100, ...state.classes.map((c) => c.id)) + 1
  }
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
    throw new Error(`示例数据集索引不可用 (${err.message})，请先运行 npm run gen:test-data`)
  }
}

/** 加载指定 id 的示例数据集 */
export async function loadSampleDataset(id) {
  let scene
  try {
    scene = await get(`${SAMPLE_BASE}/${id}/scene.json`, null, { silent: true })
  } catch (err) {
    throw new Error(`示例数据集「${id}」不可用：${err.message}`)
  }
  setScene(scene, `${SAMPLE_BASE}/${id}`)
  return scene
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
  state.datasetName = 'local'
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
  if (!frame) return null
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
    score: partial.score ?? 1,
    source: partial.source ?? 'manual',
  }
  const last = propagate ? state.frames.length - 1 : state.currentIndex
  let first = null
  for (let j = state.currentIndex; j <= last; j++) {
    const obj = { ...template, id: uid('obj') } // 每帧独立 id，靠 trackId 关联
    state.frames[j].objects.push(obj)
    if (!first) first = obj
  }
  state.selectedObjectId = first ? first.id : null
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
  if (!frame) return null
  const shape = partial.shape === 'arrow' ? 'arrow' : 'line'
  const clsName = partial.type || MARKING_CLASS[shape]
  const cls = partial.classId != null ? classById(partial.classId) : classByName(clsName)
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
  for (let j = state.currentIndex; j <= last; j++) {
    const item = { ...template, id: uid('mark') }
    if (shape === 'line') item.points = clonePoints(template.points)
    else item.paths = clonePaths(template.paths)
    state.frames[j].objects.push(item)
    if (!first) first = item
  }
  state.selectedObjectId = first ? first.id : null
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
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  const arr = obj.shape === 'line' ? obj.points : obj.paths?.[pathIndex]
  if (!arr || index < 0 || index >= arr.length) return
  arr[index] = [point[0], point[1], point[2] ?? arr[index][2] ?? 0]
  propagateMarkingChange(obj, { points: obj.points, paths: obj.paths })
}

/** 删除标线的单个顶点（至少保留 2 个） */
export function deletePolylinePoint(id, index, pathIndex = 0) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return false
  const arr = obj.shape === 'line' ? obj.points : obj.paths?.[pathIndex]
  if (!arr || arr.length <= 2 || index < 0 || index >= arr.length) return false
  arr.splice(index, 1)
  if (obj.shape === 'line') obj.template = null
  propagateMarkingChange(obj, { points: obj.points, paths: obj.paths })
  return true
}

/**
 * 绕质心旋转标线（弧度）
 * @param {string} id
 * @param {number} angle 弧度，正值逆时针（俯视）
 */
export function rotatePolyline(id, angle) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  if (obj.shape === 'line') {
    obj.points = rotatePoints(obj.points, angle, polylineCentroid(obj.points))
  } else {
    const center = markingCentroid(obj)
    obj.paths = obj.paths.map((p) => rotatePoints(p, angle, center))
  }
  propagateMarkingChange(obj, { points: obj.points, paths: obj.paths })
}

/** 绕质心缩放标线 */
export function scalePolyline(id, factor) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!isMarking(obj)) return
  if (obj.shape === 'line') {
    obj.points = scalePoints(obj.points, factor, polylineCentroid(obj.points))
  } else {
    const center = markingCentroid(obj)
    obj.paths = obj.paths.map((p) => scalePoints(p, factor, center))
  }
  propagateMarkingChange(obj, { points: obj.points, paths: obj.paths })
}

/** 箭头所有路径合起来的质心 */
export function markingCentroid(obj) {
  if (!isMarking(obj)) return [0, 0, 0]
  const all = obj.shape === 'line' ? obj.points : (obj.paths || []).flat()
  return polylineCentroid(all)
}

/** 标线变更同步到后续帧同一 track（多帧移动开启时） */
function propagateMarkingChange(obj, { points, paths }) {
  if (!state.multiFrameMove || !(obj.trackId > 0)) return
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    for (const o of state.frames[j].objects) {
      if (o.trackId !== obj.trackId || !isMarking(o)) continue
      if (o.shape === 'line' && points) o.points = clonePoints(points)
      if (o.shape === 'arrow' && paths) o.paths = clonePaths(paths)
    }
  }
}

/**
 * 切换工具，并在进入/退出标线绘制时自动切换类别
 *  - line  -> LaneLine
 *  - arrow -> RoadArrow
 *  - 退出绘制 -> 恢复进入前的框类别
 */
export function setTool(tool) {
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
export function updateObject(id, patch) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!obj) return
  // 记录变更前的值，用于计算增量
  const before = {}
  for (const k of Object.keys(patch)) before[k] = obj[k]

  Object.assign(obj, patch)
  if (patch.classId !== undefined) {
    const c = classById(patch.classId)
    if (c) obj.type = c.name
  }

  if (isMarking(obj)) {
    // 标线的几何由顶点描述，走 setPolylinePoint 等专用接口；
    // 这里只同步类别/线宽等标量字段
    if (state.multiFrameMove && obj.trackId > 0) {
      for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
        for (const o of state.frames[j].objects) {
          if (o.trackId !== obj.trackId || !isMarking(o)) continue
          if (patch.classId !== undefined) o.classId = obj.classId
          if (patch.type !== undefined) o.type = obj.type
          if (patch.width !== undefined) o.width = obj.width
        }
      }
    }
    return
  }

  if (state.multiFrameMove && obj.trackId > 0) {
    propagateDeltaToTrack(obj, patch, before)
  }
}

/** 把 patch 的增量应用到之后所有帧中同一 trackId 的对象 */
function propagateDeltaToTrack(obj, patch, before) {
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    for (const o of state.frames[j].objects) {
      if (o.trackId !== obj.trackId) continue
      for (const k of Object.keys(patch)) {
        if (typeof patch[k] === 'number' && typeof before[k] === 'number') {
          o[k] = o[k] + (patch[k] - before[k])
        } else {
          o[k] = patch[k] // 类别等非数值字段直接取同值
        }
      }
      if (patch.classId !== undefined) {
        const c = classById(patch.classId)
        if (c) o.type = c.name
      }
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
  if (!frame) return
  const obj = frame.objects.find((o) => o.id === id)
  if (!obj) return
  const propagate = options.propagate ?? !!obj.multiFrame
  if (propagate && obj.trackId > 0) {
    for (let j = state.currentIndex; j < state.frames.length; j++) {
      const objects = state.frames[j].objects
      for (let k = objects.length - 1; k >= 0; k--) {
        if (objects[k].trackId === obj.trackId) objects.splice(k, 1)
      }
    }
  } else {
    const idx = frame.objects.findIndex((o) => o.id === id)
    if (idx !== -1) frame.objects.splice(idx, 1)
  }
  if (state.selectedObjectId === id) state.selectedObjectId = null
}

/** 统计某 trackId 出现在多少帧中 */
export function countTrackFrames(trackId) {
  let count = 0
  for (const f of state.frames) {
    if (f.objects.some((o) => o.trackId === trackId)) count++
  }
  return count
}

/**
 * 把当前对象的位姿/尺寸/类别同步到之后所有帧的同 trackId 对象
 * @returns {number} 被更新的对象数量
 */
export function syncTrackForward(id) {
  const obj = currentObjects.value.find((o) => o.id === id)
  if (!obj || !obj.trackId) return 0
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
  for (let j = state.currentIndex + 1; j < state.frames.length; j++) {
    for (const o of state.frames[j].objects) {
      if (o.trackId !== obj.trackId) continue
      Object.assign(o, props)
      if (isMarking(o)) {
        // 深拷贝，避免后续帧共享同一顶点数组
        if (o.shape === 'line' && props.points) o.points = clonePoints(props.points)
        if (o.shape === 'arrow' && props.paths) o.paths = clonePaths(props.paths)
      }
      count++
    }
  }
  return count
}

/** 清空当前帧的全部标注 */
export function clearObjects() {
  const frame = currentFrame.value
  if (frame) frame.objects.splice(0, frame.objects.length)
  state.selectedObjectId = null
}

/** 选中/取消选中（传空即取消） */
export function selectObject(id) {
  state.selectedObjectId = id || null
}

/* ---------------- 类别 ---------------- */

/** 新增类别，返回新 id */
export function addClass(name, color) {
  const id = classSeq++
  state.classes.push({ id, name: name || `Class ${id}`, color: color || randomColor() })
  return id
}

/** 更新类别名称/颜色 */
export function updateClass(id, patch) {
  const c = classById(id)
  if (c) Object.assign(c, patch)
}

/** 删除类别，并把引用该类别对象回退到第一个类别 */
export function removeClass(id) {
  const idx = state.classes.findIndex((c) => c.id === id)
  if (idx === -1) return
  state.classes.splice(idx, 1)
  state.frames.forEach((f) =>
    f.objects.forEach((o) => {
      if (o.classId === id) o.classId = state.classes[0]?.id ?? 0
    }),
  )
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
export function applyProject(data, { merge = true } = {}) {
  if (!data || !Array.isArray(data.frames)) throw new Error('标注文件格式无效')
  if (data.classes) {
    state.classes = data.classes.map((c) => ({ ...c }))
    classSeq = Math.max(100, ...state.classes.map((c) => c.id)) + 1
  }
  const byName = new Map(data.frames.map((f) => [f.name, f]))
  const positional = data.frames.length === state.frames.length
  state.frames.forEach((frame, i) => {
    const incoming = byName.get(frame.name) || (positional ? data.frames[i] : null)
    if (!incoming || !Array.isArray(incoming.objects)) return
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
        classId,
        type: o.type || 'Object',
        h: o.h,
        w: o.w,
        l: o.l,
        x: o.x,
        y: o.y,
        z: o.z,
        ry: o.ry,
        score: o.score ?? 1,
        bbox2d: o.bbox2d,
        source: o.source || 'import',
      }
    })
    if (merge) frame.objects.push(...objects)
    else frame.objects = objects
  })
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
  if (!frame) return 0
  const objects = kittiTextToObjects(text, (name) => ensureClass(name)).map((o) => ({
    ...o,
    id: uid('obj'),
    trackId: 0,
  }))
  if (merge) frame.objects.push(...objects)
  else frame.objects = objects
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
  deletePolylinePoint,
  rotatePolyline,
  scalePolyline,
  markingCentroid,
  setTool,
  updateObject,
  removeObject,
  syncTrackForward,
  countTrackFrames,
  clearObjects,
  selectObject,
  addClass,
  updateClass,
  removeClass,
  classById,
  classByName,
  classColor,
  ensureClass,
  serializeProject,
  applyProject,
  exportCurrentKitti,
  countNonKittiObjects,
  importKittiText,
  importGroundTruth,
  DEFAULT_CLASSES,
  MARKING_CLASS,
}

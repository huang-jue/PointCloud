/**
 * 点云加载与格式分发
 *
 * 统一出参（PointCloud 数据）：
 *   positions  Float32Array，长度 3N（x,y,z 交错）
 *   colors     Float32Array | null，长度 3N（rgb，0~1）——原始颜色
 *   intensity  Float32Array | null，长度 N
 *   pointCount number
 *
 * 各格式实现：
 *   pcd  Three.js PCDLoader（自持 ascii / binary / binary_compressed），并对 `rgba` 字段打补丁
 *   ply  Three.js PLYLoader（ascii / binary）
 *   bin  KITTI 自解析 float32 [x,y,z,intensity]（也兼容仅 3 通道）
 *   las  @loaders.gl/las，按需动态加载（含 LAZ，依赖内置 laz-perf WASM）
 *   xyz  / csv / txt 文本坐标自解析
 */

import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

/** 支持的扩展名（用于文件选择框与拖拽过滤） */
export const SUPPORTED_EXT = ['pcd', 'ply', 'bin', 'las', 'laz', 'xyz', 'csv', 'txt']

/** <input accept> 用的字符串 */
export const ACCEPT = SUPPORTED_EXT.map((e) => `.${e}`).join(',')

/** 读取数据源为 ArrayBuffer（本地文件或 URL），并对错误做友好提示 */
async function readSource(source) {
  if (source.kind === 'file') {
    return source.file.arrayBuffer()
  }
  const res = await fetch(source.url)
  if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}: ${source.url}`)
  // dev server / SPA 对未知路径会回退到 index.html，这里显式识别
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html')) throw new Error(`文件不存在或不是点云: ${source.url}`)
  return res.arrayBuffer()
}

/**
 * 载入点云
 * @param {{kind:'url'|'file', url?:string, file?:File, ext:string}} source
 * @returns {Promise<{positions:Float32Array,colors:Float32Array|null,intensity:Float32Array|null,pointCount:number}>}
 */
export async function loadPointCloud(source) {
  const ext = source.ext
  const buffer = await readSource(source)
  switch (ext) {
    case 'pcd':
      return parsePCD(buffer)
    case 'ply':
      return parsePLY(buffer)
    case 'bin':
      return parseKittiBin(buffer)
    case 'las':
    case 'laz':
      return parseLAS(buffer)
    case 'xyz':
    case 'csv':
    case 'txt':
      return parseXYZ(buffer)
    default:
      throw new Error(`不支持的格式: .${ext}`)
  }
}

/** PCD：用 Three PCDLoader 解析，取 position / color / intensity 三个属性 */
function parsePCD(buffer) {
  const points = new PCDLoader().parse(patchRgbaField(buffer))
  const geometry = points.geometry
  const position = geometry.getAttribute('position')
  const color = geometry.getAttribute('color')
  const intensity = geometry.getAttribute('intensity')
  return {
    positions: position.array,
    colors: color ? color.array : null,
    intensity: intensity ? intensity.array : null,
    pointCount: position.count,
  }
}

/**
 * Three 的 PCDLoader 只识别 `rgb` 字段，而 PCL 常导出 `rgba`（同为 4 字节打包）。
 * 这里在头部把 `rgba` 原地改写为 `rgb `（等长，不影响后续数据偏移与 header 长度）。
 */
function patchRgbaField(buffer) {
  const bytes = new Uint8Array(buffer)
  const probeLen = Math.min(bytes.length, 8192)
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, probeLen))
  if (!/\bFIELDS\b[^\n]*\brgba\b/.test(header)) return buffer
  const idx = header.indexOf('rgba')
  const dataIdx = header.search(/\nDATA\b/)
  if (idx === -1 || (dataIdx !== -1 && idx > dataIdx)) return buffer
  const copy = bytes.slice()
  copy[idx] = 0x72 // r
  copy[idx + 1] = 0x67 // g
  copy[idx + 2] = 0x62 // b
  copy[idx + 3] = 0x20 // space（占位，保持长度）
  return copy.buffer
}

/** PLY：Three PLYLoader 解析，颜色按需归一化 */
function parsePLY(buffer) {
  const geometry = new PLYLoader().parse(buffer)
  const position = geometry.getAttribute('position')
  const color = geometry.getAttribute('color')
  return {
    positions: position.array,
    colors: color ? normalizeColor(color.array) : null,
    intensity: null,
    pointCount: position.count,
  }
}

/**
 * KITTI BIN：小端 float32 交错。
 * 每点 4 个（x,y,z,intensity）或 3 个（仅 x,y,z）。
 */
function parseKittiBin(buffer) {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error('不是有效的 BIN 文件（字节数不是 4 的倍数）')
  }
  const raw = new Float32Array(buffer)
  let stride = 0
  if (raw.length % 4 === 0) stride = 4
  else if (raw.length % 3 === 0) stride = 3
  else throw new Error('不是有效的 KITTI BIN 文件（每点应为 3 或 4 个 float32）')
  const n = raw.length / stride
  const positions = new Float32Array(n * 3)
  const intensity = stride === 4 ? new Float32Array(n) : null
  for (let i = 0; i < n; i++) {
    const o = i * stride
    positions[i * 3] = raw[o]
    positions[i * 3 + 1] = raw[o + 1]
    positions[i * 3 + 2] = raw[o + 2]
    if (intensity) intensity[i] = raw[o + 3]
  }
  return { positions, colors: null, intensity, pointCount: n }
}

/** LAS/LAZ：@loaders.gl/las 动态 import，返回 POSITION / COLOR_0 / intensity */
async function parseLAS(buffer) {
  const [{ parse }, { LASLoader }] = await Promise.all([
    import('@loaders.gl/core'),
    import('@loaders.gl/las'),
  ])
  const data = await parse(buffer, LASLoader, { las: { shape: 'mesh' } })
  const attrs = data.attributes || {}
  const position = attrs.POSITION && attrs.POSITION.value
  if (!position) throw new Error('LAS 数据缺少位置字段')
  const colorEntry = attrs.COLOR_0 || attrs.COLOR
  const intensityEntry = attrs.intensity || attrs.Intensity
  return {
    positions: position,
    colors: colorEntry ? normalizeColor(colorEntry.value) : null,
    intensity: intensityEntry ? toFloat32(intensityEntry.value) : null,
    pointCount: position.length / 3,
  }
}

/** XYZ/CSV/TXT：逐行解析 "x y z [intensity]"，支持空格/逗号分隔与 # 注释 */
function parseXYZ(buffer) {
  const text = new TextDecoder().decode(buffer)
  const positions = []
  const intensity = []
  const hasIntensity = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const parts = s.split(/[\s,]+/)
    if (parts.length < 3) continue
    const x = Number(parts[0])
    const y = Number(parts[1])
    const z = Number(parts[2])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    positions.push(x, y, z)
    intensity.push(parts.length > 3 ? Number(parts[3]) || 0 : 0)
    hasIntensity.push(parts.length > 3)
  }
  const n = positions.length / 3
  const anyIntensity = hasIntensity.some(Boolean)
  return {
    positions: new Float32Array(positions),
    colors: null,
    intensity: anyIntensity ? new Float32Array(intensity) : null,
    pointCount: n,
  }
}

/** 颜色归一化：若最大值 > 1（如 uchar 0~255），除以 255 得到 0~1 */
function normalizeColor(array) {
  let max = 0
  const step = Math.max(1, Math.floor(array.length / 4000)) // 抽样求最大值即可
  for (let i = 0; i < array.length; i += step) {
    if (array[i] > max) max = array[i]
  }
  if (max <= 1.0001) return array instanceof Float32Array ? array : toFloat32(array)
  const out = new Float32Array(array.length)
  for (let i = 0; i < array.length; i++) out[i] = array[i] / 255
  return out
}

function toFloat32(array) {
  return array instanceof Float32Array ? array : Float32Array.from(array)
}

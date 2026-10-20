/**
 * PointColorizer —— 点云着色工具
 *
 * 统一输出 Float32Array(3N)，取值范围 0~1，可直接作为 geometry 的 color 属性。
 * 提供四种着色：强度色带、高度色带、纯色、按语义标签取类别颜色。
 */

/** 色带控制点（t, [r,g,b]），从深蓝 -> 青 -> 绿 -> 黄 -> 红 */
const RAMP = [
  [0.0, [0.1, 0.14, 0.5]],
  [0.25, [0.0, 0.67, 0.76]],
  [0.5, [0.26, 0.63, 0.28]],
  [0.75, [0.99, 0.85, 0.2]],
  [1.0, [0.9, 0.22, 0.21]],
]

/** 在色带上按 t∈[0,1] 线性插值取色 */
function sampleRamp(t) {
  t = Math.max(0, Math.min(1, t))
  for (let i = 1; i < RAMP.length; i++) {
    const [t0, c0] = RAMP[i - 1]
    const [t1, c1] = RAMP[i]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

/** 求数组最小/最大值（空数组退化为 0/1） */
function extent(values) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) {
    min = 0
    max = 1
  }
  return [min, max]
}

/** 预计算色带 LUT，避免每个点分配临时数组（40 万点下差异非常明显） */
const LUT_SIZE = 256
const RAMP_LUT = new Float32Array(LUT_SIZE * 3)
for (let i = 0; i < LUT_SIZE; i++) {
  const [r, g, b] = sampleRamp(i / (LUT_SIZE - 1))
  RAMP_LUT[i * 3] = r
  RAMP_LUT[i * 3 + 1] = g
  RAMP_LUT[i * 3 + 2] = b
}

/** 按强度归一化到色带 */
export function intensityToColor(intensity) {
  const [min, max] = extent(intensity)
  const span = max - min || 1
  const out = new Float32Array(intensity.length * 3)
  for (let i = 0; i < intensity.length; i++) {
    const t = (intensity[i] - min) / span
    const li = (t <= 0 ? 0 : t >= 1 ? LUT_SIZE - 1 : (t * (LUT_SIZE - 1)) | 0) * 3
    out[i * 3] = RAMP_LUT[li]
    out[i * 3 + 1] = RAMP_LUT[li + 1]
    out[i * 3 + 2] = RAMP_LUT[li + 2]
  }
  return out
}

/** 按 Z 高度归一化到色带 */
export function heightToColor(positions) {
  const n = positions.length / 3
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const z = positions[i * 3 + 2]
    if (z < min) min = z
    if (z > max) max = z
  }
  const span = max - min || 1
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const t = (positions[i * 3 + 2] - min) / span
    const li = (t <= 0 ? 0 : t >= 1 ? LUT_SIZE - 1 : (t * (LUT_SIZE - 1)) | 0) * 3
    out[i * 3] = RAMP_LUT[li]
    out[i * 3 + 1] = RAMP_LUT[li + 1]
    out[i * 3 + 2] = RAMP_LUT[li + 2]
  }
  return out
}

/** 全部点填充同一颜色 */
export function flatColor(hex, count) {
  const { r, g, b } = hexToRgb(hex)
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }
  return out
}

/**
 * 按点级标签上色：labels[i] 是类别 id，-1 表示未标注
 * @param {Int32Array|number[]} labels
 * @param {Array<{id:number,color:string}>} classes
 * @param {string} fallback 未标注点的颜色
 */
export function labelsToColor(labels, classes, fallback = '#5a6270') {
  const lut = new Map()
  for (const c of classes) lut.set(c.id, hexToRgb(c.color))
  const fb = hexToRgb(fallback)
  const out = new Float32Array(labels.length * 3)
  for (let i = 0; i < labels.length; i++) {
    const col = lut.get(labels[i]) || fb
    out[i * 3] = col.r
    out[i * 3 + 1] = col.g
    out[i * 3 + 2] = col.b
  }
  return out
}

/** #rgb / #rrggbb -> {r,g,b}（0~1） */
export function hexToRgb(hex) {
  let h = (hex || '#8899aa').replace('#', '')
  if (h.length === 3) h = h.split('').map((x) => x + x).join('')
  const n = parseInt(h, 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

export { sampleRamp }

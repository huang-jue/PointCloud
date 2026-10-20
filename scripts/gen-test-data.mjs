/**
 * 合成多帧点云测试数据生成器（无第三方依赖，直接 node 运行）
 *
 * 生成三份数据集，输出到 public/test-data/datasets/<id>/：
 *   <id>/frame_XXXXXX.{bin,pcd,ply}   同源三种格式（bin=KITTI float32[xyz,intensity]）
 *   <id>/labels/frame_XXXXXX.json     逐帧 3D 框 + 路面标线真值
 *   <id>/point_labels/markings.json   标线点级语义标签（索引逐帧稳定）
 *   <id>/scene.json                   坐标约定、类别、相机、帧索引
 *   index.json                        数据集汇总（供前端下拉选择）
 *
 * 用法：
 *   node scripts/gen-test-data.mjs                 # 生成全部三份
 *   node scripts/gen-test-data.mjs --only highway  # 只生成指定场景
 *   node scripts/gen-test-data.mjs --frames 30     # 覆盖帧数
 *   node scripts/gen-test-data.mjs --formats bin,ply
 *   node scripts/gen-test-data.mjs --out <dir>
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  transformTemplate,
  sampleArrowPath,
  sampleThickPolyline,
} from '../src/utils/polyline.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 场景配置（三份数据集）：道路范围、建筑/护栏、灯杆、泊车、运动目标与行人 */
/* ------------------------------------------------------------------ */

/**
 * 统一类别表（所有数据集共用）
 * id 会写入 scene.json，前端按 id 着色
 */
const CLASSES = [
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

/** 标线类别名 -> classId */
const MARK_CLASS = { LaneLine: 6, Crosswalk: 7, RoadArrow: 8, StopLine: 9 }

/** 标线采样间距（米） */
const MARK_STEP = 0.12

const DIMS = {
  Car: [4.2, 1.8, 1.5],
  Van: [5.4, 2.0, 2.2],
  Truck: [9.0, 2.5, 3.2],
  Pedestrian: [0.6, 0.6, 1.7],
  Cyclist: [1.7, 0.7, 1.7],
  Pole: [0.22, 0.22, 4.5],
}

const BASE_REFLECT = { Car: 1.0, Van: 0.85, Truck: 0.8, Pedestrian: 0.6, Cyclist: 0.7, Pole: 0.5, Ground: 0.35 }

const SCENES = [
  {
    id: 'urban',
    name: '城市道路序列 (urban-road)',
    description: '120m 双向城市道路：两侧建筑立面、路灯、路边泊车、车流与行人',
    seed: 20260101,
    frames: 50,
    dt: 0.1,
    density: 3.2, // 采样密度倍率（越大点越密、数据量越大）
    sensorHeight: 1.73,
    road: { x: [-25, 95], halfY: 7, step: 0.32 },
    walls: [
      { axis: 'x', at: 8.6, from: -25, to: 95, height: 9, step: 0.32 },
      { axis: 'x', at: -8.6, from: -25, to: 95, height: 9, step: 0.32 },
    ],
    poles: { spacing: 8, offsetY: 6.4 },
    parked: 8,
    tracks: [
      { trackId: 1, type: 'Car', axis: 'x', start: -5, lateral: -3.2, speed: 9 },
      { trackId: 2, type: 'Car', axis: 'x', start: 12, lateral: -5.0, speed: 11 },
      { trackId: 3, type: 'Van', axis: 'x', start: 26, lateral: 3.4, speed: 8 },
      { trackId: 4, type: 'Car', axis: 'x', start: 44, lateral: 5.2, speed: 10 },
      { trackId: 5, type: 'Van', axis: 'x', start: -20, lateral: 2.8, speed: 7.5 },
      { trackId: 6, type: 'Car', axis: 'x', start: 60, lateral: -2.6, speed: 12 },
    ],
    walkers: 3,
    markings: {
      // 沿 X 的车道线：y 为横向位置
      lanesX: [
        { y: 7, x0: -25, x1: 95, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: -7, x0: -25, x1: 95, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: 0.12, x0: -25, x1: 95, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: -0.12, x0: -25, x1: 95, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: 3.5, x0: -25, x1: 95, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { y: -3.5, x0: -25, x1: 95, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
      ],
      arrows: [
        { template: 'straight', x: 18, y: 5.2, heading: 0 },
        { template: 'straightLeft', x: 18, y: 1.75, heading: 0 },
        { template: 'left', x: 18, y: -1.75, heading: 180 },
        { template: 'straight', x: 42, y: -5.2, heading: 180 },
        { template: 'right', x: 42, y: 1.75, heading: 0 },
      ],
      crosswalks: [],
      stopLines: [],
    },
    camera: { position: [-34, -36, 24], target: [32, 0, 0] },
  },
  {
    id: 'highway',
    name: '高速公路序列 (highway)',
    description: '240m 多车道高速公路：护栏、灯杆、密集高速车流',
    seed: 20260202,
    frames: 80,
    dt: 0.08,
    density: 3.0,
    sensorHeight: 1.9,
    road: { x: [-40, 200], halfY: 11, step: 0.4 },
    walls: [
      { axis: 'x', at: 11, from: -40, to: 200, height: 0.9, step: 0.3 },
      { axis: 'x', at: -11, from: -40, to: 200, height: 0.9, step: 0.3 },
    ],
    poles: { spacing: 26, offsetY: 10.2, height: 8 },
    parked: 0,
    tracks: [
      { trackId: 1, type: 'Car', axis: 'x', start: -10, lateral: -8, speed: 24 },
      { trackId: 2, type: 'Car', axis: 'x', start: 40, lateral: -4.5, speed: 27 },
      { trackId: 3, type: 'Truck', axis: 'x', start: 20, lateral: 8, speed: 18 },
      { trackId: 4, type: 'Van', axis: 'x', start: 90, lateral: 4.5, speed: 22 },
      { trackId: 5, type: 'Car', axis: 'x', start: -30, lateral: 0, speed: 25 },
      { trackId: 6, type: 'Truck', axis: 'x', start: 120, lateral: 8, speed: 16 },
      { trackId: 7, type: 'Car', axis: 'x', start: 60, lateral: -8, speed: 29 },
      { trackId: 8, type: 'Van', axis: 'x', start: 160, lateral: -4.5, speed: 20 },
      { trackId: 9, type: 'Car', axis: 'x', start: 5, lateral: 0, speed: 31 },
      { trackId: 10, type: 'Car', axis: 'x', start: 140, lateral: 4.5, speed: 23 },
    ],
    walkers: 0,
    markings: {
      lanesX: [
        { y: 11, x0: -40, x1: 200, style: 'solid', width: 0.18, type: 'LaneLine' },
        { y: -11, x0: -40, x1: 200, style: 'solid', width: 0.18, type: 'LaneLine' },
        { y: 0.12, x0: -40, x1: 200, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: -0.12, x0: -40, x1: 200, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: 3.6, x0: -40, x1: 200, style: 'dashed', width: 0.15, dash: 6, gap: 9, type: 'LaneLine' },
        { y: -3.6, x0: -40, x1: 200, style: 'dashed', width: 0.15, dash: 6, gap: 9, type: 'LaneLine' },
        { y: 7.3, x0: -40, x1: 200, style: 'dashed', width: 0.15, dash: 6, gap: 9, type: 'LaneLine' },
        { y: -7.3, x0: -40, x1: 200, style: 'dashed', width: 0.15, dash: 6, gap: 9, type: 'LaneLine' },
      ],
      arrows: [
        { template: 'straight', x: 20, y: 1.75, heading: 0 },
        { template: 'straight', x: 20, y: 5.4, heading: 0 },
        { template: 'straight', x: 55, y: -1.75, heading: 180 },
        { template: 'straight', x: 55, y: -5.4, heading: 180 },
        { template: 'straight', x: 90, y: 9.1, heading: 0 },
      ],
      crosswalks: [],
      stopLines: [],
    },
    camera: { position: [-70, -70, 46], target: [70, 0, 0] },
  },
  {
    id: 'crossing',
    name: '路口与停车场序列 (intersection)',
    description: '十字路口 + 路侧停车场：四角建筑、红绿灯杆、大量泊车、横穿行人与转弯车辆',
    seed: 20260303,
    frames: 60,
    dt: 0.1,
    density: 3.1,
    sensorHeight: 1.73,
    road: { x: [-40, 60], halfY: 6, step: 0.32, cross: { at: 8, halfX: 6, from: -46, to: 46 } },
    walls: [
      { axis: 'x', at: 13, from: -40, to: 60, height: 7, step: 0.4, gaps: [[2, 14]] },
      { axis: 'x', at: -13, from: -40, to: 60, height: 7, step: 0.4, gaps: [[2, 14]] },
      { axis: 'y', at: 14, from: -46, to: 46, height: 7, step: 0.4, gaps: [[2, 14]] },
      { axis: 'y', at: -14, from: -46, to: 46, height: 7, step: 0.4, gaps: [[2, 14]] },
    ],
    poles: { spacing: 6, offsetY: 5.6, corners: 4 },
    parked: 0,
    parkingLot: { x0: 18, x1: 52, rows: [9.5, 12.5], perRow: 7 },
    tracks: [
      { trackId: 1, type: 'Car', axis: 'x', start: -10, lateral: -3, speed: 7 },
      { trackId: 2, type: 'Car', axis: 'x', start: 30, lateral: 3, speed: 8 },
      { trackId: 3, type: 'Van', axis: 'y', start: -30, lateral: 10.5, speed: 6 },
      { trackId: 4, type: 'Car', axis: 'y', start: 30, lateral: 5.5, speed: 9 },
      { trackId: 5, type: 'Cyclist', axis: 'x', start: 5, lateral: -5, speed: 4 },
    ],
    walkers: 5,
    markings: {
      // 主路（沿 X）车道线，在路口处断开
      lanesX: [
        { y: 6, x0: -40, x1: -2.5, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: -6, x0: -40, x1: -2.5, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: 0.12, x0: -40, x1: -2.5, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: -0.12, x0: -40, x1: -2.5, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: 3, x0: -40, x1: -2.5, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { y: -3, x0: -40, x1: -2.5, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { y: 6, x0: 18.5, x1: 60, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: -6, x0: 18.5, x1: 60, style: 'solid', width: 0.15, type: 'LaneLine' },
        { y: 0.12, x0: 18.5, x1: 60, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: -0.12, x0: 18.5, x1: 60, style: 'solid', width: 0.12, type: 'LaneLine' },
        { y: 3, x0: 18.5, x1: 60, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { y: -3, x0: 18.5, x1: 60, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
      ],
      // 横向道路（沿 Y）车道线，在路口处断开
      lanesY: [
        { x: 2, y0: -46, y1: -10.5, style: 'solid', width: 0.15, type: 'LaneLine' },
        { x: 14, y0: -46, y1: -10.5, style: 'solid', width: 0.15, type: 'LaneLine' },
        { x: 8.12, y0: -46, y1: -10.5, style: 'solid', width: 0.12, type: 'LaneLine' },
        { x: 7.88, y0: -46, y1: -10.5, style: 'solid', width: 0.12, type: 'LaneLine' },
        { x: 5, y0: -46, y1: -10.5, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { x: 11, y0: -46, y1: -10.5, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { x: 2, y0: 10.5, y1: 46, style: 'solid', width: 0.15, type: 'LaneLine' },
        { x: 14, y0: 10.5, y1: 46, style: 'solid', width: 0.15, type: 'LaneLine' },
        { x: 8.12, y0: 10.5, y1: 46, style: 'solid', width: 0.12, type: 'LaneLine' },
        { x: 7.88, y0: 10.5, y1: 46, style: 'solid', width: 0.12, type: 'LaneLine' },
        { x: 5, y0: 10.5, y1: 46, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
        { x: 11, y0: 10.5, y1: 46, style: 'dashed', width: 0.15, dash: 4, gap: 6, type: 'LaneLine' },
      ],
      // 斑马线：along 表示条纹延伸方向，spread 为条纹覆盖宽度
      crosswalks: [
        { cx: 0, cy: 0, along: 'x', length: 3, spread: 11, stripeWidth: 0.55, gap: 0.55 },
        { cx: 16, cy: 0, along: 'x', length: 3, spread: 11, stripeWidth: 0.55, gap: 0.55 },
        { cx: 8, cy: -8, along: 'y', length: 3, spread: 11, stripeWidth: 0.55, gap: 0.55 },
        { cx: 8, cy: 8, along: 'y', length: 3, spread: 11, stripeWidth: 0.55, gap: 0.55 },
      ],
      // 停止线
      stopLines: [
        { axis: 'y', at: -2.5, from: 0, to: 6, width: 0.4 },
        { axis: 'y', at: 18.5, from: -6, to: 0, width: 0.4 },
        { axis: 'x', at: 10.5, from: 8, to: 14, width: 0.4 },
        { axis: 'x', at: -10.5, from: 2, to: 8, width: 0.4 },
      ],
      arrows: [
        { template: 'straight', x: -9, y: 1.5, heading: 0 },
        { template: 'left', x: -9, y: 4.5, heading: 0 },
        { template: 'straight', x: 25, y: -1.5, heading: 180 },
        { template: 'right', x: 25, y: -4.5, heading: 180 },
        { template: 'straight', x: 11, y: -20, heading: -90 },
        { template: 'straight', x: 5, y: 20, heading: 90 },
      ],
    },
    camera: { position: [-34, -32, 26], target: [16, 0, 0] },
  },
]

/* ------------------------------------------------------------------ */
/* 几何采样工具：立方体表面点、墙体点、地面点、灯杆点 */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function boxPoints(out, rng, cx, cy, cz, type, yaw, res) {
  const [l, w, h] = DIMS[type]
  const hl = l / 2
  const hw = w / 2
  const hh = h / 2
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const emit = (lx, ly, lz) => {
    out.push(
      cx + lx * cos - ly * sin + (rng() - 0.5) * 0.03,
      cy + lx * sin + ly * cos + (rng() - 0.5) * 0.03,
      cz + lz + (rng() - 0.5) * 0.03,
    )
  }
  for (let a = -hl; a <= hl + 1e-6; a += res) for (let b = -hw; b <= hw + 1e-6; b += res) emit(a, b, hh)
  for (let a = -hl; a <= hl + 1e-6; a += res) {
    for (let c = -hh; c <= hh + 1e-6; c += res) {
      emit(a, -hw, c)
      emit(a, hw, c)
    }
  }
  for (let b = -hw; b <= hw + 1e-6; b += res) {
    for (let c = -hh; c <= hh + 1e-6; c += res) {
      emit(-hl, b, c)
      emit(hl, b, c)
    }
  }
}

function wallPoints(out, rng, wall, groundZ) {
  const { axis, at, from, to, height, step, gaps = [] } = wall
  const inGap = (v) => gaps.some(([a, b]) => v >= a && v <= b)
  for (let v = from; v <= to + 1e-6; v += step) {
    if (inGap(v)) continue
    for (let z = groundZ; z <= groundZ + height; z += step) {
      const j = (rng() - 0.5) * 0.05
      if (axis === 'x') out.push(v + (rng() - 0.5) * 0.05, at + j, z + (rng() - 0.5) * 0.05)
      else out.push(at + j, v + (rng() - 0.5) * 0.05, z + (rng() - 0.5) * 0.05)
    }
  }
}

function groundPoints(out, rng, road, groundZ, sensorHeight) {
  const [x0, x1] = road.x
  for (let x = x0; x <= x1; x += road.step) {
    for (let y = -road.halfY; y <= road.halfY; y += road.step) {
      out.push(x + (rng() - 0.5) * 0.1, y + (rng() - 0.5) * 0.1, groundZ + (rng() - 0.5) * 0.05)
    }
  }
  if (road.cross) {
    const { at, halfX, from, to } = road.cross
    for (let y = from; y <= to; y += road.step) {
      for (let x = at - halfX; x <= at + halfX; x += road.step) {
        if (Math.abs(y) <= road.halfY && x >= x0 && x <= x1) continue
        out.push(x + (rng() - 0.5) * 0.1, y + (rng() - 0.5) * 0.1, groundZ + (rng() - 0.5) * 0.05)
      }
    }
  }
  void sensorHeight
}

function polePoints(out, rng, profile, groundZ) {
  const { spacing, offsetY, height = DIMS.Pole[2], corners = 0 } = profile.poles || {}
  const [x0, x1] = profile.road.x
  const add = (x, y) => {
    for (let z = groundZ; z <= groundZ + height; z += 0.2) {
      out.push(x + (rng() - 0.5) * 0.12, y + (rng() - 0.5) * 0.12, z + (rng() - 0.5) * 0.05)
    }
  }
  if (spacing) {
    for (let x = x0 + spacing; x < x1; x += spacing) {
      add(x, offsetY)
      add(x, -offsetY)
    }
  }
  if (corners) {
    const c = profile.road.cross.at
    const hx = profile.road.cross.halfX + 0.6
    const hy = profile.road.halfY + 0.6
    add(c + hx, hy)
    add(c - hx, hy)
    add(c + hx, -hy)
    add(c - hx, -hy)
  }
}

/* ------------------------------------------------------------------ */
/* 路面标线：车道线 / 斑马线 / 停止线 / 箭头
 *   - 点云：高反射白色涂料点，位于地面上方 3~5cm
 *   - 真值：shape:'line' / shape:'arrow' 的矢量对象
 *   - 点级标签：按类别连续排列，索引在每帧中完全一致
 * ------------------------------------------------------------------ */

/** 生成一条沿 X 的车道线（实线整条，虚线按 dash/gap 切段） */
function laneLineX(spec, groundZ, out, objects, seq) {
  const z = groundZ + 0.04
  const segs =
    spec.style === 'dashed'
      ? dashSegments(spec.x0, spec.x1, spec.dash || 4, spec.gap || 6)
      : [[spec.x0, spec.x1]]
  for (const [a, b] of segs) {
    if (b - a < 0.2) continue
    const points = [
      [a, spec.y, z],
      [b, spec.y, z],
    ]
    out.push(...sampleThickPolyline(points, spec.width, MARK_STEP))
    objects.push(markLine(spec.type || 'LaneLine', spec.width, points, seq()))
  }
}

/** 生成一条沿 Y 的车道线 */
function laneLineY(spec, groundZ, out, objects, seq) {
  const z = groundZ + 0.04
  const segs =
    spec.style === 'dashed'
      ? dashSegments(spec.y0, spec.y1, spec.dash || 4, spec.gap || 6)
      : [[spec.y0, spec.y1]]
  for (const [a, b] of segs) {
    if (b - a < 0.2) continue
    const points = [
      [spec.x, a, z],
      [spec.x, b, z],
    ]
    out.push(...sampleThickPolyline(points, spec.width, MARK_STEP))
    objects.push(markLine(spec.type || 'LaneLine', spec.width, points, seq()))
  }
}

/** 按 dash/gap 切分区间 */
function dashSegments(from, to, dash, gap) {
  const out = []
  const dir = to >= from ? 1 : -1
  let v = from
  while (dir > 0 ? v < to : v > to) {
    const end = v + dir * dash
    out.push([v, dir > 0 ? Math.min(end, to) : Math.max(end, to)])
    v = end + dir * gap
  }
  return out
}

/** 斑马线：沿 along 方向的长条纹，spread 方向等距排布 */
function crosswalk(spec, groundZ, out, objects, seq) {
  const z = groundZ + 0.04
  const count = Math.max(1, Math.floor((spec.spread + spec.gap) / (spec.stripeWidth + spec.gap)))
  const total = count * spec.stripeWidth + (count - 1) * spec.gap
  const start = -total / 2 + spec.stripeWidth / 2
  for (let i = 0; i < count; i++) {
    const off = start + i * (spec.stripeWidth + spec.gap)
    let points
    if (spec.along === 'x') {
      points = [
        [spec.cx - spec.length / 2, spec.cy + off, z],
        [spec.cx + spec.length / 2, spec.cy + off, z],
      ]
    } else {
      points = [
        [spec.cx + off, spec.cy - spec.length / 2, z],
        [spec.cx + off, spec.cy + spec.length / 2, z],
      ]
    }
    out.push(...sampleThickPolyline(points, spec.stripeWidth, MARK_STEP))
    objects.push(markLine('Crosswalk', spec.stripeWidth, points, seq()))
  }
}

/** 停止线 */
function stopLine(spec, groundZ, out, objects, seq) {
  const z = groundZ + 0.04
  const points =
    spec.axis === 'y'
      ? [
          [spec.at, spec.from, z],
          [spec.at, spec.to, z],
        ]
      : [
          [spec.from, spec.at, z],
          [spec.to, spec.at, z],
        ]
  out.push(...sampleThickPolyline(points, spec.width, MARK_STEP))
  objects.push(markLine('StopLine', spec.width, points, seq()))
}

/** 箭头：模板放到世界坐标后采样 */
function roadArrow(spec, groundZ, out, objects, seq) {
  const z = groundZ + 0.05
  const ry = (spec.heading * Math.PI) / 180
  const paths = transformTemplate(spec.template, { x: spec.x, y: spec.y, z, ry, scale: 1 })
  const width = spec.width ?? 0.32
  for (const path of paths) out.push(...sampleArrowPath(path.map(([x, y]) => [x, y]), width, MARK_STEP, z))
  objects.push({
    id: `mark_${seq()}`,
    shape: 'arrow',
    type: 'RoadArrow',
    classId: MARK_CLASS.RoadArrow,
    width,
    paths,
    template: spec.template,
    trackId: 0,
    startFrame: 0,
    multiFrame: false,
    source: 'ground-truth',
  })
}

function markLine(type, width, points, id) {
  return {
    id: `mark_${id}`,
    shape: 'line',
    type,
    classId: MARK_CLASS[type] ?? MARK_CLASS.LaneLine,
    width,
    points,
    trackId: 0,
    startFrame: 0,
    multiFrame: false,
    source: 'ground-truth',
  }
}

/**
 * 生成整套标线（静态，所有帧共用）
 * @returns {{points:number[][], objects:object[], segments:{classId:number,indices:number[]}[]}}
 */
function buildMarkings(profile, groundZ) {
  const cfg = profile.markings
  if (!cfg) return { points: [], objects: [], segments: [] }
  let counter = 0
  const seq = () => ++counter

  // 按类别收集，保证点级标签的索引在每帧都连续稳定
  const buckets = new Map() // classId -> number[][]
  const objects = []
  const pushTo = (type, pts) => {
    const id = MARK_CLASS[type]
    if (!buckets.has(id)) buckets.set(id, [])
    buckets.get(id).push(...pts)
  }

  for (const spec of cfg.lanesX || []) {
    const out = []
    laneLineX(spec, groundZ, out, objects, seq)
    pushTo(spec.type || 'LaneLine', out)
  }
  for (const spec of cfg.lanesY || []) {
    const out = []
    laneLineY(spec, groundZ, out, objects, seq)
    pushTo(spec.type || 'LaneLine', out)
  }
  for (const spec of cfg.crosswalks || []) {
    const out = []
    crosswalk(spec, groundZ, out, objects, seq)
    pushTo('Crosswalk', out)
  }
  for (const spec of cfg.stopLines || []) {
    const out = []
    stopLine(spec, groundZ, out, objects, seq)
    pushTo('StopLine', out)
  }
  for (const spec of cfg.arrows || []) {
    const out = []
    roadArrow(spec, groundZ, out, objects, seq)
    pushTo('RoadArrow', out)
  }

  const points = []
  const segments = []
  for (const classId of [MARK_CLASS.LaneLine, MARK_CLASS.Crosswalk, MARK_CLASS.StopLine, MARK_CLASS.RoadArrow]) {
    const pts = buckets.get(classId)
    if (!pts || !pts.length) continue
    const start = points.length
    points.push(...pts)
    const indices = []
    for (let i = start; i < points.length; i++) indices.push(i)
    segments.push({ classId, indices })
  }
  return { points, objects, segments }
}

/* ------------------------------------------------------------------ */
/* 单帧构建：把各类要素采样成点并生成真值对象 */
/* ------------------------------------------------------------------ */

/**
 * 按密度倍率缩放地面/墙体的采样步长（步长越小点越密）
 * 下限 0.03m 防止密度过大导致点数爆炸
 */
function applyDensity(profile, density) {
  const d = density || profile.density || 1
  if (d === 1) return profile
  const scale = (v) => Math.max(0.03, v / d)
  return {
    ...profile,
    road: { ...profile.road, step: scale(profile.road.step) },
    walls: profile.walls ? profile.walls.map((w) => ({ ...w, step: scale(w.step) })) : profile.walls,
  }
}

function buildFrame(profile, frameIndex, rng, classOf, markings) {
  const dt = profile.dt
  const groundZ = -profile.sensorHeight
  const positions = []
  const intensities = []
  const objects = []

  const pushTyped = (arr, base, jitter = 6) => {
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i]
      const y = arr[i + 1]
      const z = arr[i + 2]
      const d = Math.hypot(x, y, z)
      positions.push(x, y, z)
      intensities.push(Math.max(0, Math.min(255, base * 220 * Math.exp(-d / 55) + 25 + (rng() - 0.5) * jitter)))
    }
  }

  // 标线点固定排在最前，保证逐帧点级标签索引稳定（场景为静态标线）
  if (markings?.points?.length) {
    const arr = []
    for (const [x, y, z] of markings.points) arr.push(x, y, z)
    // 白色涂料反射率高，且不随距离衰减太多，便于与地面区分
    pushTyped(arr, 1.35, 4)
  }

  const ground = []
  groundPoints(ground, rng, profile.road, groundZ, profile.sensorHeight)
  pushTyped(ground, BASE_REFLECT.Ground)

  if (profile.walls) {
    const walls = []
    for (const w of profile.walls) wallPoints(walls, rng, w, groundZ)
    pushTyped(walls, 0.55, 10)
  }

  if (profile.poles) {
    const poles = []
    polePoints(poles, rng, profile, groundZ)
    pushTyped(poles, BASE_REFLECT.Pole)
  }

  const addObject = (type, trackId, cx, cy, cz, yaw, res) => {
    const arr = []
    boxPoints(arr, rng, cx, cy, cz, type, yaw, res)
    pushTyped(arr, BASE_REFLECT[type])
    const [l, w, h] = DIMS[type]
    objects.push({
      type,
      trackId,
      classId: classOf(type),
      truncated: 0,
      occluded: 0,
      alpha: 0,
      bbox2d: [0, 0, 0, 0],
      h,
      w,
      l,
      x: cx,
      y: cy,
      z: cz,
      ry: yaw,
      score: 1,
    })
  }

  const t = frameIndex * dt
  const centerZ = (type) => groundZ + DIMS[type][2] / 2

  // static parked cars along both kerbs
  const [px0, px1] = profile.road.x
  for (let i = 0; i < (profile.parked || 0); i++) {
    const x = px0 + 6 + i * 4.4
    if (x > px1 - 4) break
    const side = i % 2 === 0 ? 1 : -1
    addObject('Car', 200 + i, x, side * (profile.road.halfY - 1.4), centerZ('Car'), side > 0 ? 0 : Math.PI, 0.3)
  }

  // parking lot rows (intersection scene)
  if (profile.parkingLot) {
    const { x0, x1, rows, perRow } = profile.parkingLot
    let k = 0
    for (const y of rows) {
      for (let i = 0; i < perRow; i++) {
        const x = x0 + (i * (x1 - x0)) / Math.max(1, perRow - 1)
        addObject('Car', 300 + k, x, y, centerZ('Car'), Math.PI / 2, 0.28)
        k++
      }
    }
  }

  // moving tracks
  for (const tr of profile.tracks) {
    const along = tr.start + tr.speed * t
    let cx
    let cy
    if (tr.axis === 'x') {
      cx = along
      cy = tr.lateral
    } else {
      cx = tr.lateral
      cy = along
    }
    if (cx < px0 - 12 || cx > px1 + 12 || cy < -60 || cy > 60) continue
    const yaw = tr.axis === 'x' ? (tr.speed >= 0 ? 0 : Math.PI) : tr.speed >= 0 ? Math.PI / 2 : -Math.PI / 2
    addObject(tr.type, tr.trackId, cx, cy, centerZ(tr.type), yaw, 0.25)
  }

  // pedestrians
  for (let i = 0; i < (profile.walkers || 0); i++) {
    const phase = t * 1.4 + i * 1.7
    const cx = px0 + 12 + i * 11 + Math.sin(phase) * 1.2
    const cy = (i % 2 === 0 ? 1 : -1) * (profile.road.halfY - 1.6)
    if (cx > px1 - 2 || cx < px0) continue
    const yaw = i % 2 === 0 ? 0 : Math.PI
    addObject('Pedestrian', 10 + i, cx, cy + Math.sin(phase * 0.7) * 0.5, centerZ('Pedestrian'), yaw, 0.18)
  }

  // 静态路面标线矢量真值（与点云中的标线点一一对应）
  if (markings?.objects?.length) objects.push(...markings.objects)

  return { positions, intensities, objects }
}

/* ------------------------------------------------------------------ */
/* 三种格式的二进制写出 */
/* ------------------------------------------------------------------ */

function toKittiBin(positions, intensities) {
  const n = intensities.length
  const buf = Buffer.alloc(n * 16)
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(positions[i * 3], i * 16)
    buf.writeFloatLE(positions[i * 3 + 1], i * 16 + 4)
    buf.writeFloatLE(positions[i * 3 + 2], i * 16 + 8)
    buf.writeFloatLE(intensities[i], i * 16 + 12)
  }
  return buf
}

function toPcdBinary(positions, intensities) {
  const n = intensities.length
  const header =
    '# .PCD v0.7 - Point Cloud Data file format\n' +
    'VERSION 0.7\n' +
    'FIELDS x y z intensity\n' +
    'SIZE 4 4 4 4\n' +
    'TYPE F F F F\n' +
    'COUNT 1 1 1 1\n' +
    `WIDTH ${n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${n}\nDATA binary\n`
  const body = Buffer.alloc(n * 16)
  for (let i = 0; i < n; i++) {
    body.writeFloatLE(positions[i * 3], i * 16)
    body.writeFloatLE(positions[i * 3 + 1], i * 16 + 4)
    body.writeFloatLE(positions[i * 3 + 2], i * 16 + 8)
    body.writeFloatLE(intensities[i], i * 16 + 12)
  }
  return Buffer.concat([Buffer.from(header, 'ascii'), body])
}

function toPlyBinary(positions, intensities) {
  const n = intensities.length
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment generated test point cloud\n' +
    `element vertex ${n}\nproperty float x\nproperty float y\nproperty float z\n` +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n'
  const body = Buffer.alloc(n * 15)
  for (let i = 0; i < n; i++) {
    const o = i * 15
    body.writeFloatLE(positions[i * 3], o)
    body.writeFloatLE(positions[i * 3 + 1], o + 4)
    body.writeFloatLE(positions[i * 3 + 2], o + 8)
    const g = Math.max(0, Math.min(255, Math.round(intensities[i])))
    body[o + 12] = g
    body[o + 13] = Math.round(g * 0.75)
    body[o + 14] = 255 - g
  }
  return Buffer.concat([Buffer.from(header, 'ascii'), body])
}

/* ------------------------------------------------------------------ */
/* 命令行参数解析与主流程 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { frames: null, only: null, formats: 'bin,pcd,ply', out: 'public/test-data/datasets', density: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--frames') args.frames = Number(argv[++i])
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--formats') args.formats = argv[++i]
    else if (a === '--density') args.density = Number(argv[++i])
    else if (a === '--out') args.out = argv[++i]
  }
  return args
}

async function generateScene(profile, args, outRoot, classOf) {
  const frames = args.frames || profile.frames
  const formats = args.formats.split(',').map((f) => f.trim()).filter(Boolean)
  const sceneDir = join(outRoot, profile.id)
  await rm(sceneDir, { recursive: true, force: true })
  await mkdir(join(sceneDir, 'labels'), { recursive: true })
  await mkdir(join(sceneDir, 'point_labels'), { recursive: true })

  // 按密度倍率缩放采样步长，得到更大的数据量
  const eff = applyDensity(profile, args.density)
  const groundZ = -profile.sensorHeight
  const markings = buildMarkings(profile, groundZ)
  const rng = mulberry32(profile.seed)
  const meta = []
  for (let i = 0; i < frames; i++) {
    const id = String(i).padStart(6, '0')
    const { positions, intensities, objects } = buildFrame(eff, i, rng, classOf, markings)
    if (formats.includes('bin')) await writeFile(join(sceneDir, `frame_${id}.bin`), toKittiBin(positions, intensities))
    if (formats.includes('pcd')) await writeFile(join(sceneDir, `frame_${id}.pcd`), toPcdBinary(positions, intensities))
    if (formats.includes('ply')) await writeFile(join(sceneDir, `frame_${id}.ply`), toPlyBinary(positions, intensities))
    await writeFile(join(sceneDir, 'labels', `frame_${id}.json`), JSON.stringify(objects, null, 2))
    meta.push({
      index: i,
      timestamp: Number((i * profile.dt).toFixed(3)),
      bin: formats.includes('bin') ? `frame_${id}.bin` : undefined,
      pcd: formats.includes('pcd') ? `frame_${id}.pcd` : undefined,
      ply: formats.includes('ply') ? `frame_${id}.ply` : undefined,
      label: `labels/frame_${id}.json`,
      pointLabels: markings.segments.length ? 'point_labels/markings.json' : undefined,
      points: intensities.length,
    })
  }

  // 标线点级标签：所有帧的标线点排在最前且数量一致，因此可共用一份索引文件
  if (markings.segments.length) {
    const labeled = markings.segments.reduce((s, seg) => s + seg.indices.length, 0)
    await writeFile(
      join(sceneDir, 'point_labels', 'markings.json'),
      JSON.stringify({ pointCount: markings.points.length, labeled, segments: markings.segments }),
    )
  }

  const scene = {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    sensor: { height: profile.sensorHeight, origin: [0, 0, 0] },
    coordinate: { up: 'z', forward: 'x', right: 'y' },
    dt: profile.dt,
    classes: CLASSES,
    camera: profile.camera,
    frames: meta,
  }
  await writeFile(join(sceneDir, 'scene.json'), JSON.stringify(scene, null, 2))

  const total = meta.reduce((s, f) => s + f.points, 0)
  const bytesPerPoint =
    (formats.includes('bin') ? 16 : 0) +
    (formats.includes('pcd') ? 16 : 0) +
    (formats.includes('ply') ? 15 : 0)
  const approxMB = (total * bytesPerPoint) / 1024 / 1024
  console.log(
    `[gen] ${profile.id.padEnd(10)} 密度 ${(eff.density || 1).toFixed(1)}x  ${String(frames).padStart(3)} 帧  ` +
      `平均 ${Math.round(total / frames).toLocaleString()} 点/帧  合计 ${total.toLocaleString()} 点  ≈${approxMB.toFixed(0)} MB  ` +
      `标线 ${markings.objects.length} 个 / ${markings.points.length.toLocaleString()} 点`,
  )
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    frames,
    pointsPerFrame: Math.round(total / frames),
    totalPoints: total,
    markings: {
      objects: markings.objects.length,
      points: markings.points.length,
      classes: markings.segments.map((s) => ({
        classId: s.classId,
        name: CLASSES.find((c) => c.id === s.classId)?.name,
        points: s.indices.length,
      })),
    },
    camera: profile.camera,
    classes: CLASSES,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outRoot = resolve(ROOT, args.out)
  await rm(outRoot, { recursive: true, force: true })
  await mkdir(outRoot, { recursive: true })

  const classOf = (name) => CLASSES.find((c) => c.name === name)?.id ?? 0
  const scenes = args.only ? SCENES.filter((s) => s.id === args.only) : SCENES
  if (!scenes.length) throw new Error(`未找到场景: ${args.only}`)

  const index = []
  for (const profile of scenes) {
    index.push(await generateScene(profile, args, outRoot, classOf))
  }
  await writeFile(join(outRoot, 'index.json'), JSON.stringify({ datasets: index }, null, 2))
  console.log(`[gen] 数据集输出 -> ${outRoot}`)
  console.log(`[gen] 场景列表: ${index.map((d) => d.id).join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * 合成多帧点云测试数据生成器（无第三方依赖，直接 node 运行）
 *
 * 生成三份数据集，输出到 public/test-data/datasets/<id>/：
 *   <id>/frame_XXXXXX.{bin,pcd,ply}   同源三种格式（bin=KITTI float32[xyz,intensity]）
 *   <id>/labels/frame_XXXXXX.json     逐帧 3D 框真值
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
]

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

function buildFrame(profile, frameIndex, rng, classOf) {
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

  // 按密度倍率缩放采样步长，得到更大的数据量
  const eff = applyDensity(profile, args.density)
  const rng = mulberry32(profile.seed)
  const meta = []
  for (let i = 0; i < frames; i++) {
    const id = String(i).padStart(6, '0')
    const { positions, intensities, objects } = buildFrame(eff, i, rng, classOf)
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
      points: intensities.length,
    })
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
      `平均 ${Math.round(total / frames).toLocaleString()} 点/帧  合计 ${total.toLocaleString()} 点  ≈${approxMB.toFixed(0)} MB`,
  )
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    frames,
    pointsPerFrame: Math.round(total / frames),
    totalPoints: total,
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

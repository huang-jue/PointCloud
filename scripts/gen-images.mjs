/**
 * 为示例数据集生成合成相机图像（SVG），用于 2D 图像联动演示。
 *
 * 用法：
 *   node scripts/gen-images.mjs --only urban --step 20
 *   npm run gen:images -- --only urban
 *
 * 不重新生成点云，只读取现有 .bin 帧并写入 images/*.svg，同时更新 scene.json：
 *   camera.intrinsics
 *   frames[].image
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildExtrinsics,
  defaultIntrinsics,
  projectPoint,
} from '../src/utils/projection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = path.join(ROOT, 'public/test-data/datasets')

function parseArgs(argv) {
  const args = { only: null, step: 20 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i]
    else if (argv[i] === '--step') args.step = Math.max(1, Number(argv[++i]) || 20)
  }
  return args
}

function colorForHeight(z) {
  const t = Math.max(0, Math.min(1, (z + 2) / 8))
  const palette = [
    [70, 110, 160],
    [80, 150, 190],
    [100, 180, 160],
    [190, 180, 120],
    [220, 150, 100],
    [220, 110, 110],
  ]
  const index = Math.min(palette.length - 1, Math.floor(t * palette.length))
  return `rgb(${palette[index].join(',')})`
}

function makeSvg(points, width, height) {
  const groups = new Map()
  for (const p of points) {
    const color = colorForHeight(p.z)
    if (!groups.has(color)) groups.set(color, [])
    groups.get(color).push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.4"/>`)
  }
  const body = [...groups.entries()]
    .map(([color, circles]) => `<g fill="${color}" opacity="0.9">${circles.join('')}</g>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#0b0f14"/>${body}</svg>`
}

async function loadBin(file) {
  const buffer = await readFile(file)
  const floats = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
  return floats
}

async function generateDataset(dir, dataset, { step }) {
  const scenePath = path.join(dir, 'scene.json')
  const scene = JSON.parse(await readFile(scenePath, 'utf8'))
  if (!scene.camera?.position || !scene.camera?.target) {
    console.log(`[skip] ${dataset}: scene.camera 缺少 position/target`)
    return
  }
  const intrinsics = scene.camera.intrinsics || defaultIntrinsics()
  const extrinsics = buildExtrinsics(scene.camera.position, scene.camera.target)
  const imageDir = path.join(dir, 'images')
  await mkdir(imageDir, { recursive: true })

  const files = (await readdir(dir)).filter((name) => name.endsWith('.bin')).sort()
  let done = 0
  for (const file of files) {
    const frame = (scene.frames || []).find((f) => f.bin === file || f.pcd === file || f.ply === file)
    if (!frame) continue
    const floats = await loadBin(path.join(dir, file))
    const points = []
    const stride = 4 * step
    for (let i = 0; i < floats.length; i += stride) {
      const projected = projectPoint(
        [floats[i], floats[i + 1], floats[i + 2]],
        extrinsics,
        intrinsics,
      )
      if (!projected) continue
      if (projected.x < 0 || projected.x > intrinsics.width) continue
      if (projected.y < 0 || projected.y > intrinsics.height) continue
      points.push(projected)
    }
    const svg = makeSvg(points, intrinsics.width, intrinsics.height)
    const imageName = `${path.basename(file, path.extname(file))}.svg`
    await writeFile(path.join(imageDir, imageName), svg)
    frame.image = `images/${imageName}`
    done++
  }

  scene.camera.intrinsics = intrinsics
  await writeFile(scenePath, JSON.stringify(scene, null, 2) + '\n')
  console.log(`[ok] ${dataset}: ${done} 帧图像 -> ${path.relative(ROOT, imageDir)}`)
}

const args = parseArgs(process.argv.slice(2))
const entries = await readdir(BASE, { withFileTypes: true })
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  if (args.only && entry.name !== args.only) continue
  const hasScene = await readFile(path.join(BASE, entry.name, 'scene.json'), 'utf8').then(
    () => true,
    () => false,
  )
  if (!hasScene) continue
  await generateDataset(path.join(BASE, entry.name), entry.name, args)
}

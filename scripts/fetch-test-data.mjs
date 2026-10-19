/**
 * 下载真实单帧点云样本到 public/test-data/real/
 * 覆盖 PCD(ascii/rgba/binary_compressed)、PLY(ascii)、LAS、LAZ 多种编码，
 * 用于验证各格式解析路径。已存在的文件会跳过。
 *
 * 用法：node scripts/fetch-test-data.mjs
 */
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

/** PCL 官方测试点云 */
const BASE = 'https://raw.githubusercontent.com/PointCloudLibrary/pcl/master/test'
/** 文件名 -> 下载地址 */
const SOURCES = [
  { name: 'bunny.pcd', url: `${BASE}/bunny.pcd` },
  { name: 'cube.ply', url: `${BASE}/cube.ply` },
  { name: 'milk_color.pcd', url: `${BASE}/milk_color.pcd` },
  { name: 'car6.pcd', url: `${BASE}/car6.pcd` },
  { name: 'simple.las', url: 'https://raw.githubusercontent.com/laspy/laspy/master/tests/data/simple.las' },
  { name: 'simple.laz', url: 'https://raw.githubusercontent.com/laspy/laspy/master/tests/data/simple.laz' },
]

/** 下载单个文件并写入目标路径，返回字节数 */
async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return buf.length
}

async function main() {
  const outDir = resolve(ROOT, 'public/test-data/real')
  await mkdir(outDir, { recursive: true })

  for (const { name, url } of SOURCES) {
    const dest = join(outDir, name)
    try {
      await stat(dest)
      console.log(`[fetch-test-data] skip (exists) ${name}`)
      continue
    } catch {
      // 文件不存在，继续下载
    }
    const size = await download(url, dest)
    console.log(`[fetch-test-data] ${name} (${size} bytes)`)
  }
  console.log(`[fetch-test-data] done -> ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

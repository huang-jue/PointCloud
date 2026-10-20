/**
 * 标注数据的保存：组装完整载荷 + 提交到后端接口
 *
 * 后端地址通过环境变量配置（见 .env.example）：
 *   VITE_SAVE_API=https://your-server/api/annotations
 * 未配置时「保存」会退化为下载 JSON，方便离线使用。
 *
 * 载荷结构（可直接作为后端入库/落盘的入参）：
 * {
 *   format: 'pointcloud-annotation',
 *   version: 1,
 *   dataset: 'urban',
 *   savedAt: '2026-10-19T...',
 *   coordinate: { up, forward, right },
 *   classes: [{ id, name, color }],
 *   frames: [{
 *     index, name, timestamp, pointCount,
 *     objects: [
 *       // 3D 框
 *       { id, trackId, startFrame, multiFrame, classId, type,
 *         h, w, l, x, y, z, ry, score, source },
 *       // 路面标线（线 / 箭头）
 *       { id, shape: 'line', classId, type, width, points: [[x,y,z], ...], trackId, ... },
 *       { id, shape: 'arrow', classId, type, width, template,
 *         paths: [[[x,y,z], ...], ...], trackId, ... }
 *     ],
 *     pointLabels?: { pointCount, labeled, labels: number[], segments: [{ classId, indices: number[] }] }
 *   }]
 * }
 */
import { state } from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { post } from './http.js'

/** 后端保存接口地址（构建期注入） */
export const SAVE_API = import.meta.env.VITE_SAVE_API || ''

/** 是否已配置后端接口 */
export function isSaveConfigured() {
  return !!SAVE_API
}

/**
 * 组装保存载荷
 * @param {{includeLabels?: boolean}} [options] 是否包含点级语义标签（体积较大）
 */
export function buildSavePayload({ includeLabels = true } = {}) {
  const viewer = viewerRef.current
  const frames = state.frames.map((f) => {
    const item = {
      index: f.index,
      name: f.name,
      timestamp: f.timestamp,
      pointCount: f.pointCount ?? null,
      objects: f.objects.map((o) => ({ ...o })),
    }
    if (includeLabels && viewer) {
      // 点标签保存在视口侧（按帧缓存），这里取出来一起提交
      const labels = viewer.serializeLabels(viewer.cacheKeyFor(f))
      if (labels) item.pointLabels = labels
    }
    return item
  })

  return {
    format: 'pointcloud-annotation',
    version: 1,
    dataset: state.datasetName,
    savedAt: new Date().toISOString(),
    coordinate: { ...state.coordinate },
    classes: state.classes.map((c) => ({ ...c })),
    frames,
  }
}

/** 载荷统计信息，用于提示文案 */
export function summarizePayload(payload) {
  let objects = 0
  let boxes = 0
  let lines = 0
  let arrows = 0
  let labeledFrames = 0
  let labeledPoints = 0
  for (const f of payload.frames) {
    objects += f.objects.length
    for (const o of f.objects) {
      if (o.shape === 'line') lines++
      else if (o.shape === 'arrow') arrows++
      else boxes++
    }
    if (f.pointLabels) {
      labeledFrames++
      labeledPoints += f.pointLabels.labeled
    }
  }
  return { frames: payload.frames.length, objects, boxes, lines, arrows, labeledFrames, labeledPoints }
}

/**
 * 提交到后端（经统一 HTTP 封装层，统一超时/错误处理）
 * @param {object} payload buildSavePayload 的结果
 * @returns {Promise<any>} 后端返回的 JSON（若有）
 */
export async function saveToServer(payload) {
  if (!SAVE_API) throw new Error('未配置后端保存接口（VITE_SAVE_API）')
  // silent: 由调用方统一提示，避免重复弹窗
  return post(SAVE_API, payload, { silent: true, timeout: 120000 })
}

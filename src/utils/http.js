/**
 * HTTP 封装层（基于 axios）
 *
 * 统一处理：
 *  - baseURL / 超时（构建期由 VITE_API_BASE、VITE_API_TIMEOUT 注入）
 *  - 认证 token 注入与持久化
 *  - 响应解包：兼容 `{ code, data, message }` 业务包装，直接返回 data
 *  - 错误归一化：网络错误 / 超时 / HTTP 状态码 / 业务码，统一成带 message 的 Error
 *  - 统一错误提示（可用 `silent: true` 关闭，交由调用方自行处理）
 *  - 二进制下载（点云文件），可选下载进度
 *
 * 用法：
 *   import { http, get, post, downloadBinary } from '@/utils/http.js'
 *   const scene = await get('/test-data/datasets/index.json')
 *   await post(SAVE_API, payload, { silent: true })
 */

import axios from 'axios'
import { ElMessage } from 'element-plus'

const BASE_URL = import.meta.env.VITE_API_BASE || ''
const DEFAULT_TIMEOUT = Number(import.meta.env.VITE_API_TIMEOUT || 30000)
const TOKEN_KEY = 'pc-annotate-token'

let authToken = ''
try {
  authToken = localStorage.getItem(TOKEN_KEY) || ''
} catch {
  authToken = ''
}

/** 设置认证 token（会持久化到 localStorage） */
export function setAuthToken(token) {
  authToken = token || ''
  try {
    if (authToken) localStorage.setItem(TOKEN_KEY, authToken)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

export function getAuthToken() {
  return authToken
}

export function clearAuthToken() {
  setAuthToken('')
}

/* ---------------- 实例与拦截器 ---------------- */

export const http = axios.create({
  baseURL: BASE_URL,
  timeout: DEFAULT_TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
})

let requestSeq = 0

// 请求拦截：注入 token / 请求编号（便于后端串联日志）
http.interceptors.request.use(
  (config) => {
    if (authToken) config.headers.Authorization = `Bearer ${authToken}`
    requestSeq += 1
    config.headers['X-Request-Id'] = `${Date.now().toString(36)}-${requestSeq}`
    return config
  },
  (error) => Promise.reject(error),
)

// 响应拦截：解包 + 归一化错误
http.interceptors.response.use(
  (response) => {
    // raw=true 时保留完整响应（需要读 headers，例如二进制下载）
    if (response.config?.raw) return response
    const body = response.data
    if (isEnvelope(body)) {
      if (isOkCode(body.code)) return body.data
      const err = new Error(`业务错误(${body.code})${pickMessage(body) ? `: ${pickMessage(body)}` : ''}`)
      err.bizCode = body.code
      err.response = response
      return Promise.reject(err)
    }
    return body
  },
  (error) => {
    const normalized = normalizeError(error)
    if (!error.config?.silent) ElMessage.error(normalized.message)
    return Promise.reject(normalized)
  },
)

/** 是否形如 { code, data, message } 的业务包装体 */
function isEnvelope(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'code' in body &&
    ('data' in body || 'message' in body || 'msg' in body)
  )
}

function isOkCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200' || code === true
}

function pickMessage(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.slice(0, 200)
  return data.message || data.msg || data.error || ''
}

/** 把 axios 错误转换成带友好 message 的 Error */
function normalizeError(error) {
  if (axios.isCancel(error)) {
    const e = new Error('请求已取消')
    e.canceled = true
    return e
  }
  const config = error.config || {}
  let message
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    message = `请求超时（${config.timeout || DEFAULT_TIMEOUT}ms）`
  } else if (error.response) {
    const detail = pickMessage(error.response.data)
    message = `请求失败 HTTP ${error.response.status}${detail ? ` - ${detail}` : ''}`
  } else if (error.request) {
    message = '网络错误或服务不可达'
  } else {
    message = error.message || '请求失败'
  }
  const e = new Error(message)
  e.status = error.response?.status
  e.url = config.url
  e.raw = error
  return e
}

/* ---------------- 便捷方法 ---------------- */

export function request(config) {
  return http.request(config)
}

export function get(url, params, config) {
  return http.get(url, { params, ...config })
}

export function post(url, data, config) {
  return http.post(url, data, config)
}

export function put(url, data, config) {
  return http.put(url, data, config)
}

export function del(url, config) {
  return http.delete(url, config)
}

/**
 * 下载二进制数据（点云文件等）
 * @param {string} url
 * @param {{timeout?:number, silent?:boolean, onProgress?:(percent:number)=>void}} [options]
 * @returns {Promise<{data:ArrayBuffer, contentType:string, status:number}>}
 */
export async function downloadBinary(url, options = {}) {
  const res = await http.get(url, {
    responseType: 'arraybuffer',
    raw: true,
    timeout: options.timeout ?? 120000,
    silent: options.silent === true,
    signal: options.signal,
    onDownloadProgress: (event) => {
      if (!options.onProgress) return
      const total = event.total || 0
      options.onProgress(total ? Math.round((event.loaded / total) * 100) : 0)
    },
  })
  return {
    data: res.data,
    contentType: res.headers?.['content-type'] || '',
    status: res.status,
  }
}

/** 通用的 loading 包裹：自动开关某个 ref，异常继续抛出 */
export async function withLoading(loadingRef, fn) {
  if (loadingRef) loadingRef.value = true
  try {
    return await fn()
  } finally {
    if (loadingRef) loadingRef.value = false
  }
}

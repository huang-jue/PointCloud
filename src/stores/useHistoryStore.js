/**
 * useHistoryStore —— 标注编辑的通用撤销/重做
 *
 * 只保存操作级差异，不保存整帧快照：
 *   change  修改字段（before/after 只含变化字段）
 *   add     新增对象（撤销移除、重做按原位置插回）
 *   remove  删除对象（撤销按原位置插回、重做移除）
 *   clear   清空整帧（仅当前帧）
 *
 * 通过 bindHistory 注入 frames 访问器，避免与 useAnnotationStore 循环依赖。
 * 帧被提交/通过后不允许撤销/重做涉及该帧的操作。
 */
import { computed, reactive } from 'vue'
import { isFrameLocked } from './reviewCore.js'

const LIMIT = 60
let getFrames = () => []
let applying = false
let seq = 0

export const historyState = reactive({
  undo: [],
  redo: [],
  version: 0,
})

export const canUndo = computed(() => historyState.undo.length > 0)
export const canRedo = computed(() => historyState.redo.length > 0)

export function bindHistory(accessors) {
  if (accessors && typeof accessors.getFrames === 'function') getFrames = accessors.getFrames
}

export function cloneData(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* 含不可克隆字段时退回 JSON */
    }
  }
  return JSON.parse(JSON.stringify(value))
}

function frameAt(index) {
  return getFrames()[index] || null
}

function findObject(frame, id) {
  return frame?.objects?.find((o) => o.id === id) || null
}

function insertItem(item) {
  const frame = frameAt(item.frameIndex)
  if (!frame || !item.obj) return
  if (frame.objects.some((o) => o.id === item.obj.id)) return
  const at = Math.max(0, Math.min(item.index ?? frame.objects.length, frame.objects.length))
  frame.objects.splice(at, 0, cloneData(item.obj))
}

function removeItem(item) {
  const frame = frameAt(item.frameIndex)
  if (!frame || !item.obj) return
  const index = frame.objects.findIndex((o) => o.id === item.obj.id)
  if (index !== -1) frame.objects.splice(index, 1)
}

function applyChange(change, direction) {
  const frame = frameAt(change.frameIndex)
  if (!frame) return
  const obj = findObject(frame, change.id)
  if (!obj) return
  const snapshot = direction === 'undo' ? change.before : change.after
  if (!snapshot) return
  for (const [key, value] of Object.entries(snapshot)) obj[key] = cloneData(value)
}

function applyOp(op, direction) {
  if (!op) return
  if (op.type === 'change') {
    for (const change of op.changes || []) applyChange(change, direction)
    return
  }
  if (op.type === 'add') {
    const items = op.items || []
    for (const item of direction === 'undo' ? items.slice().reverse() : items) {
      if (direction === 'undo') removeItem(item)
      else insertItem(item)
    }
    return
  }
  if (op.type === 'remove') {
    const items = op.items || []
    if (direction === 'undo') {
      // 按原位置降序插回：先插后面的，避免前面的插入导致索引偏移
      const ordered = items
        .slice()
        .sort((a, b) => a.frameIndex - b.frameIndex || (b.index ?? 0) - (a.index ?? 0))
      for (const item of ordered) insertItem(item)
    } else {
      for (const item of items.slice().reverse()) removeItem(item)
    }
    return
  }
  if (op.type === 'clear') {
    const frame = frameAt(op.frameIndex)
    if (!frame) return
    if (direction === 'undo') {
      frame.objects.splice(0, frame.objects.length, ...cloneData(op.objects || []))
    } else {
      frame.objects.splice(0, frame.objects.length)
    }
  }
}

function collectFrames(ops) {
  const indexes = new Set()
  for (const op of ops) {
    if (op.type === 'change') {
      for (const change of op.changes || []) indexes.add(change.frameIndex)
    } else if (op.type === 'add' || op.type === 'remove') {
      for (const item of op.items || []) indexes.add(item.frameIndex)
    } else if (op.type === 'clear') {
      indexes.add(op.frameIndex)
    }
  }
  return Array.from(indexes).filter((i) => Number.isInteger(i) && i >= 0)
}

function mergeChanges(target, incoming) {
  for (const change of incoming.changes || []) {
    const existing = (target.changes || []).find(
      (item) => item.frameIndex === change.frameIndex && item.id === change.id,
    )
    if (!existing) {
      target.changes.push(change)
      continue
    }
    for (const [key, value] of Object.entries(change.after || {})) {
      existing.after[key] = cloneData(value)
    }
  }
}

function mergeCommand(target, incoming) {
  if (!target || !incoming) return false
  if (!target.ops.every((op) => op.type === 'change')) return false
  if (!incoming.ops.every((op) => op.type === 'change')) return false
  for (let i = 0; i < incoming.ops.length; i++) {
    if (!target.ops[i]) target.ops.push(incoming.ops[i])
    else mergeChanges(target.ops[i], incoming.ops[i])
  }
  target.frames = Array.from(new Set([...(target.frames || []), ...(incoming.frames || [])]))
  return true
}

/**
 * 入栈一条操作
 * @param {{label?:string, ops:Array, mergeKey?:string, mergeWindow?:number}} command
 */
export function pushCommand(command) {
  if (applying || !command || !Array.isArray(command.ops) || !command.ops.length) return null
  const now = Date.now()
  const cmd = {
    id: ++seq,
    time: now,
    label: command.label || '编辑',
    ops: command.ops,
    frames: command.frames || collectFrames(command.ops),
    mergeKey: command.mergeKey || '',
  }
  const top = historyState.undo[historyState.undo.length - 1]
  if (
    cmd.mergeKey &&
    top &&
    top.mergeKey === cmd.mergeKey &&
    now - top.time <= (command.mergeWindow ?? 800) &&
    mergeCommand(top, cmd)
  ) {
    top.time = now
    top.frames = Array.from(new Set([...top.frames, ...cmd.frames]))
    historyState.version++
    return top
  }
  historyState.undo.push(cmd)
  while (historyState.undo.length > LIMIT) historyState.undo.shift()
  historyState.redo.length = 0
  historyState.version++
  return cmd
}

function ensureEditable(cmd) {
  for (const index of cmd.frames || []) {
    if (isFrameLocked(index)) {
      throw new Error('操作涉及已提交/已通过的帧，不能撤销或重做')
    }
  }
}

export function undoCommand() {
  const cmd = historyState.undo[historyState.undo.length - 1]
  if (!cmd) return null
  ensureEditable(cmd)
  applying = true
  try {
    for (const op of cmd.ops.slice().reverse()) applyOp(op, 'undo')
  } finally {
    applying = false
  }
  historyState.undo.pop()
  historyState.redo.push(cmd)
  historyState.version++
  return cmd
}

export function redoCommand() {
  const cmd = historyState.redo[historyState.redo.length - 1]
  if (!cmd) return null
  ensureEditable(cmd)
  applying = true
  try {
    for (const op of cmd.ops) applyOp(op, 'redo')
  } finally {
    applying = false
  }
  historyState.redo.pop()
  historyState.undo.push(cmd)
  historyState.version++
  return cmd
}

export function clearHistory() {
  historyState.undo.length = 0
  historyState.redo.length = 0
  historyState.version++
}

export function isApplyingHistory() {
  return applying
}

/**
 * 需要弹窗确认的标注操作封装（UI 与 store 之间的薄层）
 */
import { ElMessageBox } from 'element-plus'
import { state, removeObject, countTrackFrames } from '../stores/useAnnotationStore.js'

/**
 * 删除对象；若是多帧物体则先弹窗确认（从当前帧起截断后续帧）
 * @param {object} obj 当前帧的对象
 * @param {{ask?:boolean}} [options] ask=false 时不弹窗直接删除
 * @returns {Promise<boolean>} 是否已删除
 */
export async function requestRemoveObject(obj, { ask = true } = {}) {
  if (!obj) return false
  const propagate = !!obj.multiFrame
  const spans = propagate ? countTrackFrames(obj.trackId) : 0
  if (propagate && ask && spans > 1) {
    try {
      await ElMessageBox.confirm(
        `「${obj.type}」是多帧物体，将从第 ${state.currentIndex + 1} 帧起删除后续 ${spans - 1} 帧中的该物体。`,
        '删除多帧物体',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      )
    } catch {
      return false // 用户取消
    }
  }
  removeObject(obj.id, { propagate })
  return true
}

/**
 * 批量删除选中对象（多选）
 * @param {object[]} objs
 * @param {{ask?:boolean}} [options]
 * @returns {Promise<number>} 实际删除数量
 */
export async function requestRemoveObjects(objs, { ask = true } = {}) {
  const list = Array.from(objs || []).filter(Boolean)
  if (!list.length) return 0
  if (list.length === 1) {
    return (await requestRemoveObject(list[0], { ask })) ? 1 : 0
  }
  const multi = list.filter((o) => o.multiFrame && o.trackId > 0)
  if (ask) {
    const extra = multi.length
      ? `其中 ${multi.length} 个多帧物体将从当前帧起截断后续帧。`
      : ''
    try {
      await ElMessageBox.confirm(`确定删除选中的 ${list.length} 个对象？${extra}`, '批量删除', {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      })
    } catch {
      return 0
    }
  }
  for (const obj of list) removeObject(obj.id, { propagate: !!obj.multiFrame })
  return list.length
}

/** 生成进程内唯一 id，用于标注对象等临时标识 */
let seq = 0

/**
 * @param {string} [prefix] id 前缀，便于调试时区分类型
 * @returns {string}
 */
export function uid(prefix = 'id') {
  seq += 1
  return `${prefix}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

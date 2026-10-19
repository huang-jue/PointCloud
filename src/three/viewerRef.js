/**
 * 3D 视口实例的模块级引用。
 * 组件（如属性面板、分割面板）需要直接操作 viewer 时通过此引用访问，
 * 避免在 Pinia/store 中持有 Three.js 对象（会造成响应式代理问题）。
 */
export const viewerRef = { current: null }

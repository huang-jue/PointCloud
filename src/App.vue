<script setup>
/**
 * App —— 应用外壳
 *  - 三栏布局：左侧对象列表 / 中间 3D 视口 / 右侧属性·类别·分割面板
 *  - 顶部工具栏、底部时间轴与状态栏
 *  - 全局快捷键；统一监听 state.error 弹出提示；支持 URL 参数自动加载数据集
 */
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage } from 'element-plus'
import Toolbar from './components/Toolbar.vue'
import ObjectList from './components/ObjectList.vue'
import Properties from './components/Properties.vue'
import ClassManager from './components/ClassManager.vue'
import SegmentPanel from './components/SegmentPanel.vue'
import Viewer from './components/Viewer.vue'
import Timeline from './components/Timeline.vue'
import StatusBar from './components/StatusBar.vue'
import { state, store, selectedObject } from './stores/useAnnotationStore.js'
import { viewerRef } from './three/viewerRef.js'
import { requestRemoveObject } from './utils/actions.js'

/** 任意组件把错误写进 state.error，这里统一弹出并复位 */
watch(
  () => state.error,
  (err) => {
    if (!err) return
    ElMessage.error(err)
    state.error = ''
  },
)

/** 焦点在输入类控件时不触发快捷键，避免误操作 */
function isTyping(target) {
  const tag = target?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
}

function onKeydown(event) {
  if (isTyping(event.target)) return
  // Ctrl/Cmd+Z：撤销上一步点标签
  if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
    if (viewerRef.current?.undoLabel()) ElMessage.info('已撤销上一步标签')
    event.preventDefault()
    return
  }
  switch (event.key) {
    case 'ArrowLeft':
      store.step(-1)
      break
    case 'ArrowRight':
      store.step(1)
      break
    case ' ':
      state.playing = !state.playing
      break
    case 'w':
    case 'W':
      state.tool = 'translate'
      break
    case 'e':
    case 'E':
      state.tool = 'rotate'
      break
    case 'r':
    case 'R':
      state.tool = 'scale'
      break
    case 'q':
    case 'Q':
      state.tool = 'select'
      break
    case 'b':
    case 'B':
      state.segEnabled = !state.segEnabled
      break
    case 'f':
    case 'F':
      viewerRef.current?.fitView()
      break
    case 'Delete':
    case 'Backspace':
      if (selectedObject.value) requestRemoveObject(selectedObject.value)
      break
    default:
      return
  }
  event.preventDefault()
}

/**
 * URL 参数：
 *   ?dataset=<id>  加载指定示例数据集（urban / highway / crossing）
 *   ?seq           加载第一个数据集（兼容旧链接）
 *   ?gt=1          加载后自动导入当前帧真值
 */
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  const params = new URLSearchParams(location.search)
  const ds = params.get('dataset')
  if (!ds && !params.has('seq')) return
  const id = ds && ds !== 'sequence' ? ds : null
  const resolved = id ? Promise.resolve(id) : store.listSampleDatasets().then((list) => list[0]?.id)
  resolved
    .then((datasetId) => (datasetId ? store.loadSampleDataset(datasetId) : null))
    .then(() => (params.has('gt') ? store.importGroundTruth() : null))
    .catch((err) => {
      state.error = err.message || String(err)
    })
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="app">
    <Toolbar />
    <div class="app-body">
      <ObjectList />
      <Viewer />
      <!-- 右侧面板：对象属性 / 类别管理 / 点级分割 -->
      <aside class="panel panel-right">
        <div class="panel-body">
          <Properties />
          <ClassManager />
          <SegmentPanel />
        </div>
      </aside>
    </div>
    <Timeline />
    <StatusBar />
  </div>
</template>

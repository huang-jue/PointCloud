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
import CommentPanel from './components/CommentPanel.vue'
import ReviewWorkbench from './components/ReviewWorkbench.vue'
import SuggestionPanel from './components/SuggestionPanel.vue'
import QualityPanel from './components/QualityPanel.vue'
import VersionPanel from './components/VersionPanel.vue'
import ImagePanel from './components/ImagePanel.vue'
import DemoTour from './components/DemoTour.vue'
import LoginDialog from './components/LoginDialog.vue'
import Viewer from './components/Viewer.vue'
import Timeline from './components/Timeline.vue'
import StatusBar from './components/StatusBar.vue'
import {
  state,
  store,
  selectedObjects,
  setTool,
  copySelected,
  pasteObjects,
  duplicateSelected,
  selectObjects,
  clearSelection,
} from './stores/useAnnotationStore.js'
import { viewerRef } from './three/viewerRef.js'
import { requestRemoveObjects } from './utils/actions.js'
import { ROLES, authState, canAnnotate, login, openLogin } from './stores/useAuthStore.js'
import { canEditCurrentFrame } from './stores/useReviewStore.js'

/** 角色切换或当前帧被锁定后退出绘制/分割，保持只读 */
watch(canEditCurrentFrame, (allowed) => {
  if (allowed) return
  state.segEnabled = false
  if (state.tool !== 'select') setTool('select')
})

/** 多帧传播跳过已锁定帧时给出一次汇总提示 */
watch(
  () => state.lockSkipCount,
  (count) => {
    if (!count) return
    ElMessage.info(`已跳过 ${count} 个已提交/已通过帧`)
    state.lockSkipCount = 0
  },
)

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

/** 是否处于标线绘制中 */
function isDrawing() {
  return canEditCurrentFrame.value && (state.tool === 'line' || state.tool === 'arrow')
}

/** 有手工标注/复制对象或编辑过点标签时，离开页面前提醒（演示环境不自动持久化） */
function hasUnsavedWork() {
  const manualObject = state.frames.some((f) =>
    f.objects.some((o) => o.source === 'manual' || o.source === 'copy'),
  )
  const editedLabels = (viewerRef.current?.labelsByKey?.size || 0) > 0
  return manualObject || editedLabels
}

function onBeforeUnload(event) {
  if (!hasUnsavedWork()) return
  event.preventDefault()
  event.returnValue = ''
}

function onKeydown(event) {
  if (isTyping(event.target)) return
  const mod = event.ctrlKey || event.metaKey
  // 批注员/未登录/当前帧已锁定：只保留浏览快捷键，禁止任何标注修改
  if (!canEditCurrentFrame.value) {
    const blocked = ['w', 'W', 'e', 'E', 'r', 'R', 'l', 'L', 'a', 'A', 'b', 'B', 'Delete', 'Backspace']
    const blockedMod = ['z', 'Z', 'v', 'V', 'd', 'D']
    if (blocked.includes(event.key) || (mod && blockedMod.includes(event.key))) {
      event.preventDefault()
      return
    }
  }
  // 绘制中：Enter 完成 / Esc 取消 / Backspace 退点
  if (isDrawing()) {
    if (event.key === 'Enter') {
      if (!viewerRef.current?.finishDrawing()) ElMessage.warning('至少需要 2 个点才能生成标线')
      event.preventDefault()
      return
    }
    if (event.key === 'Escape') {
      viewerRef.current?.cancelDrawing()
      event.preventDefault()
      return
    }
    if (event.key === 'Backspace') {
      viewerRef.current?.undoDrawPoint()
      event.preventDefault()
      return
    }
  }
  // Ctrl/Cmd+Z：撤销上一步点标签
  if (mod && (event.key === 'z' || event.key === 'Z')) {
    if (viewerRef.current?.undoLabel()) {
      store.bumpLabelVersion()
      state.selectedSegment = null
      ElMessage.info('已撤销上一步标签')
    }
    event.preventDefault()
    return
  }
  // 多选与复制粘贴
  if (mod && (event.key === 'c' || event.key === 'C')) {
    const n = copySelected()
    if (n) ElMessage.success(`已复制 ${n} 个对象`)
    event.preventDefault()
    return
  }
  if (mod && (event.key === 'v' || event.key === 'V')) {
    const n = pasteObjects({ inPlace: event.shiftKey })
    if (n) ElMessage.success(`已粘贴 ${n} 个对象`)
    event.preventDefault()
    return
  }
  if (mod && (event.key === 'd' || event.key === 'D')) {
    const n = duplicateSelected()
    if (n) ElMessage.success(`已复制 ${n} 个对象`)
    event.preventDefault()
    return
  }
  if (mod && (event.key === 'a' || event.key === 'A')) {
    selectObjects(store.currentObjects.value.map((o) => o.id))
    event.preventDefault()
    return
  }
  // 其他组合键交给浏览器/系统处理
  if (mod || event.altKey) return
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
      setTool('translate')
      break
    case 'e':
    case 'E':
      setTool('rotate')
      break
    case 'r':
    case 'R':
      setTool('scale')
      break
    case 'q':
    case 'Q':
      setTool('select')
      break
    case 'l':
    case 'L':
      setTool('line')
      break
    case 'a':
    case 'A':
      setTool('arrow')
      break
    case 'b':
    case 'B':
      state.segEnabled = !state.segEnabled
      if (state.segEnabled) setTool('select')
      break
    case 'f':
    case 'F':
      viewerRef.current?.fitView()
      break
    case 'Escape':
      clearSelection()
      break
    case 'Delete':
    case 'Backspace':
      if (selectedObjects.value.length) requestRemoveObjects(selectedObjects.value)
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
  window.addEventListener('beforeunload', onBeforeUnload)
  const params = new URLSearchParams(location.search)
  const urlUser = params.get('user')
  const urlRole = params.get('role')
  if (urlUser && ROLES.some((r) => r.id === urlRole)) {
    // 演示用：?user=张三&role=reviewer 直接以指定身份进入（方便双标签演示）
    try {
      login(urlUser, urlRole)
    } catch (err) {
      state.error = err.message || String(err)
    }
  } else if (!authState.user) {
    openLogin()
  }
  const ds = params.get('dataset')
  if (!ds && !params.has('seq')) return
  const id = ds && ds !== 'sequence' ? ds : null
  const resolved = id ? Promise.resolve(id) : store.listSampleDatasets().then((list) => list[0]?.id)
  resolved
    // loadSampleDataset 内部会自动导入全量真值（?gt=1 仍然兼容）
    .then((datasetId) => (datasetId ? store.loadSampleDataset(datasetId) : null))
    .catch((err) => {
      state.error = err.message || String(err)
    })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <div class="app">
    <Toolbar />
    <div class="app-body">
      <ObjectList />
      <Viewer />
      <!-- 右侧面板：批注审核 + 标注编辑（批注员只显示批注） -->
      <aside class="panel panel-right">
        <div class="panel-body">
          <CommentPanel />
          <template v-if="canAnnotate">
            <Properties />
            <ClassManager />
            <SegmentPanel />
          </template>
        </div>
      </aside>
    </div>
    <Timeline />
    <StatusBar />
    <ReviewWorkbench />
    <SuggestionPanel />
    <QualityPanel />
    <VersionPanel />
    <ImagePanel />
    <DemoTour />
    <LoginDialog />
  </div>
</template>

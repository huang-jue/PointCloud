<script setup>
/**
 * Toolbar —— 顶部工具栏
 *  - 加载示例数据集（下拉）、加载本地文件
 *  - 工具切换（选择/移动/旋转/缩放）、添加框、多帧添加开关、删除
 *  - 着色模式、点大小
 *  - 导入真值 / 导出 KITTI / 清空本帧 / 导入导出标注
 */
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  state,
  store,
  currentFrame,
  selectedObjects,
  activeClass,
  addObject,
  setTool,
  copySelected,
  pasteObjects,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { ACCEPT } from '../three/loaders/index.js'
import { downloadBlob, downloadJson, downloadText, pickFile } from '../utils/io.js'
import { objectsToKittiText } from '../utils/kitti.js'
import { createZip } from '../utils/zip.js'
import { requestRemoveObjects } from '../utils/actions.js'
import { buildSavePayload, summarizePayload, saveToServer, isSaveConfigured } from '../utils/save.js'
import {
  applyReview,
  canEditCurrentFrame,
  resetFramesAfterImport,
  resetReview,
  serializeReview,
} from '../stores/useReviewStore.js'
import { withLoading } from '../utils/http.js'
import { authState, currentRole, openLogin, logout, roleLabel } from '../stores/useAuthStore.js'
import { uiState } from '../stores/useUiStore.js'
import { clearDatasetDrafts, flushDrafts } from '../stores/useDraftStore.js'

const fileInput = ref(null)
const datasets = ref([]) // 示例数据集列表（来自 index.json）
const saving = ref(false)

/** 新建框时按类别给一个合理的初始尺寸 */
const CLASS_DIMS = {
  Car: { l: 4.2, w: 1.8, h: 1.5 },
  Van: { l: 5.4, w: 2.0, h: 2.2 },
  Truck: { l: 9.0, w: 2.5, h: 3.2 },
  Pedestrian: { l: 0.6, w: 0.6, h: 1.7 },
  Cyclist: { l: 1.7, w: 0.7, h: 1.7 },
  Pole: { l: 0.2, w: 0.2, h: 4.0 },
}

/** 编辑工具（select 为不显示手柄的纯选择模式；line/arrow 为标线绘制） */
const TOOLS = [
  { id: 'select', label: '选择' },
  { id: 'translate', label: '移动' },
  { id: 'rotate', label: '旋转' },
  { id: 'scale', label: '缩放' },
  { id: 'line', label: '画线' },
  { id: 'arrow', label: '画箭头' },
]

/** 箭头模板（free = 逐点自由绘制） */
const ARROW_TEMPLATES = [
  { value: 'free', label: '自由折线' },
  { value: 'straight', label: '直行' },
  { value: 'left', label: '左转' },
  { value: 'right', label: '右转' },
  { value: 'straightLeft', label: '直行+左转' },
  { value: 'uturn', label: '掉头' },
]

const isDrawing = computed(() => state.tool === 'line' || state.tool === 'arrow')
const drawingLabel = computed(() => (state.tool === 'arrow' ? '画箭头' : '画线'))
const multiActive = computed(() => state.multiFrame || state.multiFrameMove)
const canUndo = computed(() => store.historyState.undo.length > 0)
const canRedo = computed(() => store.historyState.redo.length > 0)

/** 标线类别名（用于「添加框」时自动避开） */
const MARKING_CLASS_NAMES = ['LaneLine', 'Crosswalk', 'RoadArrow', 'StopLine']

/** 当前绘制线宽（线/箭头各用各的默认值） */
const drawWidth = computed({
  get: () => (state.tool === 'arrow' ? state.arrowWidth : state.lineWidth),
  set: (v) => {
    if (state.tool === 'arrow') state.arrowWidth = Number(v)
    else state.lineWidth = Number(v)
  },
})

/** 绘制操作提示 */
const drawHint = computed(() => {
  if (state.tool === 'line') {
    return '左键依次点击落点（落在地面），Enter 或双击完成，Backspace 退点，Esc 取消；中键平移、右键旋转、滚轮缩放'
  }
  if (state.arrowTemplate === 'free') {
    return '左键依次点击画出箭头路径，Enter 或双击完成，Backspace 退点，Esc 取消'
  }
  return '左键单击放置模板箭头；可在工具栏设置朝向与线宽，放置后仍可拖动顶点微调'
})

/** 完成当前绘制 */
function finishDraw() {
  if (!viewerRef.current?.finishDrawing()) {
    ElMessage.warning('至少需要 2 个点才能生成标线')
  }
}

/** 取消当前绘制 */
function cancelDraw() {
  viewerRef.current?.cancelDrawing()
}

/** 进入页面就拉取示例数据集索引，填充下拉 */
onMounted(async () => {
  try {
    datasets.value = await store.listSampleDatasets()
  } catch {
    datasets.value = []
  }
})

/** 加载指定示例数据集 */
async function loadDataset(id) {
  if (!id) return
  try {
    await flushDrafts()
    const scene = await store.loadSampleDataset(id)
    ElMessage.success(`已加载「${scene.name}」${scene.frames.length} 帧`)
  } catch (err) {
    ElMessage.error(err.message || String(err))
  }
}

function openFiles() {
  fileInput.value?.click()
}

/** 数据下拉：示例数据集 / 本地文件 */
function onDataCommand(command) {
  if (command === 'local') openFiles()
  else if (String(command).startsWith('sample:')) loadDataset(String(command).slice(7))
}

/** 用户菜单：切换用户 / 退出 */
function onUserCommand(command) {
  if (command === 'switch') openLogin()
  else if (command === 'logout') {
    logout()
    openLogin()
  }
}

/** “更多”菜单：低频操作收进下拉，减少顶部视觉噪音 */
function onMoreCommand(command) {
  switch (command) {
    case 'groundtruth':
      importGroundTruth()
      break
    case 'kitti':
      exportKitti()
      break
    case 'clear':
      clearFrame()
      break
    case 'import-project':
      importProject()
      break
    case 'export-project':
      exportProject()
      break
    case 'reset-review':
      resetAllReview()
      break
    case 'workbench':
      uiState.workbenchOpen = true
      break
    case 'tour':
      uiState.tourOpen = true
      break
    case 'quality':
      uiState.qualityOpen = true
      break
    case 'versions':
      uiState.versionsOpen = true
      break
    case 'tracks':
      uiState.tracksOpen = true
      break
    case 'shortcuts':
      uiState.shortcutsOpen = true
      break
    case 'export-zip':
      exportDatasetZip()
      break
    case 'clear-drafts':
      clearDraftsPrompt()
      break
    default:
      break
  }
}

/** 本地文件选择回调（支持多选，每个文件一帧） */
function onFiles(event) {
  const files = Array.from(event.target.files || [])
  if (files.length) {
    flushDrafts()
      .catch(() => {})
      .finally(() => store.loadLocalFiles(files))
  }
  event.target.value = '' // 允许重复选择同一文件
}

/**
 * 添加标注框：位置取当前轨道控制器焦点，落在地面上；
 * 多帧开关开启时会传播到之后所有帧
 */
function addBox() {
  if (!currentFrame.value) return
  // 绘制中先退出绘制，恢复到之前的框类别，避免新建框带上标线类别
  if (isDrawing.value) setTool('translate')
  // 当前类别是标线时，退回到第一个非标线类别，避免用标线类别建框
  if (MARKING_CLASS_NAMES.includes(activeClass.value?.name)) {
    const boxClass = state.classes.find((c) => !MARKING_CLASS_NAMES.includes(c.name))
    if (boxClass) state.activeClassId = boxClass.id
  }
  const dims = CLASS_DIMS[activeClass.value?.name] || { l: 4, w: 1.8, h: 1.6 }
  const viewer = viewerRef.current
  const target = viewer ? viewer.controls.target : { x: 0, y: 0, z: 0 }
  addObject(
    {
      ...dims,
      x: target.x,
      y: target.y,
      z: -state.sensorHeight + dims.h / 2, // 底面贴地
      ry: 0,
      classId: activeClass.value?.id ?? 0,
    },
    { propagate: state.multiFrame },
  )
  if (state.multiFrame) {
    const frames = state.frames.length - state.currentIndex
    ElMessage.success(`已在此帧及之后 ${frames} 帧添加该物体（此帧之前隐藏）`)
  }
  setTool('translate') // 添加后直接进入移动模式
}


function deleteSelected() {
  requestRemoveObjects(selectedObjects.value)
}

function toggleMeasure() {
  state.measureEnabled = !state.measureEnabled
}

function copySelection() {
  const n = copySelected()
  if (n) ElMessage.success(`已复制 ${n} 个对象`)
  else ElMessage.info('请先选择对象')
}

function pasteSelection({ inPlace = false } = {}) {
  if (!canEditCurrentFrame.value) {
    ElMessage.warning('当前帧已提交/已通过，暂不可编辑')
    return
  }
  const n = pasteObjects({ inPlace })
  if (n) ElMessage.success(`已粘贴 ${n} 个对象`)
  else ElMessage.info('剪贴板为空')
}

/** 导出整个项目标注为 JSON */
function exportProject() {
  const data = store.serializeProject()
  data.review = serializeReview()
  downloadJson(`${state.datasetName || 'annotation'}.json`, data)
  ElMessage.success('标注与批注已导出')
}

/**
 * 保存：把 3D 框 + 点级标签组装成载荷提交后端。
 * 未配置 VITE_SAVE_API 时退化为下载 JSON。
 */
async function save() {
  if (!state.frames.length) return
  const payload = buildSavePayload({ includeLabels: true })
  const info = summarizePayload(payload)
  const filename = `${state.datasetName || 'annotation'}.json`

  if (!isSaveConfigured()) {
    // 纯静态演示：直接导出紧凑 JSON（含所有帧框/标线 + 已编辑的点标签）
    downloadText(filename, JSON.stringify(payload), 'application/json')
    ElMessage.success(
      `已导出：${info.frames} 帧 / ${info.boxes} 框 / ${info.lines} 线 / ${info.arrows} 箭头 / ${info.labeledFrames} 帧点标签 / ${info.comments} 条批注`,
    )
    return
  }
  await withLoading(saving, async () => {
    try {
      const result = await saveToServer(payload)
      const id = result?.id ?? result?.data?.id
      ElMessage.success(
        `保存成功：${info.frames} 帧 / ${info.boxes} 框 / ${info.lines} 线 / ${info.arrows} 箭头 / ${info.labeledFrames} 帧点标签${id ? ` · id=${id}` : ''}`,
      )
    } catch (err) {
      ElMessage.error(err.message || String(err))
    }
  })
}

/** 导入项目标注 JSON */
async function importProject() {
  const [file] = await pickFile('.json,application/json')
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    const matched = store.applyProject(data)
    if (data.review) {
      applyReview(data.review)
    } else {
      const reset = resetFramesAfterImport(matched, '导入标注')
      if (reset) ElMessage.info(`已重置 ${reset} 个已提交/已通过帧的审核状态`)
    }
    // 导入结果覆盖旧数据：清掉旧草稿并写入新的当前状态
    await clearDatasetDrafts()
    store.markAllFramesDirty()
    ElMessage.success(data.review ? '标注与批注已导入' : '标注已导入')
  } catch (err) {
    ElMessage.error(`导入失败: ${err.message}`)
  }
}

/** 导出当前帧为 KITTI 文本（标线无法用 KITTI 表达，会被跳过） */
function exportKitti() {
  const frame = currentFrame.value
  if (!frame) return
  downloadText(`${frame.name.replace(/\.[^.]+$/, '')}.txt`, store.exportCurrentKitti())
  const skipped = store.countNonKittiObjects()
  if (skipped) ElMessage.warning(`KITTI 不支持标线，已跳过 ${skipped} 个标线对象`)
}

/** 重新导入全量真值（覆盖当前所有帧对象） */
async function importGroundTruth() {
  if (!state.groundTruthUrl) return
  try {
    await ElMessageBox.confirm(
      '将覆盖所有帧当前的标注对象；已提交/已通过的帧会重置为未提交。确定重新导入全量真值？',
      '重新导入真值',
      { type: 'warning' },
    )
  } catch {
    return
  }
  try {
    store.cancelScheduledGroundTruth()
    state.gtLoading = true
    const count = await store.importAllGroundTruth()
    const reset = resetFramesAfterImport(
      state.frames.map((_, index) => index),
      '重新导入真值',
    )
    // 重新导入真值会覆盖草稿；清掉旧草稿并把新状态写回，避免下次刷新被旧草稿覆盖
    await clearDatasetDrafts()
    store.markAllFramesDirty()
    ElMessage.success(
      `已重新导入全量真值 ${count.toLocaleString()} 个对象${reset ? `，重置 ${reset} 帧审核状态` : ''}`,
    )
  } catch (err) {
    ElMessage.error(`真值导入失败: ${err.message}`)
  } finally {
    state.gtLoading = false
  }
}

/** 清空当前帧标注（需确认） */
async function clearFrame() {
  try {
    await ElMessageBox.confirm('确定清空当前帧的所有标注？', '提示', { type: 'warning' })
    store.clearObjects()
  } catch {
    /* 用户取消 */
  }
}

/** 清空当前数据集的批注与审核记录（演示重跑用） */
async function resetAllReview() {
  if (!state.frames.length) return
  try {
    await ElMessageBox.confirm(
      '将清空当前数据集的所有批注、审核状态与历史；标注数据不受影响。确定重置？',
      '重置批注与审核',
      { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  resetReview()
  ElMessage.success('批注与审核记录已重置')
}

/** 撤销/重做标注编辑（点标签在分割模式下仍走 viewer.undoLabel） */
function undoEdit() {
  const command = store.undo()
  if (command) ElMessage.info(`已撤销：${command.label}`)
  else ElMessage.info('没有可撤销的标注编辑')
}

function redoEdit() {
  const command = store.redo()
  if (command) ElMessage.info(`已重做：${command.label}`)
  else ElMessage.info('没有可重做的标注编辑')
}

/** 常用视角 */
function setViewPreset(preset) {
  viewerRef.current?.setViewPreset(preset)
}

/** 导出整个数据集为 ZIP：项目 JSON + 逐帧 KITTI + 已编辑点标签 */
function exportDatasetZip() {
  if (!state.frames.length) return
  const dataset = state.datasetName || 'dataset'
  const files = []
  const project = store.serializeProject()
  project.review = serializeReview()
  files.push({ name: 'annotations.json', data: JSON.stringify(project, null, 2) })

  const viewer = viewerRef.current
  let kittiFrames = 0
  let labelFrames = 0
  let skippedMarkings = 0
  for (const frame of state.frames) {
    const base = frame.name.replace(/\.[^.]+$/, '')
    const boxes = frame.objects.filter((o) => o.shape !== 'line' && o.shape !== 'arrow')
    skippedMarkings += frame.objects.length - boxes.length
    if (boxes.length) {
      files.push({ name: `labels/${base}.txt`, data: objectsToKittiText(boxes) })
      kittiFrames++
    }
    if (viewer) {
      const labels = viewer.serializeLabels(viewer.cacheKeyFor(frame))
      if (labels) {
        files.push({
          name: `point_labels/${base}.json`,
          data: JSON.stringify({
            format: 'pointcloud-labels',
            frame: frame.name,
            classes: state.classes,
            ...labels,
          }),
        })
        labelFrames++
      }
    }
  }

  files.push({
    name: 'README.txt',
    data: [
      `dataset: ${dataset}`,
      `exportedAt: ${new Date().toISOString()}`,
      `frames: ${state.frames.length}`,
      `kittiFrames: ${kittiFrames}`,
      `pointLabelFrames: ${labelFrames}`,
      skippedMarkings ? `注意: KITTI 不支持标线，已跳过 ${skippedMarkings} 个标线对象` : '',
      'annotations.json 保留完整框/标线与批注审核记录',
    ]
      .filter(Boolean)
      .join('\n'),
  })

  downloadBlob(`${dataset}-export.zip`, createZip(files))
  ElMessage.success(
    `已导出 ZIP：${kittiFrames} 帧 KITTI / ${labelFrames} 帧点标签${skippedMarkings ? `（跳过 ${skippedMarkings} 个标线）` : ''}`,
  )
}

/** 清除当前数据集的本地草稿 */
async function clearDraftsPrompt() {
  if (!state.datasetName) return
  try {
    await ElMessageBox.confirm(
      '将删除当前数据集保存在浏览器中的自动草稿（不影响当前页面里的标注）。确定？',
      '清除本地草稿',
      { type: 'warning', confirmButtonText: '清除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const count = await clearDatasetDrafts()
  ElMessage.success(count ? `已清除 ${count} 帧本地草稿` : '没有本地草稿')
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-main">
      <span class="brand">
        <el-icon><Aim /></el-icon>
        <span class="brand-text">点云标注</span>
      </span>

      <el-dropdown trigger="click" @command="onDataCommand">
        <el-button>
          <el-icon><Files /></el-icon>
          <span>数据</span>
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="d in datasets" :key="d.id" :command="`sample:${d.id}`">
              {{ d.name }} · {{ d.frames }}帧 / {{ (d.pointsPerFrame / 1000).toFixed(0) }}k点
            </el-dropdown-item>
            <el-dropdown-item v-if="!datasets.length" disabled>
              无可用数据集（请先运行 npm run gen:test-data）
            </el-dropdown-item>
            <el-dropdown-item divided command="local">
              <el-icon><Upload /></el-icon>
              加载本地文件…
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <input ref="fileInput" class="hidden-input" type="file" multiple :accept="ACCEPT" @change="onFiles" />

      <el-radio-group :model-value="state.tool" size="default" :disabled="!canEditCurrentFrame" @change="setTool">
        <el-radio-button v-for="t in TOOLS" :key="t.id" :value="t.id">{{ t.label }}</el-radio-button>
      </el-radio-group>

      <el-button type="primary" :disabled="!state.frames.length || !canEditCurrentFrame" @click="addBox">
        <el-icon><Plus /></el-icon>
        <span>添加框</span>
      </el-button>

      <el-button :disabled="!state.frames.length || !canEditCurrentFrame" @click="uiState.suggestionsOpen = true">
        <el-icon><MagicStick /></el-icon>
        <span>AI 建议</span>
      </el-button>

      <el-button
        :type="state.measureEnabled ? 'primary' : ''"
        :plain="state.measureEnabled"
        :disabled="!state.frames.length"
        @click="toggleMeasure"
      >
        测量
      </el-button>

      <el-button-group class="selection-actions">
        <el-button
          :disabled="!selectedObjects.length"
          title="复制 (Ctrl+C)"
          aria-label="复制"
          @click="copySelection"
        >
          <el-icon><CopyDocument /></el-icon>
        </el-button>
        <el-button
          :disabled="!state.clipboardCount || !canEditCurrentFrame"
          title="粘贴 (Ctrl+V)"
          aria-label="粘贴"
          @click="pasteSelection()"
        >
          <el-icon><DocumentCopy /></el-icon>
        </el-button>
        <el-button
          :disabled="!selectedObjects.length || !canEditCurrentFrame"
          title="删除 (Delete)"
          aria-label="删除"
          @click="deleteSelected"
        >
          <el-icon><Delete /></el-icon>
        </el-button>
      </el-button-group>

      <el-button-group class="history-actions">
        <el-button :disabled="!canUndo" title="撤销 (Ctrl+Z)" aria-label="撤销" @click="undoEdit">
          <el-icon><RefreshLeft /></el-icon>
        </el-button>
        <el-button :disabled="!canRedo" title="重做 (Ctrl+Shift+Z)" aria-label="重做" @click="redoEdit">
          <el-icon><RefreshRight /></el-icon>
        </el-button>
      </el-button-group>

      <el-popover placement="bottom-start" :width="300" trigger="click">
        <template #reference>
          <el-button :type="multiActive ? 'primary' : ''" :plain="multiActive" :disabled="!canEditCurrentFrame">
            <el-icon><Connection /></el-icon>
            <span>多帧</span>
          </el-button>
        </template>
        <div class="popover-panel">
          <div class="popover-toggle">
            <div>
              <div class="popover-title">多帧添加</div>
              <div class="hint">从此帧起，新物体同步到之后所有帧</div>
            </div>
            <el-switch v-model="state.multiFrame" size="small" />
          </div>
          <div class="popover-toggle">
            <div>
              <div class="popover-title">多帧移动</div>
              <div class="hint">移动/旋转/缩放时同步后续帧同一 track</div>
            </div>
            <el-switch v-model="state.multiFrameMove" size="small" />
          </div>
        </div>
      </el-popover>

      <div class="spacer"></div>

      <el-dropdown v-if="authState.user" trigger="click" @command="onUserCommand">
        <el-button :title="`${authState.user.name} · ${roleLabel(authState.user.role)}`">
          <el-icon><User /></el-icon>
          <span>{{ authState.user.name }}</span>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item disabled>
              当前角色：{{ roleLabel(authState.user.role) }}
            </el-dropdown-item>
            <el-dropdown-item divided command="switch">切换用户 / 角色</el-dropdown-item>
            <el-dropdown-item command="logout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button v-else @click="openLogin">
        <el-icon><User /></el-icon>
        <span>登录</span>
      </el-button>

      <el-popover placement="bottom-end" :width="260" trigger="click">
        <template #reference>
          <el-button>
            <el-icon><Setting /></el-icon>
            <span>显示</span>
          </el-button>
        </template>
        <div class="popover-panel">
          <div class="popover-field">
            <span class="popover-label">着色模式</span>
            <el-select v-model="state.colorMode" style="width: 100%">
              <el-option label="强度" value="intensity" />
              <el-option label="高度" value="height" />
              <el-option label="原始颜色" value="source" />
              <el-option label="语义标签" value="label" />
            </el-select>
          </div>
          <div class="popover-field">
            <span class="popover-label">点大小</span>
            <el-slider
              v-model="state.pointSize"
              :min="0.5"
              :max="6"
              :step="0.25"
              :show-tooltip="false"
            />
          </div>
          <div class="popover-field">
            <span class="popover-label">视角</span>
            <el-button-group style="width: 100%">
              <el-button size="small" @click="setViewPreset('top')">俯视</el-button>
              <el-button size="small" @click="setViewPreset('front')">前视</el-button>
              <el-button size="small" @click="setViewPreset('side')">侧视</el-button>
              <el-button size="small" @click="setViewPreset('iso')">等轴</el-button>
            </el-button-group>
          </div>
          <div class="popover-field">
            <el-button size="small" style="width: 100%" @click="uiState.imageOpen = true">
              2D 图像联动
            </el-button>
          </div>
        </div>
      </el-popover>

      <el-dropdown trigger="click" @command="onMoreCommand">
        <el-button title="更多操作" aria-label="更多操作">
          <el-icon><MoreFilled /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              command="groundtruth"
              :disabled="!state.groundTruthUrl || !canEditCurrentFrame"
            >
              重新导入真值
            </el-dropdown-item>
            <el-dropdown-item command="kitti" :disabled="!state.frames.length">
              导出 KITTI
            </el-dropdown-item>
            <el-dropdown-item command="clear" :disabled="!state.frames.length || !canEditCurrentFrame">
              清空本帧
            </el-dropdown-item>
            <el-dropdown-item divided command="import-project" :disabled="!canEditCurrentFrame">
              导入标注
            </el-dropdown-item>
            <el-dropdown-item command="export-project" :disabled="!state.frames.length">
              导出标注（项目 JSON）
            </el-dropdown-item>
            <el-dropdown-item divided command="workbench" :disabled="!state.frames.length">
              审核工作台
            </el-dropdown-item>
            <el-dropdown-item command="quality">质量检查</el-dropdown-item>
            <el-dropdown-item command="versions" :disabled="!state.frames.length">版本快照</el-dropdown-item>
            <el-dropdown-item command="tracks" :disabled="!state.frames.length">轨迹管理与搜索</el-dropdown-item>
            <el-dropdown-item command="export-zip" :disabled="!state.frames.length">
              导出数据集 ZIP（KITTI+点标签）
            </el-dropdown-item>
            <el-dropdown-item command="shortcuts">快捷键说明</el-dropdown-item>
            <el-dropdown-item command="clear-drafts" :disabled="!state.frames.length">
              清除本地草稿
            </el-dropdown-item>
            <el-dropdown-item command="tour">演示引导</el-dropdown-item>
            <el-dropdown-item
              v-if="currentRole === 'admin'"
              command="reset-review"
              :disabled="!state.frames.length"
            >
              重置批注与审核
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-tooltip
        placement="bottom"
        content="导出所有帧的框/标线、已编辑点标签与批注/审核记录为 JSON"
      >
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!state.frames.length"
          title="导出标注与批注"
          aria-label="导出"
          @click="save"
        >
          <el-icon><Download /></el-icon>
        </el-button>
      </el-tooltip>
    </div>

    <!-- 绘制时出现的第二行上下文工具栏，避免主栏频繁跳动 -->
    <div v-if="isDrawing" class="toolbar-context">
      <span class="context-title">
        <el-icon><EditPen /></el-icon>
        {{ drawingLabel }}
      </span>

      <div class="inline">
        <span>线宽</span>
        <el-input-number
          v-model="drawWidth"
          :min="0.02"
          :max="2"
          :step="0.05"
          :controls="false"
          size="small"
          style="width: 72px"
        />
      </div>

      <template v-if="state.tool === 'arrow'">
        <div class="inline">
          <span>模板</span>
          <el-select v-model="state.arrowTemplate" size="small" style="width: 118px">
            <el-option v-for="t in ARROW_TEMPLATES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </div>
        <div v-if="state.arrowTemplate !== 'free'" class="inline">
          <span>朝向</span>
          <el-input-number
            v-model="state.drawHeading"
            :min="-180"
            :max="180"
            :step="15"
            :controls="false"
            size="small"
            style="width: 66px"
          />
          <span>°</span>
        </div>
      </template>

      <el-button-group>
        <el-button size="small" :disabled="!state.draftCount" @click="viewerRef.current?.undoDrawPoint()">
          退点
        </el-button>
        <el-button size="small" type="primary" plain :disabled="!state.draftCount" @click="finishDraw">
          完成
        </el-button>
        <el-button size="small" @click="cancelDraw">取消</el-button>
      </el-button-group>

      <span class="inline">
        <el-switch v-model="state.snapToPoints" size="small" />
        <span>吸附点云</span>
      </span>

      <span class="spacer"></span>
      <el-tooltip placement="bottom-end" :content="drawHint">
        <span class="hint context-help">绘制说明 ⓘ</span>
      </el-tooltip>
    </div>
  </header>
</template>

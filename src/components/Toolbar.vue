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
  selectedObject,
  activeClass,
  addObject,
  setTool,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { ACCEPT } from '../three/loaders/index.js'
import { downloadJson, downloadText, pickFile } from '../utils/io.js'
import { requestRemoveObject } from '../utils/actions.js'
import { buildSavePayload, summarizePayload, saveToServer, isSaveConfigured } from '../utils/save.js'
import { withLoading } from '../utils/http.js'

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
    const scene = await store.loadSampleDataset(id)
    ElMessage.success(`已加载「${scene.name}」${scene.frames.length} 帧`)
  } catch (err) {
    ElMessage.error(err.message || String(err))
  }
}

function openFiles() {
  fileInput.value?.click()
}

/** 本地文件选择回调（支持多选，每个文件一帧） */
function onFiles(event) {
  const files = Array.from(event.target.files || [])
  if (files.length) store.loadLocalFiles(files)
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
  requestRemoveObject(selectedObject.value)
}

/** 导出整个项目标注为 JSON */
function exportProject() {
  downloadJson(`${state.datasetName || 'annotation'}.json`, store.serializeProject())
  ElMessage.success('标注已导出')
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
    downloadJson(filename, payload)
    ElMessage.warning('未配置后端保存接口（VITE_SAVE_API），已改为下载 JSON')
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
    store.applyProject(JSON.parse(await file.text()))
    ElMessage.success('标注已导入')
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

/** 导入示例数据集自带的真值 */
async function importGroundTruth() {
  try {
    const count = await store.importGroundTruth()
    ElMessage.success(`已导入真值 ${count} 个对象`)
  } catch (err) {
    ElMessage.error(`真值导入失败: ${err.message}`)
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
</script>

<template>
  <header class="toolbar">
    <span class="brand">
      <el-icon><Aim /></el-icon>
      点云标注
    </span>

    <el-button-group>
      <el-dropdown trigger="click" @command="loadDataset">
        <el-button>
          <el-icon><Files /></el-icon>
          <span>示例数据</span>
          <el-icon><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="d in datasets" :key="d.id" :command="d.id">
              {{ d.name }} · {{ d.frames }}帧 / {{ (d.pointsPerFrame / 1000).toFixed(0) }}k点
            </el-dropdown-item>
            <el-dropdown-item v-if="!datasets.length" disabled>
              无可用数据集（请先运行 npm run gen:test-data）
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button @click="openFiles">
        <el-icon><Upload /></el-icon>
        <span>加载文件</span>
      </el-button>
    </el-button-group>
    <input ref="fileInput" class="hidden-input" type="file" multiple :accept="ACCEPT" @change="onFiles" />

    <el-divider direction="vertical" />

    <el-radio-group :model-value="state.tool" size="default" @change="setTool">
      <el-radio-button v-for="t in TOOLS" :key="t.id" :value="t.id">{{ t.label }}</el-radio-button>
    </el-radio-group>

    <el-divider direction="vertical" />

    <!-- 标线绘制选项 -->
    <template v-if="isDrawing">
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
      <el-button size="small" :disabled="!state.draftCount" @click="viewerRef.current?.undoDrawPoint()">
        退点
      </el-button>
      <el-button size="small" type="primary" plain :disabled="!state.draftCount" @click="finishDraw">
        完成
      </el-button>
      <el-button size="small" @click="cancelDraw">取消</el-button>
      <el-tooltip placement="bottom" :content="drawHint">
        <span class="hint" style="cursor: help">绘制说明 ⓘ</span>
      </el-tooltip>
      <el-divider direction="vertical" />
    </template>

    <el-button type="primary" :disabled="!state.frames.length" @click="addBox">
      <el-icon><Plus /></el-icon>
      <span>添加框</span>
    </el-button>
    <el-tooltip
      placement="bottom"
      content="开启后，在此帧添加的物体（含标线）会自动添加到之后所有帧；此帧之前不显示"
    >
      <span class="inline">
        <el-switch v-model="state.multiFrame" size="small" />
        <span>多帧添加</span>
      </span>
    </el-tooltip>
    <el-tooltip
      placement="bottom"
      content="开启后，移动/旋转/缩放当前帧的物体时，之后所有帧中同一 track 的物体会同步偏移（保持相对运动）"
    >
      <span class="inline">
        <el-switch v-model="state.multiFrameMove" size="small" />
        <span>多帧移动</span>
      </span>
    </el-tooltip>
    <el-button :disabled="!selectedObject" @click="deleteSelected">删除</el-button>

    <el-divider direction="vertical" />

    <div class="inline">
      <span>着色</span>
      <el-select v-model="state.colorMode" style="width: 110px">
        <el-option label="强度" value="intensity" />
        <el-option label="高度" value="height" />
        <el-option label="原始颜色" value="source" />
        <el-option label="语义标签" value="label" />
      </el-select>
    </div>

    <div class="inline">
      <span>点大小</span>
      <el-slider
        v-model="state.pointSize"
        class="point-size"
        :min="0.5"
        :max="6"
        :step="0.25"
        :show-tooltip="false"
      />
    </div>

    <div class="spacer"></div>

    <el-button-group>
      <el-button :disabled="!state.frames.length" @click="importGroundTruth">导入真值</el-button>
      <el-button :disabled="!state.frames.length" @click="exportKitti">导出 KITTI</el-button>
      <el-button :disabled="!state.frames.length" @click="clearFrame">清空本帧</el-button>
    </el-button-group>

    <el-button-group>
      <el-button @click="importProject">导入标注</el-button>
      <el-button type="primary" plain :disabled="!state.frames.length" @click="exportProject">导出标注</el-button>
    </el-button-group>

    <el-tooltip placement="bottom" content="保存到后端接口（VITE_SAVE_API）；未配置时改为下载 JSON">
      <el-button type="primary" :loading="saving" :disabled="!state.frames.length" @click="save">
        <el-icon><UploadFilled /></el-icon>
        <span>保存</span>
      </el-button>
    </el-tooltip>
  </header>
</template>

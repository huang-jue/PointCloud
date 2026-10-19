<script setup>
/**
 * Toolbar —— 顶部工具栏
 *  - 加载示例数据集（下拉）、加载本地文件
 *  - 工具切换（选择/移动/旋转/缩放）、添加框、多帧添加开关、删除
 *  - 着色模式、点大小
 *  - 导入真值 / 导出 KITTI / 清空本帧 / 导入导出标注
 */
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  state,
  store,
  currentFrame,
  selectedObject,
  activeClass,
  addObject,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { ACCEPT } from '../three/loaders/index.js'
import { downloadJson, downloadText, pickFile } from '../utils/io.js'
import { requestRemoveObject } from '../utils/actions.js'

const fileInput = ref(null)
const datasets = ref([]) // 示例数据集列表（来自 index.json）

/** 新建框时按类别给一个合理的初始尺寸 */
const CLASS_DIMS = {
  Car: { l: 4.2, w: 1.8, h: 1.5 },
  Van: { l: 5.4, w: 2.0, h: 2.2 },
  Pedestrian: { l: 0.6, w: 0.6, h: 1.7 },
  Cyclist: { l: 1.7, w: 0.7, h: 1.7 },
  Pole: { l: 0.2, w: 0.2, h: 4.0 },
}

/** 编辑工具（select 为不显示手柄的纯选择模式） */
const TOOLS = [
  { id: 'select', label: '选择' },
  { id: 'translate', label: '移动' },
  { id: 'rotate', label: '旋转' },
  { id: 'scale', label: '缩放' },
]

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
  state.tool = 'translate' // 添加后直接进入移动模式
}

function deleteSelected() {
  requestRemoveObject(selectedObject.value)
}

/** 导出整个项目标注为 JSON */
function exportProject() {
  downloadJson(`${state.datasetName || 'annotation'}.json`, store.serializeProject())
  ElMessage.success('标注已导出')
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

/** 导出当前帧为 KITTI 文本 */
function exportKitti() {
  const frame = currentFrame.value
  if (!frame) return
  downloadText(`${frame.name.replace(/\.[^.]+$/, '')}.txt`, store.exportCurrentKitti())
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

    <el-radio-group v-model="state.tool" size="default">
      <el-radio-button v-for="t in TOOLS" :key="t.id" :value="t.id">{{ t.label }}</el-radio-button>
    </el-radio-group>

    <el-divider direction="vertical" />

    <el-button type="primary" :disabled="!state.frames.length" @click="addBox">
      <el-icon><Plus /></el-icon>
      <span>添加框</span>
    </el-button>
    <el-tooltip placement="bottom" content="开启后，在此帧添加的物体会自动添加到之后所有帧；此帧之前不显示">
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
  </header>
</template>

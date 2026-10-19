<script setup>
/**
 * SegmentPanel —— 点级语义分割面板
 *  - 选择工具（矩形/画笔/套索）后，左键拖拽涂抹/框选，**松开即自动生成**当前类别的标签
 *  - 单击已标注的点可选中该标签片段，并进行「改类别 / 删除」编辑
 *  - 支持撤销、清空、导出
 */
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state, classById } from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { downloadJson } from '../utils/io.js'

const stats = ref([]) // [{ id, name, color, count }]

const SEG_MODES = [
  { id: 'rect', label: '矩形' },
  { id: 'brush', label: '画笔' },
  { id: 'lasso', label: '套索' },
]

/** 从视口刷新各类别已标注点数统计 */
function refreshStats() {
  const viewer = viewerRef.current
  if (!viewer) {
    stats.value = []
    return
  }
  const map = viewer.labelStats()
  stats.value = Array.from(map.entries())
    .map(([id, count]) => ({
      id,
      count,
      name: classById(id)?.name || `#${id}`,
      color: classById(id)?.color || '#8899aa',
    }))
    .sort((a, b) => b.count - a.count)
}

function clearSelection() {
  viewerRef.current?.clearSelection()
}

/** 撤销上一步标签操作 */
function undo() {
  if (viewerRef.current?.undoLabel()) {
    syncAll()
    ElMessage.info('已撤销上一步标签')
  } else {
    ElMessage.warning('没有可撤销的标签操作')
  }
}

function clearLabels() {
  viewerRef.current?.clearLabels()
  syncAll()
}

/** 修改当前选中标签片段的类别 */
function changeSegmentClass(classId) {
  const n = viewerRef.current?.setSelectedSegmentClass(classId)
  if (n) {
    state.selectedSegment = viewerRef.current.getSelectedSegment()
    refreshStats()
  }
}

/** 删除当前选中的标签片段 */
function deleteSegment() {
  const n = viewerRef.current?.deleteSelectedSegment()
  if (n) {
    state.selectedSegment = null
    refreshStats()
    ElMessage.success(`已删除该标签（${n} 点）`)
  }
}

function deselectSegment() {
  viewerRef.current?.clearSegmentSelection()
}

/** 导出当前帧点标签为 JSON */
function exportLabels() {
  const viewer = viewerRef.current
  const data = viewer?.exportCurrentLabels()
  if (!data) return
  const frame = viewer.currentCloud?.key || 'frame'
  downloadJson(`labels_${String(frame).replace(/[^\w.-]+/g, '_')}.json`, {
    format: 'pointcloud-labels',
    frame,
    classes: state.classes,
    ...data,
  })
}

function syncAll() {
  refreshStats()
}

// 切帧 / 换数据集后延迟刷新统计（等点云加载完成）
watch(
  () => state.currentIndex,
  () => setTimeout(refreshStats, 400),
)

watch(
  () => [state.datasetName, state.frames.length],
  () => setTimeout(refreshStats, 400),
)

// 视口内标签发生变化（自动赋标签、撤销等）时刷新统计
watch(
  () => state.labelVersion,
  () => refreshStats(),
)

const hasLabels = computed(() => stats.value.length > 0)
const lastLabelName = computed(() => classById(state.lastLabel?.classId)?.name || '')
</script>

<template>
  <div class="section">
    <h3 class="section-title">
      <span>点级语义分割</span>
      <el-switch v-model="state.segEnabled" size="small" />
    </h3>

    <!-- 选中标签的编辑区：不依赖分割开关，只要选中了标签就能改/删 -->
    <div v-if="state.selectedSegment" class="segment-edit">
      <div class="field" style="margin-bottom: 8px">
        <label>编辑选中的标签（{{ state.selectedSegment.count }} 点）</label>
        <el-select
          :model-value="state.selectedSegment.classId"
          size="small"
          style="width: 100%"
          @change="changeSegmentClass"
        >
          <el-option v-for="c in state.classes" :key="c.id" :label="c.name" :value="c.id">
            <span class="obj-dot" :style="{ background: c.color, marginRight: '6px' }"></span>{{ c.name }}
          </el-option>
        </el-select>
      </div>
      <div class="row">
        <el-button size="small" type="danger" @click="deleteSegment">删除该标签</el-button>
        <el-button size="small" @click="deselectSegment">取消选中</el-button>
      </div>
    </div>

    <template v-if="state.segEnabled">
      <el-radio-group v-model="state.segMode" size="small" style="margin-bottom: 8px">
        <el-radio-button v-for="m in SEG_MODES" :key="m.id" :value="m.id">{{ m.label }}</el-radio-button>
      </el-radio-group>

      <div v-if="state.segMode === 'brush'" class="field" style="margin-bottom: 8px">
        <label>画笔半径 {{ state.brushSize }}px</label>
        <el-slider v-model="state.brushSize" :min="6" :max="120" :step="2" :show-tooltip="false" />
      </div>

      <div class="row" style="margin-bottom: 8px">
        <el-switch v-model="state.segOverwrite" size="small" />
        <span class="hint">覆盖已有标签</span>
        <el-tooltip
          content="开启：新画的标签覆盖已标注的点；关闭：只标注未标注区域，已有标签保持不变"
          placement="top"
        >
          <span class="hint" style="cursor: help">ⓘ</span>
        </el-tooltip>
      </div>

      <div class="hint" style="margin-bottom: 8px">
        左键拖拽涂抹/框选，<b>松开即自动生成</b>
        <b :style="{ color: classById(state.activeClassId)?.color }">{{ classById(state.activeClassId)?.name }}</b>
        标签；<b>单击已标注的点</b>可选中该标签进行编辑。中键平移、右键旋转、滚轮缩放。
      </div>

      <div v-if="state.lastLabel" class="hint" style="margin-bottom: 8px">
        本次已标注 <b style="color: var(--accent)">{{ state.lastLabel.count }}</b> 点 →
        <b :style="{ color: classById(state.lastLabel.classId)?.color }">{{ lastLabelName }}</b>
      </div>

      <div class="row" style="margin-top: 8px">
        <el-button size="small" @click="undo">撤销</el-button>
        <el-button size="small" :disabled="!state.selectionCount" @click="clearSelection">清除当前选择</el-button>
      </div>
      <div class="row">
        <el-button size="small" :disabled="!hasLabels" @click="clearLabels">清空标签</el-button>
        <el-button size="small" :disabled="!state.frames.length" @click="exportLabels">导出标签</el-button>
      </div>

      <div v-if="hasLabels" style="margin-top: 10px">
        <div v-for="s in stats" :key="s.id" class="obj-item" style="cursor: default; padding: 3px 6px; margin: 2px 0">
          <span class="obj-dot" :style="{ background: s.color }"></span>
          <div class="obj-main"><div class="obj-name">{{ s.name }}</div></div>
          <span class="hint">{{ s.count.toLocaleString() }} 点</span>
        </div>
      </div>
    </template>
    <div v-else class="hint">
      开启后可用矩形/画笔/套索给点云打语义标签，松开鼠标即生成；单击已标注的点可选中编辑。
    </div>
  </div>
</template>

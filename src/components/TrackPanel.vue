<script setup>
/**
 * TrackPanel —— 轨迹管理与跨帧对象搜索
 *  - 轨迹列表：帧范围、实例数、类型、来源
 *  - 跳转/同步/拆分/合并/删除整条轨迹
 *  - 对象搜索：按关键字/类别/来源跨帧定位
 */
import { computed, nextTick, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  state,
  store,
  listTracks,
  searchObjects,
  selectObject,
  syncTrackForward,
  mergeTracks,
  splitTrack,
  removeTrack,
} from '../stores/useAnnotationStore.js'
import { viewerRef } from '../three/viewerRef.js'
import { uiState } from '../stores/useUiStore.js'
import { canEditCurrentFrame } from '../stores/useReviewStore.js'

const tab = ref('tracks')
const keyword = ref('')
const classFilter = ref(null)
const sourceFilter = ref('')
const onlyMulti = ref(false)
const mergeSource = ref(null)
const mergeTarget = ref(null)

const open = computed({
  get: () => uiState.tracksOpen,
  set: (value) => {
    uiState.tracksOpen = value
  },
})

const tracks = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return listTracks().filter((track) => {
    if (onlyMulti.value && !track.multiFrame) return false
    if (classFilter.value !== null && classFilter.value !== undefined && track.classId !== classFilter.value) {
      return false
    }
    if (text && !`${track.trackId} ${track.type}`.toLowerCase().includes(text)) return false
    return true
  })
})

const mergeTargets = computed(() =>
  listTracks().filter((track) => track.trackId !== mergeSource.value),
)

const searchResults = computed(() =>
  searchObjects({
    keyword: keyword.value,
    classId: classFilter.value,
    source: sourceFilter.value,
    limit: 300,
  }),
)

const sourceOptions = [
  { value: '', label: '全部来源' },
  { value: 'manual', label: '手工' },
  { value: 'copy', label: '复制' },
  { value: 'import', label: '导入/真值' },
  { value: 'ai', label: 'AI' },
  { value: 'interp', label: '插值' },
]

function currentInstance(track) {
  return track.instances.find((item) => item.frameIndex === state.currentIndex) || null
}

function focusInstance(frameIndex, objectId) {
  const frame = state.frames[frameIndex]
  if (!frame) return
  store.setCurrentIndex(frameIndex)
  nextTick(() => {
    selectObject(objectId)
    const obj = frame.objects.find((item) => item.id === objectId)
    if (obj) viewerRef.current?.focusObject(obj)
  })
}

function locate(track) {
  const instance =
    track.instances.find((item) => item.frameIndex === state.currentIndex) ||
    track.instances[0]
  if (instance) focusInstance(instance.frameIndex, instance.id)
}

function syncFromCurrent(track) {
  const instance = currentInstance(track)
  if (!instance) {
    ElMessage.info('当前帧没有该轨迹的对象，请先定位到轨迹所在帧')
    return
  }
  const count = syncTrackForward(instance.id)
  if (count) ElMessage.success(`已把当前位姿同步到之后 ${count} 个实例`)
  else ElMessage.info('之后没有该轨迹的实例')
}

async function removeTrackPrompt(track) {
  if (!canEditCurrentFrame.value) {
    ElMessage.warning('当前帧已提交/已通过，暂不可编辑')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将删除轨迹 T${track.trackId} 在所有未锁定帧中的 ${track.frameCount} 个实例，确定？`,
      '删除轨迹',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const result = removeTrack(track.trackId, { fromFrame: 0 })
  ElMessage.success(
    `已删除 ${result.removed} 个实例${result.skipped ? `，跳过 ${result.skipped} 个锁定帧` : ''}`,
  )
}

async function splitPrompt(track) {
  try {
    await ElMessageBox.confirm(
      `从第 ${state.currentIndex + 1} 帧起把轨迹 T${track.trackId} 拆分为新轨迹？`,
      '拆分轨迹',
      { type: 'info', confirmButtonText: '拆分', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const result = splitTrack(track.trackId, state.currentIndex)
  if (result.split) ElMessage.success(`已拆分为 T${result.newTrackId}（${result.split} 个实例）`)
  else ElMessage.info('当前帧及之后没有该轨迹的实例')
}

async function mergePrompt() {
  if (!mergeSource.value || !mergeTarget.value) {
    ElMessage.info('请选择源轨迹和目标轨迹')
    return
  }
  try {
    await ElMessageBox.confirm(
      `把轨迹 T${mergeSource.value} 合并到 T${mergeTarget.value}？同一帧中已存在目标对象时保留目标对象。`,
      '合并轨迹',
      { type: 'warning', confirmButtonText: '合并', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const result = mergeTracks(mergeSource.value, mergeTarget.value)
  ElMessage.success(
    `已合并 ${result.merged} 个实例${result.removed ? `，去除冲突 ${result.removed} 个` : ''}${
      result.skipped ? `，跳过 ${result.skipped} 个锁定帧` : ''
    }`,
  )
  mergeSource.value = null
  mergeTarget.value = null
}

function locateSearch(result) {
  focusInstance(result.frameIndex, result.object.id)
}

function dims(obj) {
  if (obj.shape === 'line') return `${obj.points?.length || 0} 点`
  if (obj.shape === 'arrow') return `${(obj.paths || []).length} 路径`
  return `${Number(obj.l || 0).toFixed(1)}×${Number(obj.w || 0).toFixed(1)}×${Number(obj.h || 0).toFixed(1)}`
}
</script>

<template>
  <el-dialog v-model="open" title="轨迹管理与对象搜索" width="980px" top="6vh" append-to-body>
    <el-tabs v-model="tab">
      <el-tab-pane label="轨迹管理" name="tracks">
        <div class="track-toolbar">
          <el-input v-model="keyword" size="small" placeholder="搜索轨迹/类型" clearable style="width: 160px" />
          <el-select v-model="classFilter" size="small" placeholder="全部类别" clearable style="width: 130px">
            <el-option v-for="c in state.classes" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
          <el-checkbox v-model="onlyMulti" size="small">只看多帧轨迹</el-checkbox>
          <span class="spacer"></span>
          <span class="hint">{{ tracks.length }} 条轨迹</span>
        </div>

        <div class="track-table-wrap">
          <table class="track-table">
            <thead>
              <tr>
                <th>轨迹</th>
                <th>类型</th>
                <th>帧范围</th>
                <th>实例</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="track in tracks" :key="track.trackId">
                <td class="mono">T{{ track.trackId }}</td>
                <td>
                  <span
                    class="track-dot"
                    :style="{ background: state.classes.find((c) => c.id === track.classId)?.color || '#8899aa' }"
                  ></span>
                  {{ track.type }}
                </td>
                <td class="mono">{{ track.first + 1 }} ~ {{ track.last + 1 }}</td>
                <td class="mono">{{ track.frameCount }}</td>
                <td class="hint">{{ track.source || '-' }}</td>
                <td>
                  <div class="track-actions">
                    <el-button link size="small" @click="locate(track)">定位</el-button>
                    <el-button link size="small" :disabled="!currentInstance(track)" @click="syncFromCurrent(track)">
                      同步位姿
                    </el-button>
                    <el-button link size="small" @click="splitPrompt(track)">拆分</el-button>
                    <el-button link type="danger" size="small" @click="removeTrackPrompt(track)">删除</el-button>
                  </div>
                </td>
              </tr>
              <tr v-if="!tracks.length">
                <td colspan="6" class="empty">没有符合条件的轨迹</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="merge-bar">
          <span class="hint">合并轨迹：</span>
          <el-select v-model="mergeSource" size="small" placeholder="源轨迹" clearable style="width: 130px">
            <el-option v-for="t in tracks" :key="t.trackId" :label="`T${t.trackId} · ${t.type}`" :value="t.trackId" />
          </el-select>
          <span class="hint">→</span>
          <el-select v-model="mergeTarget" size="small" placeholder="目标轨迹" clearable style="width: 130px">
            <el-option v-for="t in mergeTargets" :key="t.trackId" :label="`T${t.trackId} · ${t.type}`" :value="t.trackId" />
          </el-select>
          <el-button size="small" type="primary" plain :disabled="!mergeSource || !mergeTarget" @click="mergePrompt">
            合并
          </el-button>
          <span class="spacer"></span>
          <span class="hint">拆分/删除会跳过已提交/已通过的帧</span>
        </div>
      </el-tab-pane>

      <el-tab-pane label="对象搜索" name="search">
        <div class="track-toolbar">
          <el-input
            v-model="keyword"
            size="small"
            placeholder="类型 / trackId / id"
            clearable
            style="width: 200px"
          />
          <el-select v-model="classFilter" size="small" placeholder="全部类别" clearable style="width: 130px">
            <el-option v-for="c in state.classes" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
          <el-select v-model="sourceFilter" size="small" style="width: 130px">
            <el-option v-for="opt in sourceOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <span class="spacer"></span>
          <span class="hint">
            显示 {{ searchResults.length }} 条<template v-if="searchResults.length >= 300">（最多 300 条）</template>
          </span>
        </div>

        <div class="track-table-wrap">
          <table class="track-table">
            <thead>
              <tr>
                <th>帧</th>
                <th>类型</th>
                <th>轨迹</th>
                <th>尺寸/形状</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="result in searchResults" :key="`${result.frameIndex}-${result.object.id}`">
                <td class="mono">{{ result.frameIndex + 1 }}</td>
                <td>{{ result.object.type }}</td>
                <td class="mono">{{ result.object.trackId ? `T${result.object.trackId}` : '-' }}</td>
                <td class="mono">{{ dims(result.object) }}</td>
                <td class="hint">{{ result.object.source || '-' }}</td>
                <td>
                  <el-button link size="small" @click="locateSearch(result)">定位</el-button>
                </td>
              </tr>
              <tr v-if="!searchResults.length">
                <td colspan="6" class="empty">没有匹配的对象</td>
              </tr>
            </tbody>
          </table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<style scoped>
.track-toolbar,
.merge-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.merge-bar {
  margin-top: 10px;
  margin-bottom: 0;
}

.spacer {
  flex: 1;
}

.track-table-wrap {
  max-height: 52vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.track-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.track-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-3);
  color: var(--text-dim);
  font-weight: 600;
  text-align: left;
  padding: 7px 8px;
  white-space: nowrap;
}

.track-table td {
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  color: var(--text);
  white-space: nowrap;
}

.track-table tbody tr:hover {
  background: var(--bg-2);
}

.track-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.track-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 50%;
}

.empty {
  padding: 24px 0 !important;
  text-align: center;
  color: var(--text-dim);
}
</style>

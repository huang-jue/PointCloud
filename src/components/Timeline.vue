<script setup>
/**
 * Timeline —— 底部时间轴
 * 首/上一帧/播放暂停/下一帧/尾帧、帧滑块、帧缩略刻度（含标注的帧高亮）、播放 fps
 * 播放状态放在 store.state.playing，便于空格键等全局控制
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { state, currentFrame, store } from '../stores/useAnnotationStore.js'
import { commentCountForFrame, frameStatus, statusLabelOf } from '../stores/useReviewStore.js'

const fps = ref(8)
let timer = null

const maxIndex = computed(() => Math.max(0, state.frames.length - 1))
// 帧数过多时不渲染刻度条，避免 DOM 过重
const showTicks = computed(() => state.frames.length > 0 && state.frames.length <= 120)

/** 每个刻度的审核状态与批注数（一次性算好，避免模板里反复过滤） */
const tickMeta = computed(() =>
  state.frames.map((frame, index) => {
    const status = frameStatus(index)
    const comments = commentCountForFrame(index)
    return {
      status,
      comments,
      title: `${frame.name} · ${statusLabelOf(status)}${comments ? ` · ${comments} 条批注` : ''}`,
    }
  }),
)

function setIndex(value) {
  store.setCurrentIndex(Number(value))
}

function togglePlay() {
  state.playing = !state.playing
}

/** 启动循环播放（到末帧回到首帧） */
function start() {
  if (!state.frames.length) {
    state.playing = false
    return
  }
  timer = setInterval(() => {
    // 当前帧尚未加载完时先不推进，避免连续取消请求造成闪烁
    if (state.loading) return
    const next = state.currentIndex + 1
    store.setCurrentIndex(next >= state.frames.length ? 0 : next)
  }, Math.max(50, 1000 / fps.value))
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

// 统一由 playing 状态驱动定时器（工具栏空格键也改这个状态）
watch(
  () => state.playing,
  (on) => {
    stop()
    if (on) start()
  },
)

// fps 变化时重启定时器
watch(fps, () => {
  if (state.playing) {
    stop()
    start()
  }
})

onBeforeUnmount(() => {
  stop()
  state.playing = false
})
</script>

<template>
  <footer class="timeline">
    <el-button-group>
      <el-button :disabled="!state.frames.length" @click="setIndex(0)">
        <el-icon><DArrowLeft /></el-icon>
      </el-button>
      <el-button :disabled="!state.frames.length" @click="setIndex(Math.max(0, state.currentIndex - 1))">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <el-button :disabled="!state.frames.length" @click="togglePlay">
        <el-icon><component :is="state.playing ? 'VideoPause' : 'VideoPlay'" /></el-icon>
      </el-button>
      <el-button
        :disabled="!state.frames.length"
        @click="setIndex(Math.min(maxIndex, state.currentIndex + 1))"
      >
        <el-icon><ArrowRight /></el-icon>
      </el-button>
      <el-button :disabled="!state.frames.length" @click="setIndex(maxIndex)">
        <el-icon><DArrowRight /></el-icon>
      </el-button>
    </el-button-group>

    <div class="track">
      <el-slider
        class="slider"
        :min="0"
        :max="maxIndex"
        :model-value="state.currentIndex"
        :disabled="!state.frames.length"
        :show-tooltip="false"
        @input="setIndex"
      />
      <div class="readout">
        <template v-if="currentFrame">
          帧 {{ state.currentIndex + 1 }} / {{ state.frames.length }} · {{ currentFrame.timestamp?.toFixed?.(1) }}s
        </template>
        <template v-else>无数据</template>
      </div>
    </div>

    <div v-if="showTicks" class="ticks">
      <div
        v-for="(frame, i) in state.frames"
        :key="i"
        class="tick"
        :class="[
          `status-${tickMeta[i].status}`,
          {
            current: i === state.currentIndex,
            'has-objects': frame.objects.length,
            'has-comments': tickMeta[i].comments > 0,
          },
        ]"
        :title="tickMeta[i].title"
        @click="setIndex(i)"
      ></div>
    </div>

    <div class="inline" style="display: flex; align-items: center; gap: 6px">
      <span>fps</span>
      <el-input-number v-model="fps" :min="1" :max="60" :controls="false" size="small" style="width: 58px" />
    </div>
  </footer>
</template>

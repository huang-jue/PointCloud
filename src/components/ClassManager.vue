<script setup>
/**
 * ClassManager —— 类别管理面板
 *  - 「选择」单选：决定当前激活类别（新建框、点级赋标签都使用它）
 *  - 可改名字/颜色、删除、新增
 */
import { ref, computed } from 'vue'
import { state, addClass, updateClass, removeClass, classById } from '../stores/useAnnotationStore.js'

const newName = ref('')

/** 颜色选择器的推荐色板 */
const PREDEFINE = [
  '#4f9bff', '#57d9a3', '#ff6b6b', '#ffd166', '#9aa5b1',
  '#b07cff', '#ff8f3f', '#3fd0d4', '#f76fbf', '#a3d959',
]

/** 当前激活类别名（用于底部提示） */
const activeName = computed(() => classById(state.activeClassId)?.name || '—')

/** 选中某个类别为当前类别 */
function selectClass(id) {
  state.activeClassId = id
}

/** 新增类别（名称留空则由 store 自动命名） */
function add() {
  addClass(newName.value.trim() || undefined)
  newName.value = ''
}
</script>

<template>
  <div class="section">
    <h3 class="section-title">
      <span>类别</span>
      <span class="hint">单选决定当前类别</span>
    </h3>

    <div
      v-for="c in state.classes"
      :key="c.id"
      class="class-row"
      :class="{ active: c.id === state.activeClassId }"
      @click="selectClass(c.id)"
    >
      <!-- 选择：绑定激活类别 id -->
      <el-radio
        :value="c.id"
        v-model="state.activeClassId"
        class="class-radio"
        @click.stop
      ><span></span></el-radio>
      <el-color-picker
        v-model="c.color"
        size="small"
        :predefine="PREDEFINE"
        @click.stop
        @change="(v) => updateClass(c.id, { color: v })"
      />
      <el-input
        :model-value="c.name"
        size="small"
        @click.stop
        @input="(v) => updateClass(c.id, { name: v })"
      />
      <el-button link type="danger" @click.stop="removeClass(c.id)">
        <el-icon><Delete /></el-icon>
      </el-button>
    </div>

    <div class="row" style="margin-top: 10px">
      <el-input v-model="newName" size="small" placeholder="新类别名称" @keyup.enter="add" />
      <el-button size="small" @click="add">添加</el-button>
    </div>

    <div class="row" style="margin-top: 8px">
      <span class="hint">当前类别：</span>
      <span class="obj-dot" :style="{ background: classById(state.activeClassId)?.color }"></span>
      <span class="hint"><b style="color: var(--text)">{{ activeName }}</b></span>
    </div>
  </div>
</template>

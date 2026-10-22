<script setup>
/** 快捷键帮助弹窗 */
import { computed } from 'vue'
import { uiState } from '../stores/useUiStore.js'

const open = computed({
  get: () => uiState.shortcutsOpen,
  set: (value) => {
    uiState.shortcutsOpen = value
  },
})

const groups = [
  {
    title: '浏览与视图',
    items: [
      ['← / →', '上一帧 / 下一帧'],
      ['空格', '播放 / 暂停'],
      ['F', '适应视角'],
      ['Q / W / E / R', '选择 / 移动 / 旋转 / 缩放'],
      ['左键拖拽', '平移视图'],
      ['右键拖拽', '旋转视图'],
      ['滚轮', '缩放'],
    ],
  },
  {
    title: '标注编辑',
    items: [
      ['L', '画线'],
      ['A', '画箭头'],
      ['Enter', '绘制中：完成'],
      ['Backspace', '绘制中：退点'],
      ['Esc', '绘制中：取消 / 清空选择'],
      ['Delete', '删除选中对象'],
      ['Ctrl+C / Ctrl+V', '复制 / 偏移粘贴'],
      ['Ctrl+Shift+V', '原地粘贴'],
      ['Ctrl+D', '原地复制'],
      ['Ctrl+A', '全选当前帧对象'],
      ['Ctrl+Z', '撤销（标注编辑 / 当前模式下的点标签）'],
      ['Ctrl+Shift+Z / Ctrl+Y', '重做标注编辑'],
    ],
  },
  {
    title: '点级分割',
    items: [
      ['B', '开启 / 关闭分割模式'],
      ['左键拖拽', '矩形 / 画笔 / 套索标注'],
      ['单击已标注点', '选中标签片段'],
      ['拖拽黄色顶点', '移动标线顶点'],
      ['Alt+点击顶点', '删除顶点'],
      ['Ctrl+Z', '撤销上一步点标签'],
    ],
  },
]
</script>

<template>
  <el-dialog v-model="open" title="快捷键与操作说明" width="720px" append-to-body>
    <div class="shortcut-groups">
      <section v-for="group in groups" :key="group.title" class="shortcut-group">
        <h4>{{ group.title }}</h4>
        <div v-for="[keys, label] in group.items" :key="keys" class="shortcut-row">
          <kbd>{{ keys }}</kbd>
          <span>{{ label }}</span>
        </div>
      </section>
    </div>
    <template #footer>
      <span class="hint">提示：输入框获得焦点时不会触发单键快捷键。</span>
      <el-button size="small" @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.shortcut-groups {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}

.shortcut-group h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text);
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border);
  font-size: 12px;
  color: var(--text-dim);
}

.shortcut-row:last-child {
  border-bottom: none;
}

kbd {
  flex: none;
  min-width: 116px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-3);
  color: var(--text);
  font-family: var(--mono, monospace);
  font-size: 11px;
}
</style>

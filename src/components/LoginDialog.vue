<script setup>
/** 登录/切换角色弹窗（纯前端演示账号） */
import { ElMessage } from 'element-plus'
import { ROLES, authState, login } from '../stores/useAuthStore.js'

function submit() {
  try {
    login(authState.loginName, authState.loginRole)
    ElMessage.success(`已登录：${authState.user.name} · ${ROLES.find((r) => r.id === authState.user.role)?.label}`)
  } catch (err) {
    ElMessage.error(err.message || String(err))
  }
}
</script>

<template>
  <el-dialog
    v-model="authState.loginOpen"
    title="登录演示账号"
    width="440px"
    :close-on-click-modal="false"
  >
    <div class="field" style="margin-bottom: 14px">
      <label>用户名</label>
      <el-input
        v-model="authState.loginName"
        placeholder="输入用户名"
        maxlength="24"
        @keyup.enter="submit"
      />
    </div>

    <div class="field">
      <label>角色</label>
      <el-radio-group v-model="authState.loginRole" class="role-options">
        <el-radio v-for="role in ROLES" :key="role.id" :value="role.id" class="role-option">
          <div class="role-main">
            <div class="role-title">
              {{ role.label }}
              <el-tag size="small" :type="role.tagType" effect="plain">{{ role.id }}</el-tag>
            </div>
            <div class="hint">{{ role.description }}</div>
          </div>
        </el-radio>
      </el-radio-group>
    </div>

    <template #footer>
      <el-button @click="authState.loginOpen = false">只读浏览</el-button>
      <el-button type="primary" @click="submit">登录</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.role-options {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.role-option {
  height: auto;
  margin-right: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-2);
}

.role-option.is-checked {
  border-color: var(--accent);
}

.role-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.role-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 600;
}
</style>

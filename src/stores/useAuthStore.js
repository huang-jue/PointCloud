/**
 * useAuthStore —— 演示用登录与角色权限
 *
 * 纯前端演示没有真实后端账号体系，这里用 sessionStorage 保存当前用户，
 * 让同一个浏览器的两个标签页可以分别扮演标注员和批注员（审核数据仍在 localStorage 共享）：
 *   annotator 标注员：只能标注（框/标线/点级标签）
 *   reviewer  批注员：只能查看与添加批注、提交打回
 *   admin     管理员：标注 + 批注 + 审核
 */
import { reactive, computed } from 'vue'

const USER_KEY = 'pc-annotate-user'

export const ROLES = [
  {
    id: 'annotator',
    label: '标注员',
    description: '只能添加/编辑标注，可提交/撤销本帧审核',
    tagType: 'primary',
  },
  {
    id: 'reviewer',
    label: '批注员',
    description: '只读标注，可添加批注并通过/打回待审核帧',
    tagType: 'warning',
  },
  {
    id: 'admin',
    label: '管理员',
    description: '可标注、添加批注并审核',
    tagType: 'danger',
  },
]

export function roleLabel(role) {
  return ROLES.find((r) => r.id === role)?.label || '未登录'
}

export function roleTagType(role) {
  return ROLES.find((r) => r.id === role)?.tagType || 'info'
}

function parseUser(raw) {
  if (!raw) return null
  try {
    const user = JSON.parse(raw)
    if (!user || !user.name || !ROLES.some((r) => r.id === user.role)) return null
    return { name: String(user.name), role: user.role }
  } catch {
    return null
  }
}

function loadUser() {
  try {
    const current = parseUser(sessionStorage.getItem(USER_KEY))
    if (current) return current
  } catch {
    /* sessionStorage 不可用时继续尝试旧数据 */
  }
  try {
    // 兼容旧版本：把 localStorage 里的演示身份迁移到当前标签页
    const legacyRaw = localStorage.getItem(USER_KEY)
    if (!legacyRaw) return null
    localStorage.removeItem(USER_KEY)
    const legacy = parseUser(legacyRaw)
    if (!legacy) return null
    try {
      sessionStorage.setItem(USER_KEY, JSON.stringify(legacy))
    } catch {
      /* 忽略 */
    }
    return legacy
  } catch {
    return null
  }
}

export const authState = reactive({
  user: loadUser(),
  loginOpen: false,
  loginName: '',
  loginRole: 'annotator',
})

export const currentUser = computed(() => authState.user)
export const currentRole = computed(() => authState.user?.role || '')
export const isLoggedIn = computed(() => !!authState.user)
export const canAnnotate = computed(
  () => currentRole.value === 'annotator' || currentRole.value === 'admin',
)
export const canComment = computed(
  () => currentRole.value === 'reviewer' || currentRole.value === 'admin',
)
export const canReview = canComment

/** 打开登录/切换用户弹窗 */
export function openLogin() {
  authState.loginName = authState.user?.name || '演示用户'
  authState.loginRole = authState.user?.role || 'annotator'
  authState.loginOpen = true
}

export function closeLogin() {
  authState.loginOpen = false
}

/** 登录并持久化 */
export function login(name, role) {
  const cleanName = String(name || '').trim() || '演示用户'
  if (!ROLES.some((r) => r.id === role)) throw new Error('无效的用户角色')
  authState.user = { name: cleanName, role }
  authState.loginOpen = false
  try {
    sessionStorage.setItem(USER_KEY, JSON.stringify(authState.user))
  } catch {
    /* 隐私模式下忽略 */
  }
  try {
    // 清理旧版本遗留的全局身份，避免新标签页继承上一个角色
    localStorage.removeItem(USER_KEY)
  } catch {
    /* 忽略 */
  }
  return authState.user
}

/** 退出登录 */
export function logout() {
  authState.user = null
  try {
    sessionStorage.removeItem(USER_KEY)
  } catch {
    /* 忽略 */
  }
  try {
    localStorage.removeItem(USER_KEY)
  } catch {
    /* 忽略 */
  }
}

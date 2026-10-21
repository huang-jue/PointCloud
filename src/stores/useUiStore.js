/** 全局弹窗/面板开关（不持久化） */
import { reactive } from 'vue'

export const uiState = reactive({
  workbenchOpen: false,
  tourOpen: false,
  versionsOpen: false,
  suggestionsOpen: false,
  qualityOpen: false,
  imageOpen: false,
})

export function openUi(name) {
  if (name in uiState) uiState[name] = true
}

export function closeUi(name) {
  if (name in uiState) uiState[name] = false
}

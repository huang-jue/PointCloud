/** 浏览器端文件下载与选择工具 */

/** 触发浏览器下载一个 Blob */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 延迟释放，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(filename, text, mime = 'text/plain') {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

export function downloadJson(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
}

/** 打开系统文件选择框，返回所选文件数组（取消则返回空数组） */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.click()
  })
}

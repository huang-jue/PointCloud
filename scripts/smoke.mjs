/**
 * 本地冒烟测试（可选）：用系统 Edge/Chrome 打开构建后的页面，检查运行时错误。
 *
 * 用法：
 *   npm run build
 *   npm run smoke
 *
 * Windows 默认使用 Edge；其他平台可通过 CHROME_PATH 指定 Chromium 可执行文件。
 */
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const PORT = Number(process.env.SMOKE_PORT || 4173)
const BASE = `http://127.0.0.1:${PORT}/base/`
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

const executablePath = CANDIDATES.find((path) => existsSync(path))
if (!executablePath) {
  console.error('未找到 Edge/Chrome，可通过 CHROME_PATH 指定浏览器路径')
  process.exit(1)
}

let server
let browser
try {
  server = await preview({ preview: { port: PORT, strictPort: true } })
  // 等待 preview 服务就绪
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE)
      if (res.ok) break
    } catch {
      /* 继续等待 */
    }
    await delay(250)
  }

  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })

  await page.goto(`${BASE}?dataset=urban&user=Smoke&role=admin`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.toolbar', { timeout: 20000 })
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.statusbar')?.innerText || ''
      return (
        text.includes('urban') &&
        !text.includes('正在加载全量真值') &&
        /本帧对象\s*[1-9]/.test(text)
      )
    },
    { timeout: 30000 },
  )

  const objectCount = async () =>
    Number((await page.locator('.statusbar').innerText()).match(/本帧对象\s*(\d+)/)?.[1] || 0)
  const before = await objectCount()
  // 右侧标签页切换
  for (const label of ['属性', '类别', '分割', '审核']) {
    await page.getByRole('tab', { name: label }).click()
    await delay(120)
    const active = await page.locator('.right-tab.active').innerText()
    if (!active.includes(label)) throw new Error(`右侧标签切换失败：期望 ${label}，实际 ${active}`)
  }

  await page.getByRole('button', { name: '添加框' }).click()
  await delay(600)
  const added = await objectCount()
  if (added <= before) throw new Error(`添加框失败：${before} -> ${added}`)
  await page.keyboard.press('Control+z')
  await delay(400)
  const undone = await objectCount()
  if (undone >= added) throw new Error(`撤销失败：${added} -> ${undone}`)

  // 再添加一次并等待自动草稿写入，然后刷新页面验证恢复
  await page.getByRole('button', { name: '添加框' }).click()
  await delay(500)
  const savedCount = await objectCount()
  await page.waitForFunction(
    () => document.querySelector('.statusbar')?.innerText.includes('草稿已保存'),
    { timeout: 15000 },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    (expected) => {
      const text = document.querySelector('.statusbar')?.innerText || ''
      return (
        text.includes('urban') &&
        !text.includes('正在加载全量真值') &&
        new RegExp(`本帧对象\\s*${expected}\\b`).test(text)
      )
    },
    savedCount,
    { timeout: 30000 },
  )
  const restored = await objectCount()
  if (restored !== savedCount) {
    throw new Error(`草稿恢复失败：${savedCount} -> ${restored}`)
  }

  // 批注员只应看到「审核」一个标签页
  const reviewer = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  reviewer.on('pageerror', (err) => errors.push(`reviewer pageerror: ${err.message}`))
  await reviewer.goto(`${BASE}?dataset=urban&user=Reviewer&role=reviewer`, {
    waitUntil: 'domcontentloaded',
  })
  await reviewer.waitForFunction(() => !!document.querySelector('.right-tab'), {
    timeout: 20000,
  })
  const reviewerTabs = await reviewer.locator('.right-tab').count()
  if (reviewerTabs !== 1) throw new Error(`批注员标签页数量应为 1，实际 ${reviewerTabs}`)
  await reviewer.close()

  // 打开轨迹管理 / 快捷键弹窗，确认没有运行时异常
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByText('轨迹管理与搜索').click()
  await page.waitForSelector('.el-dialog', { timeout: 10000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByText('快捷键说明').click()
  await page.waitForSelector('.shortcut-groups', { timeout: 10000 })

  if (errors.length) {
    console.error('运行时错误：\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`冒烟测试通过：对象 ${before} -> ${added} -> 撤销后 ${undone}`)
  }
} catch (err) {
  console.error(err?.stack || String(err))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
}

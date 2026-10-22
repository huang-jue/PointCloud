import { describe, expect, it } from 'vitest'
import { createZip } from '../zip.js'

describe('zip', () => {
  it('creates a store-mode zip with local headers and central directory', async () => {
    const blob = createZip([
      { name: 'labels/frame_000000.txt', data: 'Car 0 0 0\n' },
      { name: '点标签/说明.txt', data: '中文内容' },
    ])
    expect(blob.type).toBe('application/zip')
    const buffer = new Uint8Array(await blob.arrayBuffer())
    const view = new DataView(buffer.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true)).toBe(0x0800) // UTF-8 文件名
    // 末尾必须有 EOCD，且记录两个条目
    const endOffset = buffer.length - 22
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50)
    expect(view.getUint16(endOffset + 10, true)).toBe(2)
    const text = new TextDecoder().decode(buffer)
    expect(text).toContain('labels/frame_000000.txt')
    expect(text).toContain('中文内容')
  })
})

/**
 * 极简 ZIP 打包（store 模式，不压缩）
 *
 * 只依赖浏览器自带 API，用于把多帧 KITTI/点标签一次性导出为 .zip。
 * 对于文本标注文件，ZIP 的 store 模式体积可接受，且无需引入额外依赖。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new TextEncoder().encode(String(data ?? ''))
}

function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2) & 0x1f) << 11)
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9)
  return { time, day }
}

function writer(size) {
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)
  let offset = 0
  return {
    buffer,
    u16(value) {
      view.setUint16(offset, value, true)
      offset += 2
    },
    u32(value) {
      view.setUint32(offset, value >>> 0, true)
      offset += 4
    },
    bytes(value) {
      buffer.set(value, offset)
      offset += value.length
    },
    get offset() {
      return offset
    },
  }
}

/**
 * 生成 ZIP Blob
 * @param {Array<{name:string, data:string|Uint8Array|ArrayBuffer}>} files
 * @returns {Blob}
 */
export function createZip(files) {
  const now = new Date()
  const { time, day } = dosDateTime(now)
  const entries = []
  const localChunks = []
  let offset = 0

  for (const file of files || []) {
    const name = toBytes(file.name || 'file')
    const data = toBytes(file.data)
    const crc = crc32(data)
    const header = writer(30 + name.length)
    header.u32(0x04034b50)
    header.u16(20) // version needed
    header.u16(0x0800) // UTF-8 文件名
    header.u16(0) // store
    header.u16(time)
    header.u16(day)
    header.u32(crc)
    header.u32(data.length)
    header.u32(data.length)
    header.u16(name.length)
    header.u16(0)
    header.bytes(name)
    localChunks.push(header.buffer, data)
    entries.push({ name, data, crc, offset })
    offset += header.buffer.length + data.length
  }

  const centralChunks = []
  let centralSize = 0
  for (const entry of entries) {
    const header = writer(46 + entry.name.length)
    header.u32(0x02014b50)
    header.u16(20) // version made by
    header.u16(20) // version needed
    header.u16(0x0800)
    header.u16(0)
    header.u16(time)
    header.u16(day)
    header.u32(entry.crc)
    header.u32(entry.data.length)
    header.u32(entry.data.length)
    header.u16(entry.name.length)
    header.u16(0)
    header.u16(0)
    header.u16(0)
    header.u16(0)
    header.u32(0)
    header.u32(entry.offset)
    header.bytes(entry.name)
    centralChunks.push(header.buffer)
    centralSize += header.buffer.length
  }

  const end = writer(22)
  end.u32(0x06054b50)
  end.u16(0)
  end.u16(0)
  end.u16(entries.length)
  end.u16(entries.length)
  end.u32(centralSize)
  end.u32(offset)
  end.u16(0)

  return new Blob([...localChunks, ...centralChunks, end.buffer], {
    type: 'application/zip',
  })
}

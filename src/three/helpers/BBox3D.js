/**
 * BBox3D —— 带朝向的 3D 边界框可视化对象
 *
 * 坐标/变换模型（关键）：
 *   group   —— 只承载 位置(position) / 偏航(rotation.z)；缩放作为 TransformControls 的
 *              「临时乘子」（拖动手柄时由手柄写入，平时为 1）
 *   content —— 子节点，承载真实尺寸 (l, w, h)，线框/拾取盒都挂在它下面
 *
 * 为什么把尺寸放到子节点：TransformControls 的 scale 模式会把 object.scale 当成一个
 * 从 1 开始的乘子。若直接把 l/w/h 放在 group.scale 上，拖拽会反复相乘导致尺寸爆炸。
 * 因此用 readTransform() 把「乘子 × 基准尺寸」还原成新的 l/w/h。
 */

import * as THREE from 'three'

/** 单位立方体的边（所有框共用，避免重复构建几何体） */
const UNIT_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))

export class BBox3D {
  constructor(color = 0x4f9bff) {
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = true

    // 承载尺寸的子节点
    this.content = new THREE.Group()
    this.group.add(this.content)

    // 可见的线框
    this.material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
    this.line = new THREE.LineSegments(UNIT_EDGES, this.material)
    this.line.userData.pick = { kind: 'box', ref: this } // 供射线拾取定位到对象
    this.content.add(this.line)

    // 选中时的高亮描边（略放大 4%）
    this.highlightMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    this.highlight = new THREE.LineSegments(UNIT_EDGES, this.highlightMaterial)
    this.highlight.scale.setScalar(1.04)
    this.highlight.visible = false
    this.content.add(this.highlight)

    // 不可见的实心盒，用于更可靠的点击拾取
    this.pickMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }))
    this.pickMesh.userData.pick = { kind: 'box', ref: this }
    this.content.add(this.pickMesh)

    this.objectId = null
    this.color = color
    // 基准尺寸（最近一次 apply 写入的值，拖拽期间保持不变）
    this.dims = { l: 1, w: 1, h: 1 }
  }

  /** 设置类别颜色 */
  setColor(color) {
    this.color = color
    this.material.color.set(color)
  }

  /** 切换选中高亮 */
  setSelected(selected) {
    this.highlight.visible = !!selected
    this.highlightMaterial.opacity = selected ? 0.95 : 0
  }

  /**
   * 用标注数据更新框（世界坐标下的中心/尺寸/偏航）
   * @param {{id:string,l:number,w:number,h:number,x:number,y:number,z:number,ry:number}} obj
   * @param {string} [color] 类别颜色
   */
  apply(obj, color) {
    this.objectId = obj.id
    this.group.position.set(obj.x, obj.y, obj.z)
    this.group.rotation.set(0, 0, obj.ry || 0)
    // 拖拽结束后复位缩放乘子，真实尺寸写回 content
    this.group.scale.set(1, 1, 1)
    this.dims = { l: obj.l, w: obj.w, h: obj.h }
    this.content.scale.set(obj.l, obj.w, obj.h)
    if (color !== undefined) this.setColor(color)
  }

  /**
   * 从手柄变换后的 group 反读出标注字段（供 onBoxChange 回写）
   * 尺寸 = 基准尺寸 × 当前缩放乘子
   */
  readTransform() {
    const mul = this.group.scale
    const p = this.group.position
    return {
      l: Math.abs(this.dims.l * mul.x),
      w: Math.abs(this.dims.w * mul.y),
      h: Math.abs(this.dims.h * mul.z),
      x: p.x,
      y: p.y,
      z: p.z,
      ry: this.group.rotation.z,
    }
  }

  /** 释放本框独享的资源（UNIT_EDGES 为共享，不在此释放） */
  dispose() {
    this.material.dispose()
    this.highlightMaterial.dispose()
    this.pickMesh.geometry.dispose()
    this.pickMesh.material.dispose()
  }
}

/** 释放共享的单位立方体边（应用退出时可选调用） */
export function disposeUnitEdges() {
  UNIT_EDGES.dispose()
}

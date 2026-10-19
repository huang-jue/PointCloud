# 点云多帧标注工具

基于 Vue 3 + Vite + Three.js + Element Plus 的纯前端点云标注工具，支持**多帧序列**浏览、**3D 边界框**标注与**点级语义分割**。

## 功能

- **点云加载**：`PCD`、`PLY`、`BIN`(KITTI)、`LAS`、`LAZ`、`XYZ/CSV`
  - PCD/PLY 基于 Three.js 内置解析器（含 PCD `binary_compressed`），并补丁支持 `rgba` 字段
  - LAS/LAZ 基于 `@loaders.gl/las`（按需动态加载）
  - BIN 为 KITTI `float32 [x,y,z,intensity]` 自解析
- **多帧序列**：时间轴滑块、上一帧/下一帧、自动播放、帧缩略刻度、逐帧独立标注桶与 LRU 缓存
- **3D 边界框**：添加/删除，鼠标拖拽编辑——移动/旋转用 gizmo，缩放用三个面中心手柄（拖拽即可改长/宽/高），KITTI 字段 `h,w,l,x,y,z,ry`
- **类别管理**：每行「选择」单选决定当前类别（新建框与点标签使用），可改名/改色/增删
- **多帧物体**：开启工具栏「多帧添加」后，在当前帧添加的物体会自动出现在**之后所有帧**（同一 `trackId` 关联），**此帧之前隐藏**；支持「同步本帧位姿到后续帧」，删除时可选从当前帧起截断后续所有帧
- **多帧移动**：开启「多帧移动」后，在当前帧移动/旋转/缩放物体时，之后所有帧中同一 track 的物体会按**相同增量**同步（保留各帧间的相对运动）
- **点级语义分割**：矩形/画笔/套索涂抹或框选，**松开鼠标即自动生成**当前类别的标签并按类别着色；**单击已标注的点可选中该标签片段**（面板中的编辑区不依赖分割开关，随时可改类别/删除）；提供「覆盖已有标签」开关，关闭后只标注未标注区域；支持撤销、清空、导出（含片段信息）
  - 标签按帧保存：切换帧后再切回、甚至点云被缓存 LRU 淘汰后重新加载，标注都不会丢失
- **导入导出**：KITTI `.txt`、项目标注 `.json`、点级标签 `.json`
- **可拖拽**：直接把点云文件拖入视口加载
- **视口操作**：左键拖拽平移、右键拖拽旋转、滚轮缩放（分割模式下左键用于框选，中键平移）
- 坐标约定：Z 轴向上，传感器位于原点（道路场景地面位于 `z = -sensorHeight`）

## 快速开始

```bash
npm install
npm run gen:test-data      # 生成 3 份合成多帧数据集到 public/test-data/datasets（约 3.0GB，已 gitignore）
npm run fetch:test-data    # 下载真实单帧样本到 public/test-data/real
npm run dev
```

打开 `http://localhost:5173/`：

- 工具栏「示例数据」下拉选择三份数据集之一
- 或直接访问 `http://localhost:5173/?dataset=urban&gt=1` 自动加载并导入真值框（`dataset` 取 `urban` / `highway` / `crossing`）
- 亦可点击「加载文件」或把 `.pcd/.ply/.bin/.las` 拖入视口

## 测试数据

**数据集 A/B/C · 合成多帧序列**（`scripts/gen-test-data.mjs`，`npm run gen:test-data`）

| id | 场景 | 帧数 | 点数/帧 | 大小 | 内容 |
| --- | --- | --- | --- | --- | --- |
| `urban` | 城市道路 | 50 | ~39.5 万 | ~886MB | 两侧建筑立面、路灯、路边泊车、6 车道车流、行人 |
| `highway` | 高速公路 | 80 | ~34.8 万 | ~1.25GB | 240m 多车道、护栏、灯杆、10 辆高速车流（含卡车） |
| `crossing` | 路口+停车场 | 60 | ~35.7 万 | ~960MB | 十字路口、四角建筑、红绿灯杆、14 辆泊车、行人、转弯车 |

合计 190 帧 / 约 6900 万点 / 约 3.0GB（单帧 bin 5–6MB）。用于压测大点云下的加载与交互体验。

- 每个数据集：`public/test-data/datasets/<id>/frame_XXXXXX.{bin,pcd,ply}`（同源三种格式）+ `labels/frame_XXXXXX.json` 真值 + `scene.json`
- 汇总索引：`public/test-data/datasets/index.json`（供工具栏下拉使用）
- 参数：`node scripts/gen-test-data.mjs --only highway --frames 30`、`--density 1.5`（密度倍率，越小数据越小）、`--formats bin,ply`、`--out <dir>`

> 提示：压测时用 `npm run build && npm run preview` 走静态服务更贴近生产；无头/软件渲染（无 GPU）环境会因 CPU 光栅化严重拖慢，不代表真实体验。

**真实样本**（`scripts/fetch-test-data.mjs`，`npm run fetch:test-data`）

- `public/test-data/real/bunny.pcd`（ASCII）、`cube.ply`（ASCII）、`milk_color.pcd`（`rgba`，binary_compressed）、`car6.pcd`（binary_compressed）

## 视口操作与快捷键

| 操作 | 功能 |
| --- | --- |
| 左键拖拽 | 平移视图（分割模式下用于框选点） |
| 右键拖拽 | 旋转视图 |
| 滚轮 | 缩放 |
| 单击 3D 框 | 选中该框 |

| 按键 | 功能 |
| --- | --- |
| `←` / `→` | 上一帧 / 下一帧 |
| `空格` | 播放 / 暂停 |
| `Q` `W` `E` `R` | 选择 / 移动 / 旋转 / 缩放 |
| `B` | 切换点级分割模式 |
| `F` | 适应视角 |
| `Delete` | 删除选中框（多帧物体将提示是否从本帧起截断后续帧） |
| `Ctrl+Z` | 撤销上一步标签 |

## 目录结构

```
src/
  stores/useAnnotationStore.js    # 帧/对象/类别/分割状态与导入导出
  three/
    PointCloudViewer.js           # 场景、相机、控制器、点云、框、分割
    loaders/index.js              # 格式分发与解析
    helpers/{BBox3D,PointColorizer}.js
  components/                     # Toolbar / ObjectList / Properties / ClassManager
                                  # SegmentPanel / Viewer / Timeline / StatusBar
scripts/                          # 测试数据生成与下载
```

## 标注格式

导出项目 JSON：

```json
{
  "format": "pointcloud-annotation",
  "version": 1,
  "classes": [{ "id": 0, "name": "Car", "color": "#4f9bff" }],
  "frames": [{ "name": "frame_000000.bin", "objects": [{ "type": "Car", "trackId": 1001, "multiFrame": true, "startFrame": 10, "h": 1.5, "w": 1.8, "l": 4.2, "x": 8, "y": -2.6, "z": -0.98, "ry": 0 }] }]
}
```

多帧物体在各帧中拥有相同 `trackId` 与 `startFrame`，可逐帧微调位姿后再用「同步本帧位姿到后续帧」统一。

KITTI 导出为每行
`type truncated occluded alpha x1 y1 x2 y2 h w l x y z ry [score]`。

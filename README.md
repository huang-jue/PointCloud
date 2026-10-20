# 点云多帧标注工具

基于 Vue 3 + Vite + Three.js + Element Plus 的纯前端点云标注工具，支持**多帧序列**浏览、**3D 边界框**标注、**路面标线（车道线/斑马线/箭头）**标注与**点级语义分割**。

## 功能

- **点云加载**：`PCD`、`PLY`、`BIN`(KITTI)、`LAS`、`LAZ`、`XYZ/CSV`
  - PCD/PLY 基于 Three.js 内置解析器（含 PCD `binary_compressed`），并补丁支持 `rgba` 字段
  - LAS/LAZ 基于 `@loaders.gl/las`（按需动态加载）
  - BIN 为 KITTI `float32 [x,y,z,intensity]` 自解析
- **多帧序列**：时间轴滑块、上一帧/下一帧、自动播放、帧缩略刻度、逐帧独立标注桶与 LRU 缓存
- **3D 边界框**：添加/删除，鼠标拖拽编辑——移动/旋转用 gizmo，缩放用三个面中心手柄（拖拽即可改长/宽/高），KITTI 字段 `h,w,l,x,y,z,ry`
- **路面标线（画线 / 画箭头）**：
  - 画线：左键在地面逐点落点，`Enter` 或双击完成，`Backspace` 退点，`Esc` 取消；可画车道线、停止线、斑马线条纹等任意折线
  - 画箭头：支持**自由折线箭头**与**预设模板**（直行 / 左转 / 右转 / 直行+左转 / 掉头）；模板单击即放置，可设置朝向，放置后仍可拖动顶点微调
  - 选中标线后显示黄色顶点手柄：拖拽改点、`Alt+点击`删除顶点；属性面板可改线宽、逐个编辑顶点坐标、绕质心旋转/缩放
  - **点云吸附**：绘制落点和拖拽顶点时自动吸附到最近的点云点（可在工具栏/属性面板关闭）；吸附使用 XY 网格索引，大点云下也能实时跟随
  - **记住线宽**：在属性面板修改某条标线的线宽后，会同步为下次绘制同类标线的默认线宽
  - 线宽以米为单位（带状面片渲染，不依赖 WebGL 的 1px 线宽限制）；支持多帧添加与「同步到后续帧」
  - 类别自动使用 `LaneLine` / `RoadArrow`，退出绘制后恢复原来的框类别
- **类别管理**：每行「选择」单选决定当前类别（新建框与点标签使用），可改名/改色/增删
- **多帧物体**：开启工具栏「多帧添加」后，在当前帧添加的物体会自动出现在**之后所有帧**（同一 `trackId` 关联），**此帧之前隐藏**；支持「同步本帧位姿到后续帧」，删除时可选从当前帧起截断后续所有帧
- **多帧移动**：开启「多帧移动」后，在当前帧移动/旋转/缩放物体时，之后所有帧中同一 track 的物体会按**相同增量**同步（保留各帧间的相对运动）
- **点级语义分割**：矩形/画笔/套索涂抹或框选，**松开鼠标即自动生成**当前类别的标签并按类别着色；**单击已标注的点可选中该标签片段**（面板中的编辑区不依赖分割开关，随时可改类别/删除）；提供「覆盖已有标签」开关，关闭后只标注未标注区域；支持撤销、清空、导出（含片段信息）
  - 示例数据集的标线点级标签（`point_labels/markings.json`）会在切帧时自动加载，切到「语义标签」着色即可看到车道线/斑马线/箭头被分类着色，并且可以继续编辑
  - 标签按帧保存：未编辑帧共享真值模板，编辑帧使用写时复制并保留撤销记录；切换帧后再切回不会丢失
- **多选与复制粘贴**：Ctrl+点击多选、Shift+点击列表范围选择、Ctrl+A 全选；支持批量删除/改类别、Ctrl+C/V 复制粘贴、Ctrl+Shift+V 原地粘贴；多选后按 W 可整体平移（混合选择时限制在 XY 平面）
- **自动加载全量真值**：示例数据集加载后自动导入所有帧的真值框/标线（urban 约 2,490、highway 约 6,560、crossing 约 7,400 个对象）；可点击「重新导入真值」覆盖恢复
- **导入导出**：KITTI `.txt`、项目标注 `.json`、点级标签 `.json`
- **导出数据**：工具栏「导出数据」导出所有帧的框/标线与已编辑的点级标签为 JSON；未配置 `VITE_SAVE_API` 时直接下载，不再提示后端未配置
- **可拖拽**：直接把点云文件拖入视口加载
- **视口操作**：左键拖拽平移、右键拖拽旋转、滚轮缩放（分割模式下左键用于框选，中键平移）
- 坐标约定：Z 轴向上，传感器位于原点（道路场景地面位于 `z = -sensorHeight`）

## 快速开始

```bash
npm install
npm run gen:test-data -- --formats bin   # 生成 3 份 bin-only 数据集（约 1.15GB，已 gitignore）
npm run fetch:test-data                  # 下载真实单帧样本到 public/test-data/real
npm run dev
```

开发/部署都在 `/base/` 子路径下：

- 打开 `http://localhost:5173/base/`
- 工具栏「数据」下拉选择三份数据集之一，加载后会自动导入全量真值
- 或直接访问 `http://localhost:5173/base/?dataset=urban`（`dataset` 取 `urban` / `highway` / `crossing`）
- 亦可点击「数据 → 加载本地文件…」或把 `.pcd/.ply/.bin/.las` 拖入视口

## 演示部署

```bash
npm run gen:test-data -- --formats bin
npm run build
# 将 dist/ 内容上传到服务器 /base/ 目录
```

- Vite `base` 固定为 `/base/`（见 `vite.config.js`）
- `.env.production` 中 `VITE_API_BASE` / `VITE_SAVE_API` 为空，纯静态运行
- 静态服务器需要把 `/base/*` fallback 到 `/base/index.html`，并让 `.bin` 返回 `application/octet-stream`
- 可选 URL 参数：`?dpr=1` 强制低渲染分辨率，`?perf=1` 显示 FPS/帧耗时/绘制调用，`?prefetch=1` 开启下一帧预取（默认关闭，避免和当前帧抢资源）

## 测试数据

**数据集 A/B/C · 合成多帧序列**（`scripts/gen-test-data.mjs`，`npm run gen:test-data`）

| id | 场景 | 帧数 | 点数/帧 | 大小 | 内容 |
| --- | --- | --- | --- | --- | --- |
| `urban` | 城市道路 | 50 | ~39.5 万 | ~312MB | 两侧建筑立面、路灯、路边泊车、6 车道车流、行人；实线/虚线车道线、5 个路面箭头 |
| `highway` | 高速公路 | 80 | ~34.8 万 | ~467MB | 240m 多车道、护栏、灯杆、10 辆高速车流（含卡车）；多车道实线/虚线、5 个直行箭头 |
| `crossing` | 路口+停车场 | 60 | ~35.7 万 | ~349MB | 十字路口、四角建筑、红绿灯杆、14 辆泊车、行人、转弯车；四向斑马线、停止线、多向箭头 |

合计 190 帧 / 约 6900 万点 / 约 1.1GB（bin-only，单帧约 6MB）。用于压测大点云下的加载与交互体验。

- 每个数据集：`public/test-data/datasets/<id>/frame_XXXXXX.{bin,pcd,ply}`（默认同源三种格式；演示部署用 `--formats bin` 只保留 bin）+ `labels/frame_XXXXXX.json` 逐帧真值 + `labels/all.json` 全量真值 + `point_labels/markings.json` 标线点级标签 + `scene.json`
- 标线点云：高反射白色涂料点（强度明显高于地面），固定排在地面点之前，因此逐帧点级标签索引完全一致，一份 `markings.json` 被所有帧共用
- 标线类别：`LaneLine`(6)、`Crosswalk`(7)、`RoadArrow`(8)、`StopLine`(9)
- 汇总索引：`public/test-data/datasets/index.json`（供工具栏下拉使用，含各数据集标线统计）
- 参数：`node scripts/gen-test-data.mjs --only highway --frames 30`、`--density 1.5`（密度倍率，越小数据越小）、`--formats bin,ply`、`--out <dir>`

> 提示：压测时用 `npm run build && npm run preview` 走静态服务更贴近生产；无头/软件渲染（无 GPU）环境会因 CPU 光栅化严重拖慢，不代表真实体验。

**真实样本**（`scripts/fetch-test-data.mjs`，`npm run fetch:test-data`）

- `public/test-data/real/bunny.pcd`（ASCII）、`cube.ply`（ASCII）、`milk_color.pcd`（`rgba`，binary_compressed）、`car6.pcd`（binary_compressed）

## 视口操作与快捷键

| 操作 | 功能 |
| --- | --- |
| 左键拖拽 | 平移视图（分割/绘制模式下用于框选点、落点） |
| 右键拖拽 | 旋转视图 |
| 滚轮 | 缩放 |
| 单击 3D 框 / 标线 | 选中该对象 |
| 拖拽黄色顶点手柄 | 移动标线顶点 |
| `Alt+点击` 顶点 | 删除该顶点 |

| 按键 | 功能 |
| --- | --- |
| `←` / `→` | 上一帧 / 下一帧 |
| `空格` | 播放 / 暂停 |
| `Q` `W` `E` `R` | 选择 / 移动 / 旋转 / 缩放 |
| `L` | 画线（逐点落点） |
| `A` | 画箭头（自由折线或模板） |
| `Enter` | 绘制中：完成当前标线 |
| `Backspace` | 绘制中：退掉最后一个落点 |
| `Esc` | 绘制中：取消当前草稿 |
| `B` | 切换点级分割模式（会自动退出绘制） |
| `F` | 适应视角 |
| `W` / `E` | 选中单条线/箭头时：整体平移 / 整体旋转 |
| `Ctrl+点击` | 多选 / 取消选中对象（视口与对象列表） |
| `Shift+点击` | 对象列表范围选择 |
| `Ctrl+A` | 全选当前帧对象 |
| `Ctrl+C` / `Ctrl+V` | 复制选中对象 / 偏移粘贴 |
| `Ctrl+Shift+V` | 原地粘贴 |
| `Ctrl+D` | 原地复制选中对象 |
| `Delete` | 删除选中对象（多帧物体将提示是否从本帧起截断后续帧） |
| `Esc` | 清空对象选择（绘制中为取消草稿） |
| `Ctrl+Z` | 撤销上一步点标签 |

## 目录结构

```
src/
  stores/useAnnotationStore.js    # 帧/对象/类别/分割状态与导入导出
  three/
    PointCloudViewer.js           # 场景、相机、控制器、点云、框、标线、分割
    loaders/index.js              # 格式分发与解析
    helpers/{BBox3D,RoadMarking3D,PointColorizer}.js
  utils/
    http.js                       # axios 封装：baseURL/token/解包/错误归一化/二进制下载
    save.js                       # 保存载荷组装与提交后端
    polyline.js                   # 折线/箭头模板几何（前端与测试数据生成共用）
    actions.js io.js kitti.js math.js id.js
  components/                     # Toolbar / ObjectList / Properties / ClassManager
                                  # SegmentPanel / Viewer / Timeline / StatusBar
scripts/                          # 测试数据生成与下载
.env.example                      # 后端地址等配置模板
```

## 后端对接

复制 `.env.example` 为 `.env.local` 并配置：

```
VITE_API_BASE=            # 可选，API 基地址（留空=同源）
VITE_API_TIMEOUT=30000    # 可选，请求超时(ms)
VITE_SAVE_API=https://your-server/api/annotations   # 保存接口(POST JSON)；留空则「保存」退化为下载
```

点击工具栏「保存」时会 `POST` 如下载荷到 `VITE_SAVE_API`：

```json
{
  "format": "pointcloud-annotation",
  "version": 1,
  "dataset": "urban",
  "savedAt": "2026-10-19T08:00:00.000Z",
  "coordinate": { "up": "z", "forward": "x", "right": "y" },
  "classes": [{ "id": 0, "name": "Car", "color": "#4f9bff" }],
  "frames": [
    {
      "index": 0, "name": "frame_000000.bin", "timestamp": 0, "pointCount": 395503,
      "objects": [
        { "id": "obj_1", "trackId": 1001, "startFrame": 10, "multiFrame": true,
          "classId": 0, "type": "Car", "h": 1.5, "w": 1.8, "l": 4.2,
          "x": 8, "y": -2.6, "z": -0.98, "ry": 0, "score": 1, "source": "manual" },
        { "id": "mark_1", "shape": "line", "type": "LaneLine", "classId": 6, "width": 0.15,
          "points": [[-10, 3.5, -1.69], [20, 3.5, -1.69]], "trackId": 0, "source": "manual" },
        { "id": "mark_2", "shape": "arrow", "type": "RoadArrow", "classId": 8, "width": 0.32,
          "template": "straightLeft",
          "paths": [[[0,0,-1.68], [0.9,0,-1.68], [1.8,0,-1.68], [2.7,0,-1.68]],
                    [[0.45,0,-1.68], [1.3,0.1,-1.68], [1.95,0.65,-1.68], [2.15,1.35,-1.68]]],
          "trackId": 0, "source": "manual" }
      ],
      "pointLabels": { "pointCount": 395503, "labeled": 176307,
                       "labels": [-1, -1, 0, "..."],
                       "segments": [{ "classId": 0, "indices": [12, 13, "..."] }] }
    }
  ]
}
```

响应兼容两种形式：直接返回 JSON，或 `{ "code": 0, "data": { "id": 123 }, "message": "ok" }`
（`code` 为 `0/200` 视为成功并返回 `data`，其他视为业务错误）。失败时前端统一弹出归一化后的错误信息。

HTTP 层封装在 `src/utils/http.js`（axios）：请求前缀、超时、token 注入（`setAuthToken`）、
响应解包、错误归一化（超时/网络/HTTP 状态/业务码）、`downloadBinary()` 二进制下载（点云文件走这里）、
`withLoading()` loading 包裹，以及 `{ silent: true }` 关闭自动错误提示。

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

标线对象用 `shape` 区分：`'line'` 用 `points`（单条折线），`'arrow'` 用 `paths`（可多条，支持「直行+左转」这类组合箭头）。`width` 为线宽（米），`template` 记录所用模板名（自由绘制为 `null`）。3D 框对象没有 `shape` 字段（或为 `'box'`）。

KITTI 导出为每行
`type truncated occluded alpha x1 y1 x2 y2 h w l x y z ry [score]`。
KITTI 格式无法表达折线标线，导出时会跳过标线对象并给出提示；需要保留标线请使用「导出标注」的项目 JSON。

# 西安文化介绍网站

这是一个基于 HTML5 和 CSS3 开发的西安文化介绍网站。网站以“大唐盛世”为设计主题，结合现代前端技术展示西安的历史深度、民俗魅力及旅游风采。

## 功能特点

- **沉浸式视觉体验**：采用深红与金色的经典配色，搭配 AI 生成的高清西安特色图景。
- **语义化结构**：严格遵守 HTML5 标准，确保代码清晰、易于维护且对 SEO 友好。
- **混合布局设计**：巧妙融合了传统的竖排文字排布（Vertical Layout）与现代的横排内容块，体现古今交融之感。
- **响应式设计**：针对不同屏幕尺寸（手机、平板、桌面）进行了适配，确保在任何终端都有一致的浏览体验。
- **动态交互**：页面包含平滑的淡入加载效果和卡片悬停反馈，增强用户交互感。

## 页面说明

1.  **首页 (index.html)**：通过宏大的叙述揭露西安作为十三朝古都的历史底蕴。
2.  **民俗活动页 (activities.html)**：重点介绍秦腔、皮影戏等非物质文化遗产。
3.  **旅游指南页 (travel.html)**：为游客提供必打卡景点及关中地道美食的实用建议。

## 技术栈

- HTML5 (Semantic Elements)
- CSS3 (Flexbox, Grid, Animations, Vertical writing mode)
- Google Fonts (Noto Serif SC)
- AI Generated Images

## 使用说明

1. 克隆或下载本项目至本地。
2. 在浏览器中打开 `index.html` 即可开始浏览。
3. 通过顶部导航栏在不同板块间自由切换。

---

# 节庆路线与年历子系统

文化站新增的"节庆路线 + 年度年历"能力。零第三方依赖，Node ≥ 18 即可运行。

## 启动 / 测试

```bash
npm start                 # 首次启动自动写入演示数据到 ./data，监听 :3000
node test/acceptance.js   # 19 项端到端验收测试（临时数据目录，互不污染）
PORT=3100 npm start
```

- 访客年历：<http://localhost:3000/calendar.html?year=2027&node=nodes_3&view=list>
- 编辑后台：<http://localhost:3000/app/>（右上角切换 editor / reviewer / publisher / visitor）

## 数据分库（`server/db.js`）

| 库文件 | 表 | 说明 |
|---|---|---|
| `db_instances.json` | `event_instances` | **年度活动实例**：组织方逐年公布，必须带来源、经显式确认 |
| `db_rules.json` | `recurrence_rules`、`calendar_versions` | **周期规则**（公历固定 / 农历浮动）与年历缓存版本 |
| `db_articles.json` | `articles` | **历史文章**：发布即冻结快照，不随当前公告改写 |
| `db_content.json` | `nodes`、`edges`、`routes`、`route_steps`、`announcements`、`releases` | 编辑内容与发布任务 |

表都带自增主键、`version` 乐观锁与时间戳。`DB` 是关系型仓库的 JSON 适配实现，接口（`insert/find/update(version)/replace`）可平移到 Postgres。

## 关键规则如何落地

1. **节庆日期逐年公布，禁止沿用去年日期**
   - 创建实例必须带 `source.url_text`，否则 422；审核员另有显式"来源确认"动作（`POST /api/instances/:id/confirm`），留痕。
   - 周期规则展开 `/api/rules/:id/expand` 只产出 `needs_confirmation:true` 草案；农历浮动节庆在未公布年份直接 422，提示"禁止沿用去年日期"。
2. **跨年 / 跨午夜保留时区与原始表达**
   - 一律用 IANA 时区（`Asia/Shanghai`）把当地墙钟转 UTC 绝对时刻存储（`server/time.js`），同时保留 `date_raw`、`window_raw` 原文。
   - 节点窗口 `close<=open` 视为跨午夜（如 `19:00–次日02:00`）；日期按当地日历分量加减，不做"绝对毫秒±24h"。
3. **路线是有向图**（`server/graph.js`）
   - 节点分仪式节点（有开放窗口）与换乘点（无窗口=全天可达）；边带方式与移动耗时。
   - `GET /api/graph/earliest` 求**最早到达**（时间相关最短路，到得早会等待开窗）；
   - `POST /api/graph/compare` 比较最早路径与**偏好候选**（方式白/黑名单、必经节点），给出相对延迟；
   - `POST /api/graph/evaluate` 按指定连线序列做**可行性判定**，时间不足时返回**第一条冲突边**、抵达时间与该场窗口关闭时间。
4. **天气 / 施工只影响相交时空片段**：`intersectNotices` 按边/节点空间 ∩ 公告时间区间打标，不相交片段不标注，历史叙事不重写。
5. **公告先到、活动后到**：公告可无实例先行创建；`POST /api/announcements/:id/link` 在活动到达后挂接。
6. **同节点多路线引用 / 节点下线**：`GET /api/nodes/:id/references` 列引用路线；下线（`status=archived`）后相关边在图中剔除、求路报不可行，已发布快照不受影响。
7. **两个编辑并发改连线**：PUT 带 `version`（或 `If-Match`），陈旧写入得到 **409** 并回带服务器当前版本，不覆盖他人改动。
8. **发布冻结 + 年历版本**：`POST /api/releases`（publisher）把当时节点/公告/路线/文章版本整包快照；未确认实例列入 `unconfirmed_instances` 不发布；发布后年历版本 `calendar_versions.version` 递增，年历接口 ETag 含版本号。
9. **访客筛选深链、列表替代地图**：`/calendar.html?year=&node=&tag=&view=list|map`，默认列表，地图为可选项。
10. **迟到响应不覆盖当前所选日期**：`public/js/calendar-core.js` 用请求序号 + 选择令牌守卫（`createStore.resolve`），过期响应进入 `lateResponses` 而非覆盖；轮询发现年历新版本只显示"缓存未更新"徽标。

## 角色（请求头 `X-Role`）

- `editor`：节点/连线/路线/实例/公告草稿/文章草稿
- `reviewer`：实例来源确认、公告审核
- `publisher`：公告发布、文章发布冻结、年历发布任务
- `visitor`（默认）：只读年历、图计算、列表

## 主要 API

```
GET/POST /api/nodes            PUT /api/nodes/:id(body 带 version)   POST /api/nodes/:id/offline
GET/POST /api/edges            PUT /api/edges/:id
GET/POST /api/routes
GET /api/graph/earliest?origin&destination&date&time&modes
POST /api/graph/compare        POST /api/graph/evaluate
GET/POST /api/instances        POST /api/instances/:id/confirm
POST /api/rules                POST /api/rules/:id/expand
GET/POST /api/announcements    POST /api/announcements/:id/{review,publish,link}
GET/POST /api/articles  PUT /api/articles/:id  POST /api/articles/:id/publish
POST /api/releases             GET /api/releases?year=
GET /api/calendar/:year?node&tag&view=list     GET /api/calendar/:year/version
```

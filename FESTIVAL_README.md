# 文化站 · 节庆路线与年历系统

在原西安文化静态站之上新增的完整模块：**Web 编辑仪式节点与交通换乘 → API 审核/冻结/发布 →
访客年历与路线可行性**。仅依赖 Python 3 标准库（`http.server` + `sqlite3` + `zoneinfo`），
前端为原生 HTML/CSS/JS，无构建步骤。

## 启动

```bash
bash run.sh                 # 默认 :8000，首次自动建库并写入演示数据
# 或
PORT=8000 python3 -m server.seed && PORT=8000 python3 -m server.app
```

- 访客年历 / 编辑器 / 审核台：<http://localhost:8000/>
- 原有静态页面仍可直接打开（`index.html` 等）。

## 数据模型（三类数据分表保存，互不覆写）

| 家族 | 表 | 语义 |
|---|---|---|
| **年度活动实例** | `activity_instances` | 每一年一届的具体节庆；仅当有来源确认的公告时才落具体日期 |
| **周期规则** | `recurrence_rules` | 如“农历正月十五”；只能产生**无日期的待公告草稿**，永不复制去年日期 |
| **历史文章** | `historical_articles` | 已发布叙事为**只追加**，发布后拒绝改写（`RuleError`） |

辅助表：`nodes`（仪式/换乘节点，含开放窗口）、`edges`（有向连线：移动耗时+开放窗口）、
`routes`/`route_items`（命名路线对连线的有序引用，**同一连线可被多条路线引用**）、
`announcements`/`announcement_occurrences`（组织方公告）、`advisories`（天气/施工，
带边/节点作用域与起止时间）、`publication_tasks`+`task_freeze_items`（审核→冻结→发布，
冻结的是实体快照与版本号）、`almanac_published`（发布年历快照，缓存年历在重新发布前不变）、
`edit_events`（并发编辑审计）。

所有时间以 **本地钟面时间字符串 + IANA 时区名** 存储，比较时才转 `aware datetime`；
跨午夜窗口直接写下一日真实日期（如 `2027-02-20T17:00 → 2027-02-21T01:00`），
跨年时段保留各自时区；公告原文（如“2027年2月20日（正月十三）至2月22日”）原样存入
`original_expression`。

## 关键规则落地

1. **日期不跨年复制**：`propose_from_rule` 只建 `start_local=NULL` 的 draft；
   若该年已是 confirmed/published，再次提案直接报错。
2. **公告先到、活动后到**：`POST /api/announcements` 的场次 slug 不存在时，
   以公告为来源自动创建 `confirmed` 实例并回链公告。
3. **路线比较**：`POST /api/routes/compare`
   - `earliest_arrival`：时间相关 Dijkstra，等连线开放再走，最早到达优先；
   - `candidate`：按偏好（零换乘/禁模式/避开边/步行上限）顺序走指定链；
   - 时间不足或遇关闭时返回 `conflict_edges`，逐条给出边 slug 与原因
     （`no-open-window:`、`arrival-after-close:`、`node-offline:` 等）。
4. **天气/施工只影响相交时空片段**：作用域（边/节点 slug）与时间区间同时相交才附加；
   `closure` 封控可被“等过封控时段”规避（自动增加封控结束时刻的出发候选），
   作用域外的地铁线完全不受影响。
5. **历史不随公告重写**：文章仅发布前可改；发布后冻结，年历快照里的文章也固定。
6. **发布冻结**：任务流转 `pending_review → approved → frozen → published`；
   冻结时把节点/连线/公告/实例/文章的**当时版本与完整 JSON**存入 `task_freeze_items`，
   之后编辑不影响本次发布；重新发布才刷新 `almanac_published` 缓存。
7. **并发改连线**：所有更新走乐观锁 `If-Match: <version>`；第二位保存者收到
   `409 VersionConflict`，需刷新版本重试（审计落 `edit_events`）。
8. **节点下线**：`PUT /api/nodes/{id}/offline`；所有经该节点的路径立刻不可行并报告原因。
9. **访客筛选**：筛选条件可深链（`?year=2027&q=灯会&only_confirmed=1&view=list`），
   `view=list` 用列表替代地图（SVG 仅为示意）。
10. **迟到结果不覆盖当前所选日期**：前端 `loadSeq`/`compareSeq` 单调令牌，
    切换年份或重新发起计算后，迟到的旧响应只打印日志并丢弃（见
    `tests/frontend.test.js`）。

## HTTP API 摘要

```
GET  /api/{nodes,edges,routes,rules,announcements,instances,articles,advisories,publications}
GET  /api/routes/:id                         # 含 edge_slugs 有序列表
POST /api/nodes | /api/edges | /api/routes | /api/rules | /api/advisories
PUT  /api/edges/:id/reconnect      (If-Match, JSON: from_slug,to_slug)
PUT  /api/nodes/:id/offline        (If-Match)
PUT  /api/{node,edge,...}/:id      (If-Match, 通用版本化更新)
POST /api/rules/:id/propose        {year}    -> 待公告草稿
POST /api/announcements            {external_ref,announced_at,occurrences[]}
POST /api/routes/compare           {origin,dest,start_local,candidate_edges?,preferences?}
POST /api/publications             一键 建任务→审核→冻结→发布（年）
POST /api/publications/step        分步 create/review/freeze/publish
GET  /api/almanac/:year            发布快照；?live=1 实时组装
```
乐观锁：写请求带头 `If-Match: <当前version>`、`X-Actor: <编辑>`。

## 测试

```bash
python3 -m unittest tests.test_acceptance -v   # 18 个领域验收用例
node tests/frontend.test.js                     # 深链/列表筛选/迟到响应守卫
# HTTP 端到端（需先启动服务）：
PORT=8020 python3 -m server.app &
PORT=8020 bash tests/http_scenarios.sh
```

覆盖的验收情形：同节点多路线引用、公告先到活动后到、节点下线、两位编辑并发改连线
（409）、缓存年历未重新发布前不更新、发布冻结节点与公告版本、周期提案不复制旧日期、
跨午夜与跨年时区保留、施工仅影响相交片段、封控子时段可等待、偏好候选与最早到达比较、
时间不足指出冲突边、迟到计算不覆盖当前日期。

## 目录

```
server/   schema.py(建表) timelib.py(时区/窗口) routing.py(图/路径)
          services.py(领域服务+乐观锁+发布冻结) seed.py(演示数据) app.py(HTTP)
festival/ 前端 index.html + css + js（api/visitor/editor/admin/app）
tests/    test_acceptance.py · frontend.test.js · http_scenarios.sh
```

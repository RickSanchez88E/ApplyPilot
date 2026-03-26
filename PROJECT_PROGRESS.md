# 项目进度 (PROJECT_PROGRESS.md)

## 当前阶段: Multi-Source v2.3 — 时间精度 + Freshness 修复

### v2.3 变更 (2026-03-26)
- [x] **Fix 1: 时间精度感知渲染**
  - API `/api/jobs` 新增 `posted_date_precision` 计算列（'day' | 'datetime'）
  - 基于午夜整点检测 (HH:MM:SS = 00:00:00 → 'day')
  - 前端 `formatAgo()` 按精度渲染：day → "Today"/"Yesterday"/"Mar 26"，datetime → "10 days ago"
  - 解决 Reed (269 条) / LinkedIn (88 条) 的"虚假 19 hours ago"问题
- [x] **Fix 2: Freshness 审计字段**
  - API `/api/jobs` 新增 `freshness_gap_seconds` 计算列（`created_at - posted_date` 的秒数差）
  - 用于审计"入库时间 vs 发布时间"的偏差
- [x] **Fix 3: 前端 React 迁移（由用户完成）**
  - 旧 vanilla JS 前端已删除（app.js, dom.js, controls.js 等）
  - 新前端：`frontend/` Vite + React + TailwindCSS v4
  - Vite build 输出到 `public/` 供 Express 静态服务
- [x] **Fix 4: Mixed-source trigger 逻辑修复**
  - Bug: 当 timeFilter 没传时，timeSupported 组的源（Reed, Jooble）被完全跳过
  - Fix: 无 maxAgeDays 时所有源统一走一次 full-fetch；有 maxAgeDays 时分组执行
  - 确保 Reed + HN 混选时两者都执行
- [x] **Adapter 能力声明（由用户完成）**
  - `SourceAdapter` 新增 `supportsNativeTimeFilter` 和 `minTimeGranularityHours`
  - Orchestrator 使用声明替代硬编码集合 `SOURCES_WITH_NATIVE_TIME_FILTER`
  - `/api/sources` 暴露能力元数据供前端消费
- [x] **DevITJobs adapter 重写（由用户完成）**
  - 旧 `/api/jobSearch` 返回 HTML → 新 `/api/jobsLight` 返回 JSON
  - 本地缓存 + 客户端关键词/地点/远程过滤
- [x] **HN Hiring 修复（由用户完成）**
  - 使用 `search_by_date` 替代 `search` 避免返回旧帖子
  - 从 comment.time 提取 postedDate → 使 post-filter 生效
  - 去掉 Reed/Jooble 不可靠的 postedDate（非真实发布时间）
- [x] 克隆并本地部署
- [x] 修复本地数据库端口冲突 (5433)
- [x] 引入并阅读 `AGENTS.md` 规范
- [x] 阶段 1: 核心框架与前端 MVP 开发
- [x] 阶段 2: 接入 API 友好的 ATS (Greenhouse, Lever 等)
- [x] 阶段 3: 接入高防反爬 ATS (Workday, Taleo, SuccessFactors, iCIMS)
- [x] **v2.0: 多数据源 Multi-Source 引擎**
  - [x] 5 个 API 源适配器 + GOV.UK Sponsor 名单
  - [x] 跨平台去重 content_hash
  - [x] 前端数据源分组展示
- [x] **v2.1: Schema 分离 + 交互式 Dashboard**
  - [x] DB Migration 004: 6 个独立 Schema (src_linkedin, src_devitjobs, src_reed, src_jooble, src_hn_hiring, src_remoteok)
  - [x] Schema Router (`schema-router.ts`): 按源路由查询到对应 Schema
  - [x] `public.jobs_all` VIEW: UNION ALL 全源数据
  - [x] `public.content_index` 表: 跨平台关联索引
  - [x] LinkedIn 多时间段爬取: 默认先爬 1h → 再爬 24h (最新优先)
  - [x] 前端交互优化:
    - [x] 时间筛选按钮 (1h / 6h / 24h / 1w / 1m) — 控制 LinkedIn 爬取范围
    - [x] 24h Activity 柱状图 (纯 CSS 可视化)
    - [x] 时间范围下拉 (Last 1h / 6h / 24h / 1w / 1m / All)
    - [x] 排序方式下拉 (最新爬取 / 最新发布 / 公司 A-Z)
    - [x] Source Tabs 可交互筛选
    - [x] 相对时间显示 ("3m ago", "22h ago")
    - [x] Source 彩色进度条 (sidebar)
    - [x] 列标题可点击排序
    - [x] Row 渐入动画
  - [x] server.ts 增强:
    - [x] `/api/sources` — 获取可用数据源元数据
    - [x] `/api/jobs?source=X&sortBy=posted_date&timeRange=1h` — 多维筛选
    - [x] `/api/jobs/stats?source=X` — 按源统计 + hourlyActivity 数据
    - [x] `/api/jobs/duplicates` — 跨平台重复岗位列表
    - [x] `/api/trigger` body 支持 `{ timeFilter: "r3600" }`

## 数据库架构 (Schema Separation)

```
PostgreSQL: job_orchestrator (port 5433)
├── src_linkedin.jobs     ← LinkedIn 爬虫数据
├── src_devitjobs.jobs    ← DevITJobs.uk API
├── src_reed.jobs         ← Reed API
├── src_jooble.jobs       ← Jooble API
├── src_hn_hiring.jobs    ← HN Who is Hiring
├── src_remoteok.jobs     ← RemoteOK JSON Feed
├── public.content_index  ← 跨平台 content_hash 关联
└── public.jobs_all       ← UNION ALL VIEW (统一查询)
```

## LinkedIn 时间筛选策略
| 策略 | 时间代码 | 说明 |
|------|----------|------|
| **默认 (multi-pass)** | r3600 → r86400 | 先获取 1h 内最新岗位 → 再获取 24h 完整数据 |
| 前端可选 | r3600 / r21600 / r86400 / r604800 / r2592000 | 1h / 6h / 24h / 1w / 1m |
| 排序 | sortBy: "DD" | 始终按发布时间降序 (最新优先) |

## Webshare 代理策略
| 层级 | 目标平台 | 代理 |
|------|----------|------|
| LinkedIn | LinkedIn Guest API | ❌ Cookie 直连 |
| API Sources | DevITJobs, Reed, Jooble, HN, RemoteOK | ❌ API 直连 |
| Phase 2 ATS | Greenhouse, Lever, Ashby 等 | ❌ 公开页面 |
| Phase 3 ATS | Workday, iCIMS, Taleo | ✅ Webshare + Camoufox |

---

## v2.2: 架构治理 + Skills 安装 + 规则强化 (2026-03-25)

### 目录结构评估与决策
- [x] 完成全仓审计（结构、职责边界、前后端耦合度）
- [x] **决定不做 monorepo 拆分** — 当前项目是单 package Express + 纯静态 HTML，强行拆成 `apps/web` + `apps/api` + `packages/shared` 属于 AGENTS.md 禁止的"无收益过度拆分"
- [x] 采用"原地分层 + 文档明确边界"策略

### 后端逻辑分层 ✅ (2026-03-25)
- [x] **`src/shared/`** — 跨模块共享（config.ts, types.ts, errors.ts）
- [x] **`src/lib/`** — 基础设施（logger.ts, progress.ts, utils.ts）
- [x] **`src/ingest/`** — 数据采集引擎（linkedin-scraper.ts, job-parser.ts, dedup.ts, session-manager.ts, ats-scraper.ts, stealth-browser.ts, linkedin-job-detail.ts）
- [x] **`src/db/`** — 数据库层（client.ts, migrate.ts, schema-router.ts, migrations/）
- [x] **`src/sources/`** — 多源适配器（adapter.ts, orchestrator.ts, devitjobs.ts, reed.ts, jooble.ts, hn-hiring.ts, remoteok.ts, govuk-sponsor.ts）
- [x] **`src/server.ts`** — Express 装配入口（仅做路由注册与中间件挂载）
- [x] **`src/index.ts`** — LinkedIn CLI 入口
- [x] 所有 import 路径更新（28 个文件，含测试）
- [x] `tsc --noEmit` 零错误
- [x] 所有 API 端点验证通过（/api/status, /api/sources, /api/jobs, /api/jobs/stats, /api/jobs/duplicates, /api/trigger）

### 前端 ES 模块化 ✅ (2026-03-25)
- [x] `public/app.js` 从 290 行单文件拆分为 ES module 组织：
  - `lib/constants.js` — 源元数据 + 颜色 token
  - `lib/utils.js` — 时间格式、DOM 辅助
  - `lib/dom.js` — DOM 引用注册表
  - `features/jobs/jobs.js` — Jobs 表渲染 + 数据获取
  - `features/sources/sources.js` — Source tabs + 数据源分布
  - `features/analytics/analytics.js` — 统计汇总
  - `features/analytics/chart.js` — 24h 活动图表
  - `features/progress/progress.js` — SSE 进度流 + 状态徽章
  - `features/controls/controls.js` — 触发 / 调度 / 筛选事件
- [x] `app.js` 简化为 ~55 行薄编排器（import + state + init）
- [x] `index.html` 更新为 `<script type="module">`
- [x] 浏览器零控制台错误验证通过
- [x] Dashboard 全功能正常（stats / chart / table / tabs / trigger / SSE）

### Agent Skills 安装
- [x] `.agents/skills/` 统一路径（6 个技能完整安装）：
  - `no-ai-dashboard-ui` — 压制 AI 生成感
  - `jobs-dashboard-patterns` — dashboard 页面模式
  - `dense-data-table` — 数据表高密度规范
  - `source-filters-and-analytics` — 控制区 + 分析区规范
  - `db-schema-viz-patterns` — 数据结构可视化规范
  - `safe-page-refactor-review` — 安全页面重构审查

### AGENTS.md 规则强化
- [x] 根目录 AGENTS.md 已包含完整规则体系

### 当前目录结构
```
.
├── AGENTS.md                 ← 全局规则（已完善）
├── PROJECT_PROGRESS.md       ← 项目进度
├── .agents/skills/           ← 6 个项目级技能
├── public/                   ← 前端（纯静态 ES Modules）
│   ├── AGENTS.md             ← 前端规范
│   ├── index.html            ← 页面结构
│   ├── index.css             ← 样式 + design tokens
│   ├── app.js                ← 薄编排器入口 (~55 lines)
│   ├── lib/                  ← 共享前端基础设施
│   │   ├── constants.js      ← 源元数据 + 颜色
│   │   ├── utils.js          ← 时间格式等
│   │   └── dom.js            ← DOM 引用注册
│   └── features/             ← 功能模块
│       ├── jobs/             ← 表格渲染 + 数据
│       ├── sources/          ← Source tabs + breakdown
│       ├── analytics/        ← 统计 + 图表
│       ├── progress/         ← SSE 进度流
│       └── controls/         ← 触发 / 调度 / 筛选
├── src/                      ← 后端（分层 TypeScript）
│   ├── server.ts             ← Express 装配入口
│   ├── index.ts              ← LinkedIn CLI 入口
│   ├── shared/               ← 跨层共享
│   │   ├── config.ts
│   │   ├── types.ts
│   │   └── errors.ts
│   ├── lib/                  ← 基础设施
│   │   ├── logger.ts
│   │   ├── progress.ts
│   │   └── utils.ts
│   ├── ingest/               ← 数据采集引擎
│   │   ├── linkedin-scraper.ts
│   │   ├── job-parser.ts
│   │   ├── linkedin-job-detail.ts
│   │   ├── dedup.ts
│   │   ├── session-manager.ts
│   │   ├── ats-scraper.ts
│   │   └── stealth-browser.ts
│   ├── db/                   ← 数据库层
│   │   ├── client.ts
│   │   ├── migrate.ts
│   │   ├── schema-router.ts
│   │   └── migrations/
│   ├── sources/              ← 多源适配器
│   │   ├── adapter.ts
│   │   ├── orchestrator.ts
│   │   ├── devitjobs.ts / reed.ts / jooble.ts / hn-hiring.ts / remoteok.ts
│   │   └── govuk-sponsor.ts
│   └── __tests__/
├── scripts/                  ← 一次性 / 维护脚本
├── docker-compose.yml
├── Dockerfile
└── package.json
```

### Skill-Driven UI 重构 ✅ (2026-03-26)
按 6 个 skills 驱动的前端视觉与信息架构重构：
- [x] **`no-ai-dashboard-ui`** — 全局 token 重置：去渐变/glow/shimmer/pill/彩色 KPI/pulse 动画
- [x] **`jobs-dashboard-patterns`** — stats 行紧凑化、card title 去 emoji 改 uppercase、首屏密度提升
- [x] **`dense-data-table`** — td padding 压缩、去 staggered animation、source badge 方角中性色
- [x] **`source-filters-and-analytics`** — tabs→segmented control、time-btn 去 glow、chart 灰化、sidebar bars 中性
- [x] **`safe-page-refactor-review`** — 最终 review 验收文档输出
- [x] `db-schema-viz-patterns` — 确认本轮不涉及（无 schema 页面）

改动文件：`index.css`（全量重写）、`index.html`（结构调整）、`features/jobs/jobs.js`、`features/sources/sources.js`、`features/analytics/chart.js`

### 后续待办
- [ ] **路由层提取**：从 `server.ts` 提取路由到 `src/routes/` 目录
- [ ] 表格排序方向指示器（`▲/▼` 替代 `↕`）
- [ ] Start/Stop 按钮颜色进一步克制
- [ ] 移动端 responsive 验证
- [ ] 当项目需要 React/Vite 时，执行 `apps/web` 物理分离


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
| API Sources | DevITJobs, Reed, HN, RemoteOK | ❌ API 直连 |
| Jooble /desc/ | Jooble 详情页外链解析 | ✅ Webshare 住宅代理 (最小带宽) |
| Phase 2 ATS | Greenhouse, Lever, Ashby 等 | ❌ 公开页面 |
| Phase 3 ATS | Workday, iCIMS, Taleo | ✅ Webshare + Camoufox |

### Jooble Webshare 集成 (2026-03-27)
- **搜索页**：本地 CDP Chrome（不消耗代理流量）
- **/desc/ 页**：Webshare 住宅代理 + 最小带宽（`JOOBLE_DESC_MINIMAL_BANDWIDTH=1`）
  - 拦截 images/CSS/fonts/media（`attachMinimalBandwidthRoutes`）
  - 仅运行 `JOOBLE_APPLY_ONLY_SCRIPT`（不拉 JD/公司/薪资长文本）
  - `omitHtml: true`（不传整页 HTML 到 Node）
- **代理选择**：
  - 通过 `proxy_list_download_token` 获取正确的 `host:port:user:pass` 格式
  - 住宅代理端口 80（不是 API list 返回的 10000）
  - 自动尝试 5 个代理槽（`rgzrbzwz-N`），跳过不可达的
  - Tunnel failure 检测：连续 2 次隧道失败立即停止，节省带宽
  - CF 连续封锁 3 次也停止
- **结果**：18 岗位中 10 个获得真实外链（ev.careers, greenhouse.io, gd.com 等）

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

### Webshare 并行探测（2026-03-27）
- [x] `listWebshareBrowserProxies(n)`（`src/lib/webshare.ts`）从 API 拉取多条代理（默认先试 `backbone` 再 `direct`）
- [x] `yarn probe:webshare-parallel` / `scripts/webshare-parallel-jooble-desc.ts`：1 本机 + 3 Webshare 代理上下文，**4 并发** worker 跑 **5 个 URL**（独立 Playwright `browser.newContext({ proxy })`，不占主 CDP 池）
- [x] `yarn probe:webshare-cf` / `scripts/webshare-cf-concurrency-probe.ts`：仅 Webshare 上下文，阶梯并发（默认 1→12）测 Jooble 是否出现 CF 标题/HTML 启发式；**单次实测可到 12 并发仍未触发 CF**（以当时 IP/线路为准）

### Jooble：雇主申请外链 + 过期页（2026-03-27）
- [x] `/desc/` 页不再把 Jooble URL 当作 `apply_url`：从 DOM 中对外链打分选取雇主/ATS 链接（含 `utm_source=jooble` 等）
- [x] `source_url` 固定为 canonical Jooble `/desc/...`；`apply_url` 仅在有合法外链时写入
- [x] 每条职位（可配置上限）拉取 `/desc/` 解析 apply；下架文案（如 “The job position is no longer available”）跳过入库
- [x] 死信扫描补充 Jooble 常见下架英文句式；Jooble 行 **优先探测 `source_url`（/desc/）** 再探测 `apply_url`（下架文案在 Jooble 页，不在雇主站）
- [x] 说明：死信 **仅** 在调用 `POST /api/dead-letter/scan` 时执行，无内置定时任务
- [x] **Jooble 存量外链回填**：`yarn backfill:jooble-apply`（`scripts/backfill-jooble-apply-urls.ts`）对 `apply_url` 为空或仍为 Jooble 域名的行按 `source_url` 重开 `/desc/` 解析雇主 `apply_url`（默认每批 30 条，可 `--limit=` / `--dry-run`）；与线上一致使用 **`withCdpTab` + `scrapeJoobleDescOnPage` 单标签串行**（cf-bypass-scraper：持久会话、降低并行挑战）

### Jooble /desc/ 省带宽（2026-03-27）
- [x] `minimalBandwidth` + `attachMinimalBandwidthRoutes`：拦截 image / stylesheet / font / media；`loadPageWithCfResolution` 支持 **`omitHtml`**（不调用 `page.content()` 把整页 HTML 拉回 Node）
- [x] 环境变量 **`JOOBLE_DESC_MINIMAL_BANDWIDTH=1`** 时批量走省流量路径；页面内用 **`JOOBLE_APPLY_ONLY_SCRIPT`** 只取 apply 相关 DOM
- [x] **`yarn jooble:minimal-apply -- "https://jooble.org/desc/..."`**（`scripts/jooble-minimal-apply-url.ts`）单条 URL 测雇主 `applyUrl`；**不是**「只发一个 HTTP 请求」——主文档与站点所需 JS 仍会计入代理带宽
- [x] `.env.example`：Webshare key 占位；注释 `JOOBLE_DESC_MINIMAL_BANDWIDTH` / `CF_PROBE_MINIMAL_BANDWIDTH`

### Per-Proxy Persistent Context + /away/ 外链提取（2026-03-27）
- [x] **`yarn jooble:webshare-apply`**（`scripts/jooble-webshare-apply-scraper.ts`）：每个 Webshare proxy **独立 `launchPersistentContext`**（cf-bypass-scraper 模式，独立 `--user-data-dir`，`channel: "chrome"`），三阶段 warmup（首页 → 搜索 → /desc/）建立 `cf_clearance`
- [x] **关键发现 1**：Jooble `/desc/` 裸 URL（无 `sid`/`ckey`/`elckey` query 参数）会被 CF/WAF 拦截；**必须带完整 session 参数**才能通过
- [x] **关键发现 2**：Jooble "Apply" 按钮是 `<a href="/away/{id}?...">`，通过 JS 重定向到雇主 ATS；DOM 层面无直接外链。需打开 `/away/` 新 tab → 等 URL 跳出 `jooble.org` → 拿到雇主 URL
- [x] 提取函数 `extractApplyOnlyFromLoadedPage` 已导出，供外部脚本直接调用（不通过 `page.goto()`）
- [x] `isCfBlocked` 从 `cdp-pool.ts` 导出
- [x] `.cdp-profiles-proxy/` 加入 `.gitignore`
- [x] 实测：`direct` persistent context → `https://ev.careers/jobs/311576244-software-engineer?utm_source=jooble` ✓

### Docker 前端集成（2026-03-27）
- [x] **Dockerfile 多阶段构建**：3 个 stage（frontend-builder → backend-builder → runner）
  - Stage 1: `node:22-alpine` + npm ci → `vite build` → 输出到 `/app/public/`
  - Stage 2: `node:22-alpine` + pnpm → `tsc` → 输出到 `/app/dist/`
  - Stage 3: `node:22-bookworm-slim` + Playwright Chromium（Jooble browser adapter 依赖）
- [x] **pnpm-lock.yaml 同步**：补齐 `playwright-extra`、`puppeteer-extra-plugin-stealth` 两个新增依赖
- [x] **.dockerignore 更新**：排除 `node_modules`、`.cdp-profile*`、`.agents`、`tmp` 等
- [x] **HEALTHCHECK 改为 Node fetch**：替代 Alpine wget（Debian slim 无 wget）
- [x] 构建验证通过：`docker compose build app` → `docker compose up app -d` → 健康检查 healthy
- [x] 前端 + API 同容器运行：`http://localhost:3000`（前端 HTML）+ `/api/status`（API）
- [x] 本地 Vite dev server 已停止

### Progress Bar 卡住修复（2026-03-27）
- [x] **Bug**: dispatch 完成后 `isScraping=false`（health poll 显示 "Scrape complete"），但 SSE progress 卡在 `scraping_page`
- [x] **Root cause**: `server.ts` 的 `catch` 块只设 `isScraping=false`，不更新 progress → SSE 永远不推送 "completed"/"error"
- [x] **Fix 1**: 三个 trigger 入口（LinkedIn / multi / scheduled）开始时调 `resetProgress()` 清旧状态
- [x] **Fix 2**: `catch` 块追加 `updateProgress({ stage: "error", message })` 确保前端收到错误态
- [x] **Fix 3**: `ProgressBar.tsx` 增加 8 秒 auto-dismiss（completed/error 后自动隐藏）

### 后续待办（UI）
- [ ] 表格排序方向指示器（`▲/▼` 替代 `↕`）
- [ ] Start/Stop 按钮颜色进一步克制
- [ ] 移动端 responsive 验证

---

## v3.0: 抓取域重构 — 岗位状态机 + 过期判定 + 命令队列 + 多容器隔离

### 架构决策（已定案，2026-03-27）

- 保留 Node.js / TypeScript 主栈，不引入 Python/Celery
- PostgreSQL 唯一真相源，Redis + BullMQ 队列
- 不设计投递/申请/表单执行层
- 短期保留 `src_*` schema 兼容层，中期以 `jobs_current` 为岗位真相表

### 目标容器划分

| 容器 | 职责 | 基础镜像 |
|------|------|---------|
| postgres | 唯一数据源 | postgres:16-alpine |
| redis | BullMQ 队列 + progress pub/sub | redis:7-alpine |
| api | Express API + 前端静态 + 入队（不跑抓取） | node:22-alpine |
| scheduler | cron 定时创建命令（不写业务表） | node:22-alpine |
| worker-general | 轻任务：discover(API源)/verify/dedup/snapshot/expiry | node:22-alpine |
| worker-browser | 重任务：LinkedIn CDP/Jooble CF-bypass/浏览器 verify | node:22-bookworm-slim + Chrome |

### 核心新增表

- `jobs_current` — 岗位标准化真相（job_key UNIQUE, job_status 枚举）
- `job_snapshots` — 内容变化才写
- `crawl_runs` — 每次命令执行记录（task_type, source, evidence_summary 等）
- `source_cursors` — 分页游标与进度跟踪

### 岗位可用性状态

```
active → suspected_expired → expired
active → blocked (CF/authwall/proxy)
active → fetch_failed (网络错误，可重试)
suspected_expired → active (恢复)
blocked → active (解封后)
```

### 命令队列

| 命令 | 路由 |
|------|------|
| discover_jobs | browser(LinkedIn/Jooble) / general(其他) |
| verify_job | browser(需浏览器) / general(HTTP) |
| enrich_job | browser(Jooble /desc/) / general |
| recheck_expiry | general（调度 verify 子命令） |
| refresh_source_cursor | general |

### 过期判定（独立模块，不再 DELETE）

| 平台 | 策略要点 |
|------|---------|
| Reed | 404/410 → expired；timeout → fetch_failed |
| Jooble | CF 页面 → blocked（不是 expired）；"no longer available" → expired |
| LinkedIn | authwall → blocked；404 非 authwall → expired |
| Generic (HN/RemoteOK/DevITJobs) | 单次 missing → suspected；连续 ≥3 → expired |

### 模块目录

```
src/
├── api/           ← HTTP 路由 + DTO（从 server.ts 提取）
├── queue/         ← 命令定义 + worker 注册 + processors
├── domain/
│   ├── job-lifecycle/  ← 状态机 + 迁移规则
│   ├── expiry/         ← 判定器 + 4 平台策略
│   └── dedup/          ← job_key + content_hash + snapshot policy
├── repositories/  ← jobs_current / snapshots / crawl_runs / cursors
├── workflows/     ← discover → verify → snapshot → recheck 编排
├── sources/       ← adapter 不变 + linkedin/ 从 ingest/ 迁入
├── scheduler/     ← node-cron 入口
├── lib/           ← + redis.ts, progress.ts 改 Redis pub/sub
├── shared/        ← 不变
└── db/            ← + 005_job_lifecycle_tables.sql
```

### Phase 1: 数据模型 + 状态语义 ✅ (2026-03-27)
- [x] `005_job_lifecycle_tables.sql`: jobs_current, job_snapshots, crawl_runs, source_cursors
- [x] `src/domain/dedup/job-key.ts` + `content-hash.ts` + `snapshot-policy.ts`
- [x] `src/domain/job-lifecycle/job-status.ts` + `transitions.ts`
- [x] `src/repositories/jobs-repository.ts` + `snapshot-repository.ts` + `crawl-run-repository.ts`
- [x] 修改 `dedup.ts::dedupAndInsert` 双写 `jobs_current`
- [x] **TDD**: 40/40 passed — job-key / content-hash / snapshot-policy / transitions
- [ ] 存量数据回填脚本（Phase 1b，可后续执行）

### Phase 2: 过期判定模块 ✅ (2026-03-27)
- [x] `src/domain/expiry/types.ts` + `expiry-judge.ts` + `evidence-collector.ts`
- [x] 4 个平台策略: `reed-strategy` / `jooble-strategy` / `linkedin-strategy` / `generic-feed-strategy`
- [x] **TDD**: 26/26 passed — 4 strategy classify + ExpiryJudge routing
- [ ] `src/workflows/recheck-workflow.ts`（Phase 2b，需接入 worker processor）
- [ ] 重构 `dead-letter.ts` → 不再 DELETE，改状态迁移（Phase 2b）

### Phase 3: 引入队列和 worker ✅ (2026-03-27)
- [x] `pnpm add bullmq ioredis` + `src/lib/redis.ts`
- [x] `src/queue/commands.ts` + `setup.ts` (dispatch helper + routing)
- [x] `src/queue/general-worker.ts` + `browser-worker.ts` (placeholder processors)
- [x] `src/scheduler/index.ts` (interval-based dispatch)
- [x] **TDD**: 10/10 passed — command routing + queue names
- [ ] 接入真实 adapter 到 processor（Phase 3b）
- [ ] 重构 `progress.ts` → Redis pub/sub（Phase 3b）
- [ ] 重构 `server.ts` → trigger 改为入队（Phase 3b）

### Phase 4: Docker 拆容器 ✅ (2026-03-27)
- [x] `Dockerfile.api` (node:22-alpine, no browser)
- [x] `Dockerfile.worker` (node:22-alpine, general + scheduler)
- [x] `Dockerfile.browser` (node:22-bookworm-slim + Chrome)
- [x] `docker-compose.yml` — 6 容器 (postgres / redis / api / scheduler / worker-general / worker-browser)
- [x] `docker compose config` 验证通过
- [ ] **SDD**: 实际 build + 冷启动验证（需 Docker daemon 运行）

### 验收修复轮 (2026-03-28)
- [x] **P0-1**: upsertJob previousHash 修复为 CTE 先读旧值（snapshot 判定现在基于真实旧 hash）
- [x] **P0-2**: discover_jobs / recheck_expiry worker 接通真实 adapter + expiry judge
- [x] **P0-2**: 未实现命令 (verify_job / enrich_job / refresh_source_cursor) 改为 throw Error（fail fast）
- [x] **P0-3**: server.ts trigger/multi 改为 dispatch-only（不再同步执行抓取）
- [x] **P0-4**: dead-letter DELETE 路径已完全断开，API 改为 `/api/jobs/recheck-expiry` dispatch 新路径
- [x] **P1-1**: transitionStatus 返回 `{ updated: boolean }`，from 不匹配时不再静默
- [x] **P1-2**: scheduler dispatchExpiryChecks 真实实现（查询 suspected_expired / stale active / cooled blocked）
- [x] **P1-3**: Docker compose 资源限制改为 mem_limit/cpus（普通 compose 直接生效）

### 缺陷修复轮 #2 (2026-03-28)
- [x] **缺陷 1**: timeFilter 映射修复 — `resolveMaxAgeDays()` 将 `r86400`/`r604800`/`r2592000` 正确映射为 1/7/30 天，不再 `Number("r86400")` → NaN
- [x] **缺陷 2**: 前端 trigger 流适配 — 移除 `isScraping` 依赖和完成轮询，改为 dispatch 后立即反馈入队数量
- [x] **缺陷 3**: recheck_expiry crawl_run 状态准确性 — `updated=false` 时记为 `cancelled` 而非 `completed`，区分 no_change / 迁移成功 / 迁移期望但未生效

### v3.1 前端平台化 + Docker 部署 (2026-03-28)
- [x] **前端重构为平台化 tabs**: 顶部 navbar 7 个 tab (Overview / LinkedIn / Reed / Jooble / DevITJobs / HN Hiring / RemoteOK)
- [x] **每平台独立面板**: 独立 trigger、stats、jobs table、progress/crawl runs
- [x] **Overview 总览页**: KPI 汇总 + source 分布 + duplicates + latest run per source
- [x] **Progress 按平台分离**: 每个平台页显示自己的 crawl_runs 历史，Overview 显示各平台最近一次 run
- [x] **新增 API 端点**: `GET /api/crawl-runs/latest?source=X`, `POST /api/trigger/source/:source`
- [x] **BullMQ 队列名修复**: `worker:general` → `worker-general` (BullMQ v5 禁止 `:`)
- [x] **旧容器清理 + 6 容器部署**: postgres, redis, api, scheduler, worker-general, worker-browser 全部运行
- [x] **Worker 集成验证通过**: 
  - Reed dispatch → worker-general → crawl_runs completed (400 found, 79 inserted)
  - LinkedIn dispatch → worker-browser → crawl_runs completed (2 inserted)
  - Scheduler 自动 dispatch 6 sources → 全部执行
  - 1048 总 jobs 跨 6 sources
- [x] 移除旧 SourceFilters sidebar, ScrapeControls 多选模式
- [x] 126 tests pass, tsc 0 errors

### 后续待办（v3.0 剩余）
- [ ] verify_job / enrich_job processor 真实实现
- [ ] progress.ts 重构为 Redis pub/sub（跨容器 SSE 实时进度）
- [ ] 存量数据回填 jobs_current
- [ ] 前端 e2e 测试


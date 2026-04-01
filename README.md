# 多源职位聚合（Job Orchestrator）

面向内部使用的 **多数据源岗位采集 + PostgreSQL 存储 + Dashboard** 项目：各数据源通过适配器写入独立 schema，统一视图 `public.jobs_all` 查询；跨平台去重依赖 `content_hash` 与 `public.content_index`。采集策略以 **确定性规则与适配器为主**，必要时再使用浏览器/CDP 等能力。

---

## 核心能力

- **多数据源**：LinkedIn、DevITJobs、Reed、Jooble、Hacker News Who is Hiring、RemoteOK（见下表）。
- **PostgreSQL 分 schema 存储**：`src_*` 表 + `public.jobs_all` 视图 + `public.content_index` 关联索引。
- **去重**：同源 `url_hash` 去重；跨源 `content_hash` 聚类（非「向量化」语义检索）。
- **Dashboard**：`frontend/` 为 Vite + React + Tailwind CSS v4，生产构建输出到 `public/`，由 Express 静态托管并与 API 同端口访问。
- **进度与触发**：SSE `/api/progress/stream`；LinkedIn 单源 `/api/trigger`；多源 `/api/trigger/multi`（支持按适配器能力传递时间过滤）。
- **Cloudflare / 浏览器**：Jooble 等场景可使用 CDP + headless Chrome（详见 `.agents/skills/cf-bypass-scraper/`）；部分 ATS/高防场景可配合 Webshare 代理（见配置）。

---

## 数据源概览

| 数据源 | 主要方式 | 原生时间过滤 | 说明 |
|--------|----------|----------------|------|
| LinkedIn | Guest API + 解析 | 否（爬取侧时间窗 + 本地规则） | 需有效 `li_at` 会话类配置 |
| DevITJobs | JSON/API 路径 | 否 | 适配器侧过滤与缓存 |
| Reed | REST API | 是（`postedWithin` 等） | 需 `REED_API_KEY` |
| Jooble | CDP 浏览器等 | 否 | 可绕 CF；详见适配器与技能文档 |
| RemoteOK | JSON Feed | 否 | 公开数据 |
| HN Hiring | 帖子解析 | 否 | 按月 thread，日期策略见适配器 |

另有 **GOV.UK Sponsor** 等辅助同步（赞助名单等），不作为与上表并列的「岗位 tab 源」展示逻辑的核心六源之一，细节见 `src/sources/`。

---

## 技术栈

| 层级 | 说明 |
|------|------|
| 后端 | Node.js（ESM）、TypeScript、Express 5、`pg` |
| 前端 | React 19、Vite 8、Tailwind CSS 4 |
| 数据 | PostgreSQL 16（迁移脚本在 `src/db/migrations/`） |
| 质量 | Biome、Vitest |

---

## 架构（简图）

```
┌─────────────────────────────────────────────────────────┐
│  Browser：同一端口访问                                    │
│  Express 静态 `public/`（Vite build） + REST `/api/*`      │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  `src/server.ts` — 路由、SSE、任务触发                     │
│  `src/sources/orchestrator.ts` — 多源编排                  │
│  `src/sources/*` — 各源适配器                              │
│  `src/ingest/*` — LinkedIn 流水线、解析、dedup 等          │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  PostgreSQL                                               │
│  `src_<source>.jobs` → `public.jobs_all`                 │
│  `public.content_index`（content_hash）                   │
└───────────────────────────────────────────────────────────┘
```

开发时可在 **`frontend/` 运行 Vite 开发服务器**（默认将 `/api` 代理到 `http://localhost:3000`），与后端分离调试；生产/一体化访问则构建前端并由 Express 提供页面。

---

## 环境要求

- **Node.js** ≥ 18  
- **PostgreSQL**（本地或 Docker；仓库 `docker-compose.yml` 将容器 `5432` 映射到主机 **5433**）  
- 使用 LinkedIn / CDP 相关功能时：**Google Chrome** 在默认或可检测路径（见 `cdp-pool` / ingest 相关代码）

---

## 快速开始

### 1. 克隆与安装依赖

```bash
git clone https://github.com/RickSanchez88E/linkedin-job-scraper.git
cd linkedin-job-scraper
yarn install
cd frontend && yarn install && cd ..
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

按实际环境编辑 `.env`。后端读取的关键项与 `src/shared/config.ts` 一致，常见示例：

```env
# 本地使用 docker-compose 中的 Postgres（主机端口 5433）
DATABASE_URL=postgres://orchestrator:orchestrator@localhost:5433/job_orchestrator

PORT=3000

# LinkedIn（必填用于 LinkedIn 抓取；从浏览器 Cookie 获取 li_at）
LINKEDIN_LI_AT=
# 可选
LINKEDIN_JSESSIONID=

# Reed
REED_API_KEY=

# 可选：Webshare 代理
WEBSHARE_API_KEY=

# 可选：启用数据源列表（逗号分隔）
# ENABLED_SOURCES=linkedin,devitjobs,reed,jooble,hn_hiring,remoteok

# Apply backfill: 每个 scheduler tick 的全局上限（非单平台）
APPLY_BACKFILL_LIMIT=30
# 分平台上限（source:limit,source:limit）
APPLY_BACKFILL_SOURCE_LIMITS=jooble:3,linkedin:4,reed:1,remoteok:1,hn_hiring:8,devitjobs:8
# 需要登录平台 + 当前登录态可用平台
APPLY_LOGIN_REQUIRED_SOURCES=linkedin,reed,remoteok
APPLY_LOGIN_READY_SOURCES=
```

> 若 `.env.example` 与代码不一致，以 **`src/shared/config.ts`** 为准。

### Apply Backfill 调度语义（锁定）

- `APPLY_BACKFILL_LIMIT` 语义已锁定为：**scheduler 每个 backfill tick 的全局 dispatch 上限**。
- 单平台吞吐由 `APPLY_BACKFILL_SOURCE_LIMITS` 控制；scheduler 会在 `enabledSources` 内轮转，禁止调度禁用平台。
- 登录相关状态（`requires_login` / `requires_registration` / `oauth_*`）不再永久排除：仅当 `APPLY_LOGIN_READY_SOURCES` 标记该平台可用时重试，否则进入登录态待处理池（login pending）。

### 3. 数据库迁移

```bash
yarn migrate
```

### 4. 构建前端（由 Express 托管）

```bash
cd frontend && yarn build && cd ..
```

### 5. 启动 API + 静态站点

```bash
yarn dev:server
```

浏览器访问 **`http://localhost:3000`**（端口可由 `PORT` 修改）。

### 开发模式：前后端分离

终端 1：

```bash
yarn dev:server
```

终端 2：

```bash
cd frontend && yarn dev
```

Vite 默认开发端口一般为 **5173**，`/api` 会代理到后端（见 `frontend/vite.config.ts`）。前端开发地址以终端输出为准。

---

## Docker Compose

```bash
docker compose up -d
```

- Postgres：`localhost:5433` → 容器内 `5432`，库名 `job_orchestrator`。  
- 应用服务在 compose 内通过内网连接 `postgres:5432`；若在**宿主机**同时运行 `yarn dev:server`，请使用带 **5433** 的 `DATABASE_URL`。

### Docker CI/CD（稳定发布）

- 已提供 GitHub Actions：`.github/workflows/docker-cicd.yml`
- 已提供自动回滚部署脚本：`scripts/deploy-api-stable.sh`
- 说明文档：`docs/cicd-docker.md`

### Ubuntu / Linux 部署

项目完全兼容 Ubuntu 22.04 / 24.04 原生运行（含 local-browser-worker）。详细指南见 **[`docs/ubuntu-setup.md`](docs/ubuntu-setup.md)**。

---

## 主要 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 爬取状态、计划任务、最近结果摘要 |
| GET | `/api/health` | 健康检查（含 DB 延迟） |
| GET | `/api/sources` | 数据源元数据、时间过滤能力、`timeFilters` 预设 |
| GET/PUT | `/api/config/keywords` | 关键词与地点（持久化至 DB） |
| GET | `/api/progress/stream` | SSE 进度流 |
| POST | `/api/trigger` | 触发 **LinkedIn** 抓取（body 可含 `timeFilter`） |
| POST | `/api/trigger/multi` | 触发 **多源** 抓取（`sources`、`timeFilter` 等） |
| POST | `/api/schedule` | 定时触发 LinkedIn 抓取 |
| GET | `/api/jobs` | 分页列表，`source`、`sortBy`、`timeRange` 等 |
| GET | `/api/jobs/stats` | 汇总统计、按源分布、24h 小时活动 等 |
| GET | `/api/jobs/duplicates` | 跨平台 `content_hash` 重复项 |
| POST | `/api/jobs/recheck-expiry` | 将候选岗位投递到 `recheck_expiry` 队列（状态判定） |
| POST | `/api/dead-letter/scan` | 死信扫描并直接删除已过期岗位（支持定时巡检） |

列表类接口对 `posted_date` 等字段会附加 **`posted_date_precision`**（`day` | `datetime`）与 **`freshness_gap_seconds`** 等计算字段，供前端正确展示与审计。

### 触发示例

LinkedIn：

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d "{\"timeFilter\":\"r86400\"}"
```

多源（具体 `sources` 名称与 `ALL_SOURCE_NAMES` 一致，如 `hn_hiring`）：

```bash
curl -X POST http://localhost:3000/api/trigger/multi \
  -H "Content-Type: application/json" \
  -d "{\"sources\":[\"reed\",\"hn_hiring\"]}"
```

---

## npm 脚本（根目录）

| 脚本 | 作用 |
|------|------|
| `yarn dev:server` | 监听启动 `src/server.ts` |
| `yarn dev` | 监听启动 CLI `src/index.ts`（LinkedIn 侧） |
| `yarn build` | 编译 TypeScript 到 `dist/` |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn test` | Vitest |
| `yarn migrate` | 执行迁移 |
| `yarn db:reset` / `yarn db:fresh` | 数据库重置 / 重置并迁移 |

---

## 仓库目录（要点）

```
├── AGENTS.md                 # 协作与实现规范
├── PROJECT_PROGRESS.md       # 阶段进度与架构说明
├── frontend/                 # Vite + React 源码 → build 到 ../public
├── public/                   # 构建产物（由 Express 托管）
├── src/
│   ├── server.ts             # HTTP 入口
│   ├── index.ts              # LinkedIn CLI 入口
│   ├── shared/               # 配置与类型
│   ├── lib/                  # 日志、进度、工具、CDP/代理等
│   ├── ingest/               # 采集与 dedup
│   ├── db/                   # 客户端、迁移、schema-router
│   └── sources/              # 适配器与 orchestrator
├── scripts/                  # 运维与探针脚本
└── docker-compose.yml
```

---

## Cloudflare 与 CDP（摘要）

对部分需浏览器真实栈的站点，项目可采用 **CDP 连接 Chrome**、独立 profile 等策略减轻 TLS/挑战页问题；细节以代码与 `.agents/skills/cf-bypass-scraper/SKILL.md` 为准。请勿假设单一「万能」绕过方式长期稳定。

---

## 测试与规范

```bash
yarn typecheck
yarn test
```

开发约定见 **`AGENTS.md`**；实现状态与数据库视图说明见 **`PROJECT_PROGRESS.md`**。

---

## License

MIT

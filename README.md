# 🚀 多源职位聚合爬虫系统

自动化多平台职位聚合、去重、智能解析系统，支持 6 个数据源的并行抓取，带有实时 Dashboard 可视化面板。

## ✨ 核心特性

- **6 大数据源支持** — LinkedIn、Reed、Jooble、DevITJobs、RemoteOK、Hacker News Hiring
- **Cloudflare 绕过** — 通过 CDP 池 + headless Chrome 自动突破 Cloudflare Turnstile/JS Challenge
- **实时 Dashboard** — React 前端面板，KPI 统计、来源分布、进度追踪
- **智能去重** — 基于内容哈希 + 向量化的多层去重策略
- **多关键词并行** — 支持多组关键词同时抓取
- **代理轮转** — 集成 Webshare 住宅代理池
- **时间过滤** — 按天数过滤，区分原生 API 过滤 vs 本地后过滤

## 📊 支持的数据源

| 数据源 | 方式 | 时间过滤 | 说明 |
|--------|------|----------|------|
| **LinkedIn** | HTML 解析 | ❌ 后过滤 | 搜索结果页 + 详情页解析 |
| **Reed** | REST API | ✅ 原生 (`postedWithin`) | 需要 API Key |
| **Jooble** | CDP 浏览器 | ❌ 后过滤 | headless Chrome 自动绕过 Cloudflare |
| **DevITJobs** | HTML 解析 | ❌ 后过滤 | 无需认证 |
| **RemoteOK** | JSON API | ❌ 后过滤 | 公开 API |
| **HN Hiring** | HTML 解析 | ❌ 后过滤 | 月度 "Who's Hiring" 帖子 |

## 🏗 系统架构

```
┌─────────────────────────────────────────────┐
│             React Dashboard (3001)          │
│   KPI 面板 | 来源统计 | 进度条 | 暗色主题   │
└─────────────────┬───────────────────────────┘
                  │ REST API
┌─────────────────▼───────────────────────────┐
│          Express 后端 (3000)                │
│   /api/scrape | /api/jobs | /api/progress   │
├─────────────────────────────────────────────┤
│              源适配器层                      │
│  LinkedIn | Reed | Jooble | DevIT | HN | RO │
├─────────────────────────────────────────────┤
│           CDP 浏览器池 (9333)               │
│  headless Chrome · 独立 profile · CF 自动绕过│
├─────────────────────────────────────────────┤
│              SQLite 数据库                   │
│  jobs | jobs_all_view | 去重 | 迁移系统      │
└─────────────────────────────────────────────┘
```

## 🚀 快速部署

### 前提条件

- **Node.js** ≥ 18
- **Google Chrome** 安装在默认路径
- **pnpm** 或 **yarn**（推荐 yarn）

### 1. 克隆项目

```bash
git clone https://github.com/RickSanchez88E/linkedin-job-scraper.git
cd linkedin-job-scraper
```

### 2. 安装依赖

```bash
yarn install
cd frontend && yarn install && cd ..
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# 必需
DATABASE_URL=./data/jobs.db

# 可选 — Reed API
REED_API_KEY=your_reed_api_key

# 可选 — Webshare 代理池
WEBSHARE_API_KEY=your_webshare_key

# 可选 — LinkedIn 需要 Cookie（从浏览器 DevTools 获取）
LINKEDIN_COOKIE=your_li_at_cookie
```

### 4. 启动

```bash
# 后端（端口 3000）
yarn dev:server

# 前端（端口 3001） — 新终端窗口
cd frontend && yarn dev
```

打开浏览器访问 `http://localhost:3001`

### 5. 触发爬取

在 Dashboard 点击"开始爬取"按钮，或通过 API：

```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"keywords":["software engineer","frontend developer"],"location":"United Kingdom"}'
```

## 📁 项目结构

```
├── src/
│   ├── index.ts              # 主入口
│   ├── server.ts             # Express API 服务器
│   ├── db/
│   │   ├── client.ts         # SQLite 连接 + ORM
│   │   ├── migrate.ts        # 自动迁移系统
│   │   ├── schema-router.ts  # 模式路由
│   │   └── migrations/       # SQL 迁移文件
│   ├── ingest/
│   │   ├── linkedin-scraper.ts
│   │   ├── linkedin-job-detail.ts
│   │   ├── job-parser.ts     # AI 解析器
│   │   ├── dedup.ts          # 去重引擎
│   │   ├── session-manager.ts
│   │   ├── ats-scraper.ts    # ATS 自动申请
│   │   └── stealth-browser.ts
│   ├── lib/
│   │   ├── cdp-pool.ts       # CDP 浏览器池（CF 绕过核心）
│   │   ├── logger.ts         # Pino 日志
│   │   ├── progress.ts       # 进度追踪
│   │   ├── utils.ts
│   │   └── webshare.ts       # 代理配置
│   ├── sources/
│   │   ├── adapter.ts        # 源适配器接口
│   │   ├── orchestrator.ts   # 多源编排器
│   │   ├── reed.ts
│   │   ├── jooble.ts
│   │   ├── jooble-browser.ts # CDP 浏览器爬取
│   │   ├── devitjobs.ts
│   │   ├── remoteok.ts
│   │   ├── hn-hiring.ts
│   │   └── govuk-sponsor.ts
│   └── shared/
│       ├── config.ts
│       ├── types.ts
│       └── errors.ts
├── frontend/                  # React Dashboard
│   ├── src/
│   │   ├── App.tsx
│   │   └── index.css
│   └── package.json
├── scripts/                   # 工具脚本
├── AGENTS.md                  # AI Agent 开发规范
└── PROJECT_PROGRESS.md        # 开发进度追踪
```

## 🔐 Cloudflare 绕过方案

本系统使用 **CDP 浏览器池**技术绕过 Cloudflare Turnstile/JS Challenge：

1. 启动 headless Chrome，使用**独立 `user-data-dir`**（不影响你日常 Chrome）
2. Playwright 通过 CDP 连接 Chrome 进程
3. Chrome 原生 TLS 指纹（JA3）完美匹配 — CF 无法区分自动化 vs 手动浏览
4. `cf_clearance` Cookie 在 Chrome 进程内**自动续期**

> ⚠️  已验证失效的方案：`curl_cffi` TLS 模拟（JA3 不匹配）、Playwright Stealth（CDP 协议检测）、Cookie 注入到 HTTP 客户端（JA3 绑定）

## 🧪 运行测试

```bash
yarn test
```

## 📝 开发规范

- TypeScript strict 模式
- 所有代码变更必须通过 `tsc --noEmit` 检查
- 遵循 `AGENTS.md` 中的 AI 辅助开发规范
- Pino 结构化日志

## 📜 License

MIT

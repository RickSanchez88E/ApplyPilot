# Master Rebuild Prompt（整仓重构 + 技能安装 + 长期规则落地）

你现在在我的项目仓库中工作。请不要只做局部补丁，也不要只给建议；请直接按照下面的目标，对当前项目做**一轮完整的架构重构、目录重组、规则落地与前端治理**。本次任务优先追求：**职责清晰、前后端分离、UI 去 AI 味、后续可维护性增强**。

---

## 一、强制先读
开始任何修改前，必须先读取并吸收以下文件：
- 根目录 `AGENTS.md`
- 根目录 `PROJECT_PROGRESS.md`
- 如存在：前端目录局部 `AGENTS.md`
- 如存在：`.agents/skills/` 下所有 `SKILL.md`

不允许跳过这些上下文文件。

---

## 二、我的目标
当前项目虽然已经有多数据源、schema separation、interactive dashboard 等能力，但**文件夹骨架没有做好前后端边界**，而且前端存在明显“AI 自动生成 demo 风”的问题。你需要完成以下四件事：

1. **重构项目目录**
   - 把当前项目整理成更清晰的前后端分离结构
   - 保留现有功能和行为，不要为了重构而改需求
   - 优先把 UI、API、ingest/source adapters、DB、shared contracts 分开

2. **安装项目级 agent skills**
   - 统一使用 `.agents/skills/`
   - 不使用 `.claude/skills/`
   - 这样兼容 Antigravity，也尽量兼容其他模型代理工作流

3. **升级长期规则**
   - 若有权限，直接更新根目录 `AGENTS.md`
   - 若已有前端目录，则新增或更新该目录下的 `AGENTS.md`
   - 强化多数据源 dashboard、heuristic-first、UI guardrails、目录职责边界

4. **开始按新规则治理前端**
   - 不必一次重写全部页面
   - 但至少把项目骨架改成以后容易持续重构 UI 的形态
   - 去掉 AI 味审美方向，统一成成熟 SaaS / internal tool 风格

---

## 三、项目事实（必须当成硬约束）
本项目不是普通官网，而是 **Multi-Source Job Orchestrator / Dashboard**。当前阶段已知事实如下：

- 当前阶段：**Multi-Source v2.1 — Schema Separation + Interactive Dashboard**
- DB Migration 004 已完成
- PostgreSQL 有 6 个独立 schema：
  - `src_linkedin.jobs`
  - `src_devitjobs.jobs`
  - `src_reed.jobs`
  - `src_jooble.jobs`
  - `src_hn_hiring.jobs`
  - `src_remoteok.jobs`
- `public.jobs_all` = UNION ALL 统一查询视图
- `public.content_index` = 跨平台 content_hash 关联索引
- 已有交互包括：
  - source tabs
  - 时间范围按钮与下拉
  - 排序下拉
  - 24h activity 柱状图
  - 相对时间显示
  - source progress sidebar
  - 可点列标题排序
  - row 渐入动画
- 后端已有接口：
  - `/api/sources`
  - `/api/jobs`
  - `/api/jobs/stats`
  - `/api/jobs/duplicates`
  - `/api/trigger`

这些业务能力都必须保留。重构时不允许把这些能力搞丢。

---

## 四、目标目录结构（优先靠拢，不强行机械执行）
请评估现有仓库后，尽量将目录整理到接近下面的职责结构。允许根据现有技术栈做微调，但不允许继续前后端混杂。

```text
.
├── AGENTS.md
├── PROJECT_PROGRESS.md
├── .agents/
│   └── skills/
│       ├── no-ai-dashboard-ui/
│       │   └── SKILL.md
│       ├── jobs-dashboard-patterns/
│       │   └── SKILL.md
│       ├── dense-data-table/
│       │   └── SKILL.md
│       ├── source-filters-and-analytics/
│       │   └── SKILL.md
│       ├── db-schema-viz-patterns/
│       │   └── SKILL.md
│       └── safe-page-refactor-review/
│           └── SKILL.md
├── apps/
│   ├── web/
│   │   ├── AGENTS.md
│   │   ├── src/
│   │   │   ├── app/ or pages/
│   │   │   ├── components/
│   │   │   ├── features/
│   │   │   ├── lib/
│   │   │   ├── hooks/
│   │   │   ├── styles/
│   │   │   └── api/
│   │   └── ...
│   └── api/
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   ├── ingest/
│       │   ├── adapters/
│       │   ├── db/
│       │   ├── lib/
│       │   └── server.ts
│       └── ...
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types/
│   │   │   ├── schemas/
│   │   │   ├── contracts/
│   │   │   ├── constants/
│   │   │   └── utils/
│   └── ui/   (只有在确有必要时才创建)
├── db/
│   ├── migrations/
│   ├── docs/
│   └── seeds/ (如存在)
├── scripts/
└── docs/
```

---

## 五、执行要求（必须完成）
### 1. 仓库审计
先梳理并总结：
- 当前真实目录结构
- 当前前端入口
- 当前后端入口
- 当前哪些文件混杂了前端 / 后端 / DB / ingest 职责
- 当前哪些页面最有 AI 味
- 当前哪些 API / shared 类型最适合抽到 `packages/shared`

然后不要停，直接进入执行。

### 2. 目录重构
按“最小破坏、清晰边界”的原则：
- 把前端应用迁到 `apps/web`（若已经是前端根，则重命名或保留并说明）
- 把 API / server / route / ingest / adapters 收拢到 `apps/api`
- 把共享类型、zod schema、contracts、source 常量等收拢到 `packages/shared`
- 把 migration / DB 相关资料整理到 `db/`
- 把一次性脚本整理到 `scripts/`

要求：
- 不做无收益折腾
- 不为了追求 monorepo 形式而破坏现有运行方式
- 所有导入路径、脚本命令、package.json scripts、tsconfig paths、构建脚本都要同步修正
- 若发现一步到位风险过高，可先完成逻辑上的清晰分层，再最小迁移目录

### 3. 安装 skills
统一在 `.agents/skills/` 下创建以下目录与文件：
- `no-ai-dashboard-ui/SKILL.md`
- `jobs-dashboard-patterns/SKILL.md`
- `dense-data-table/SKILL.md`
- `source-filters-and-analytics/SKILL.md`
- `db-schema-viz-patterns/SKILL.md`
- `safe-page-refactor-review/SKILL.md`

这些 skill 必须使用简体中文编写，并强绑定本项目上下文：
- 六个独立 source schema
- `public.jobs_all`
- `public.content_index`
- source tabs
- time filters
- sort controls
- hourly activity
- duplicates review
- source metadata
- trigger / refresh 状态反馈

### 4. 更新 AGENTS 规则
- 若有权限，直接更新根目录 `AGENTS.md`
- 若已有前端目录，则新增或更新 `apps/web/AGENTS.md` 或实际前端目录下的 `AGENTS.md`
- 保留已有 heuristic-first、安全、进度同步等规则
- 新增：
  - UI 不是官网而是高密度 dashboard
  - 禁止 AI demo 风
  - 前端改动默认策略
  - 目录与职责边界默认目标
  - Dashboard 领域强制准则
  - 前端输出补充模板
  - `.agents/skills/` 作为唯一技能路径

### 5. 前端治理（至少做骨架级处理）
在不大改业务逻辑的前提下，至少完成以下骨架治理：
- 把 dashboard 相关页面 / 组件按 feature 或 domain 组织
- 把 table / filters / stats / charts / source-related UI 从杂乱目录中整理出来
- 为以后持续 UI 重构创造清晰结构
- 如果现有 UI 明显是“全局页面堆组件”，至少拆出：
  - `features/jobs`
  - `features/sources`
  - `features/analytics`
  - `features/duplicates`
- 不要求一次把所有样式都改完，但至少要让后续重构可持续进行

### 6. 保护行为不变
必须保留或验证以下行为：
- `/api/jobs`
- `/api/jobs/stats`
- `/api/jobs/duplicates`
- `/api/sources`
- `/api/trigger`
- source/timeRange/sort 联动
- 相对时间显示
- stats / hourly activity 展示
- 多 source 数据的聚合查询能力

### 7. 验证
必须完成至少这些验证：
- 依赖安装 / 构建 / lint / typecheck（按项目可行项）
- 前端可启动
- API 可启动
- 至少关键接口能跑通
- 关键页面不白屏
- 导入路径无明显断裂

### 8. PROJECT_PROGRESS.md 更新
重构完成后，更新 `PROJECT_PROGRESS.md`，新增一节明确记录：
- 目录重构完成情况
- apps/web / apps/api / packages/shared / db / scripts 的落地情况
- `.agents/skills/` 已安装
- AGENTS 规则已强化
- 尚未完成的后续 UI 重构点

---

## 六、前端视觉硬约束
本项目前端在后续一切改动中，必须遵守以下方向：
- 成熟 SaaS / internal tool / admin 风格
- 高信息密度，但不能乱
- 中性色为主，品牌色克制点缀
- 先解决信息组织，再谈视觉 polish
- source tabs / filters / table / stats / chart / sidebar 必须属于同一设计语言
- 不要大面积渐变
- 不要泛滥毛玻璃
- 不要霓虹发光
- 不要超级大圆角
- 不要厚重阴影
- 不要把数据表格做成卡片墙
- 不要 marketing hero 风格标题区
- 不要那种一眼就是 AI 自动生成的演示页面感

---

## 七、执行方式
- 不要只输出计划
- 直接开始审计、迁移、安装、更新、验证
- 遇到高风险点，允许先做“最小安全迁移”，但必须说明原因
- 除非确实阻塞，否则不要停下来问我小问题
- 尽量完成整轮闭环

---

## 八、最终汇报格式
完成后请输出：

1. 目标
2. 现状审计摘要
3. 新目录结构
4. skills 安装路径与每个 skill 的作用
5. AGENTS 规则更新摘要
6. 迁移与改动结果
7. 验证结果
8. 剩余风险与下一步建议

如果某些目录迁移暂时没有做成，也要明确说明为什么。

---
name: jobs-dashboard-patterns
description: 当任务涉及 jobs dashboard、jobs list、source overview、duplicates、stats、activity、refresh/trigger 状态区等页面与模块时自动触发；用于强制使用适合本项目的页面结构与信息组织模式。
version: 1
---

# jobs-dashboard-patterns

## 目标
为本项目的多数据源岗位聚合产品提供稳定的 dashboard 页面模式，避免每次生成页面都走向演示稿式 UI。

---

## 绑定项目事实
本项目当前核心语义：
- 六个独立 source schema
- `public.jobs_all` 为统一查询层
- `public.content_index` 为跨平台 content_hash 关联索引
- 已有核心接口：
  - `/api/sources`
  - `/api/jobs`
  - `/api/jobs/stats`
  - `/api/jobs/duplicates`
  - `/api/trigger`

页面与模块生成时必须反映这些事实，而不是把它们抽象成模糊“数据流”。

---

## 默认页面骨架
当创建或重构 dashboard 类页面时，优先考虑如下层次：

### 第一层：标题与状态
- 页面标题
- 当前数据范围 / source scope
- 最近刷新时间 / crawl time / last updated
- 触发动作（如 refresh / trigger crawl）

### 第二层：控制区
- source tabs
- time range filter
- sort controls
- quick filters
- 必要时的 search / duplicate toggle / source scope switch

### 第三层：紧凑 summary
- total jobs
- active sources
- duplicates count
- latest crawl freshness
- 当前范围下的 activity 概览

### 第四层：主内容区
优先采用以下之一：
- jobs table 主表
- duplicates review 主表
- source comparison 主表
- recent ingest / activity 主视图

### 第五层：补充区
- 侧边 source breakdown
- 当前过滤条件解释
- source metadata
- 触发结果 / error / status feedback

不要把所有内容都摊平成同权重卡片。

---

## 本项目推荐页面模式

### 1. 多 source 总览页
适用于总 dashboard：
- 顶部状态 + 控制区
- 紧凑 summary
- activity / source distribution
- 下方 jobs table

### 2. 单 source drilling 视图
适用于深入某个 source：
- source header
- source metadata
- 当前 source 的 stats
- source-specific job list
- freshness / ingest activity

### 3. duplicates review 视图
适用于跨平台重复岗位审查：
- duplicate 总数
- content_hash 维度说明
- grouped duplicates table / expandable rows
- source 对比清楚，不要做成花哨卡片

### 4. activity / ingest 视图
适用于查看爬取与活动节奏：
- time filter
- hourly activity
- recent trigger status
- source contribution breakdown

### 5. schema / lineage 入口
适用于展示数据结构：
- source schemas
- `public.jobs_all`
- `public.content_index`
- route / aggregation relationship

---

## 信息组织规则
页面生成时优先保证：
1. 浏览效率
2. 对比效率
3. 排序与筛选理解成本低
4. 首屏可见信息量足够
5. 桌面端不故意做稀疏布局
6. 移动端折叠要合理，但不能牺牲核心路径

---

## 领域语言（优先使用）
在文案、变量命名、模块命名、组件命名中，优先使用本项目已有领域语言：
- source
- crawl time
- posted date
- duplicates
- content_hash
- schema
- hourly activity
- time filter
- latest first
- source metadata
- refresh / trigger
- freshness

避免使用营销型或空泛型命名。

---

## 生成页面时的禁止项
- 把 dashboard 变成卡片墙
- 把关键控制区埋得很深
- 用大量装饰组件稀释 jobs table
- 用“探索、洞察、智能引擎”等概念词替代清晰业务含义

---
name: db-schema-viz-patterns
description: 当任务涉及 schema diagram、data lineage、source relationship、database visualization、content_hash mapping、jobs_all 关系图、content_index 关联图时自动触发；用于生成专业、克制、工程化的数据结构可视化。
version: 1
---

# db-schema-viz-patterns

## 目标
当需要可视化本项目的数据结构时，确保输出的是 **专业工程图 / lineage 图 / source-to-view 映射图**，而不是 AI 感很强的炫技信息图。

---

## 绑定项目数据结构
本项目当前核心结构：
- 六个独立 source schema：
  - `src_linkedin.jobs`
  - `src_devitjobs.jobs`
  - `src_reed.jobs`
  - `src_jooble.jobs`
  - `src_hn_hiring.jobs`
  - `src_remoteok.jobs`
- `public.jobs_all`：统一聚合查询视图
- `public.content_index`：跨平台 `content_hash` 关联索引
- schema router 按 source 路由查询
- duplicates / cross-platform relation 基于 content_hash 语义展开

任何图示都必须忠实表达这些关系。

---

## 推荐可视化类型
根据任务选择最合适的形式：

### 1. ERD-like 结构图
适合展示：
- schema
- 表
- 关键字段
- 关系方向

### 2. lineage flow
适合展示：
- source ingestion
- routing
- aggregation
- `jobs_all` 查询汇总

### 3. source-to-view mapping
适合展示：
- 各 source 表如何流向统一视图
- 哪些字段在 shared contract 中被统一

### 4. duplicate / content_hash relationship visualization
适合展示：
- `public.content_index`
- cross-platform duplicate linking
- content_hash 的中心作用

---

## 风格要求
必须工程化、专业、克制：

### 允许
- 中性色背景
- 清楚的结构线
- 有层级的节点
- 可读的标签
- 规则化对齐
- 简洁的 legend（如确有必要）

### 禁止
- neon
- glow
- futurism
- marketing infographic
- 粗暴渐变
- 过多 3D 感
- 无意义图标堆砌
- “AI generated architecture art” 风格

---

## 信息优先级
生成图时优先突出：
1. schema 名称
2. 关系类型
3. 查询 / 聚合方向
4. 去重逻辑
5. source 边界
6. shared / public 层的角色

不要让装饰抢走关系本身的可读性。

---

## 图形布局原则
- 源头 source schemas 尽量平行排列
- `public.jobs_all` 应作为聚合层清楚居中或居上
- `public.content_index` 应以“关联 / 索引 / 去重辅助层”身份清楚表达
- 箭头方向必须一致
- 文案要使用真实对象名称，不要用抽象彩色模块替代

---

## 结合仓库栈
如果仓库已有图表库 / SVG / Mermaid / React Flow / D3 / 原生 HTML/CSS 实现：
- 优先使用现有基础设施
- 不为一个图引入整套新技术
- 选择最稳定、可维护、可解释的实现

如果只是做静态解释图：
- 优先简单、可读、易维护
- 不要为了“酷”引入复杂依赖

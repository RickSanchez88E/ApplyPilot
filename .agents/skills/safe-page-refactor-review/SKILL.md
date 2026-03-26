---
name: safe-page-refactor-review
description: 手动触发。用于在不破坏业务逻辑、API contract、路由和字段语义的前提下，审查并重构当前页面，使其从 AI demo 风转向成熟数据产品风格。
version: 1
disable-model-invocation: true
---

# safe-page-refactor-review

## 目标
本技能用于对页面做**安全的、可解释的、最小必要的 UI 重构与审查**，特别适合：
- 页面明显很丑
- 页面 AI 味很重
- 组件风格割裂
- 信息密度低
- dashboard 结构像 demo 而不像产品

---

## 使用方式
建议手动触发，例如：
- `/safe-page-refactor-review apps/web/src/...`
- “请使用 safe-page-refactor-review 审查并重构 jobs dashboard 列表页”

---

## 工作流
### 1. 先读
在改动前，先读取：
- 根目录 `AGENTS.md`
- `PROJECT_PROGRESS.md`
- 前端目录局部 `AGENTS.md`（如有）
- 当前页面
- 相关组件
- 相关 hooks / API usage / types

### 2. 先总结问题
必须区分：
- 视觉问题
- 结构问题
- 信息层级问题
- 控件组织问题
- 表格与图表割裂问题
- AI 味体现在哪

### 3. 再做改动
默认约束：
- 保持 API contract 不变
- 保持数据流不变
- 保持路由行为不变
- 保持字段语义不变
- 保持数据库语义不变
- 优先做最小必要重构
- 不擅自重写整个前端

### 4. 改完后 review
必须输出：
- 为什么之前丑
- 为什么之前像 AI 做的
- 现在为什么更像成熟产品
- 哪些是视觉层改动
- 哪些是结构层改动
- 哪些点后续仍值得继续整理

---

## Review 维度
每次审查至少覆盖：

1. AI 味程度
2. 信息密度
3. 组件一致性
4. 筛选效率
5. 表格可扫描性
6. 图表与表格风格一致性
7. loading / empty / error state 的专业程度
8. 响应式表现
9. a11y 基本可读性

---

## 触发停止条件
若你发现需要大改以下内容，先停止并说明，不要直接重写：
- API 结构
- 页面路由体系
- 数据模型语义
- 共享 contracts
- 大规模状态管理架构

此技能用于**安全重构**，不是“借机推倒重来”。

---

## 输出模板
建议最终使用如下结构：

1. 当前页面问题
2. 这次重构的边界
3. 具体改动
4. 为什么现在更专业
5. 验证结果
6. 剩余问题

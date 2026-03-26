---
name: dense-data-table
description: 当任务涉及 jobs table、duplicates table、sortable columns、list density、table refactor、table styling、sticky header、loading/empty state 时自动触发；用于保证数据表高密度、可扫描、克制而专业。
version: 1
---

# dense-data-table

## 目标
规范本项目所有数据表格的视觉与交互，确保 **jobs table / duplicates table / source-related table** 保持真正的数据工具风格，而不是卡片化 demo 风格。

---

## 适用范围
- jobs list
- duplicates review table
- source comparison table
- activity 明细表
- 任何带排序、时间、source、状态字段的列表

---

## 表格总体原则
### 1. 高密度但可读
- 行高紧凑，但不能压迫
- 优先让用户一屏看到更多数据
- 桌面端不故意稀疏

### 2. 层级清楚
默认层级应接近：
- **Job Title** = 主信息
- Company = 次主信息
- Location / Source / Posted Date / Crawl Time / Duplicate Status = 辅助信息
- Internal ID / content_hash = 低权重信息

### 3. 像真正的数据表工具
- sticky header 优先
- 排序状态明确
- hover 清楚但克制
- 分隔轻量
- 不要伪装成卡片列表

---

## 列设计原则（本项目特化）
典型 jobs table 里，优先考虑这些列权重：

### 高优先级
- job title
- company

### 中优先级
- location
- source
- posted date
- crawl time

### 条件显示
- duplicate status
- content_hash
- source schema
- normalized company / normalized title（如存在）

### 低优先级
- internal ids
- 原始抓取 debug 字段

---

## 时间展示规则
本项目中时间很关键，建议如下：
- 主要显示相对时间时，同时提供绝对时间 tooltip 或次级文本
- `posted date` 与 `crawl time` 必须语义清楚，不要混淆
- 若两个时间同时出现，应区分主次，不要视觉权重相同
- 最新优先排序时，必须让用户一眼知道按的是哪个时间维度

---

## source 呈现规则
- source badge 应克制，不要做成鲜艳标签墙
- source 颜色用于辅助识别，不用于制造热闹
- 多 source 对比时，保证 source 视觉编码始终一致
- 若项目已有 source color token，优先复用，不得重新发明一套冲突体系

---

## 排序交互规则
- 点击列头排序时，状态必须清楚
- 升序 / 降序指示不要花哨
- 排序后的视觉反馈偏“数据工具”，不要偏“动画展示”
- 当前排序字段与方向必须容易识别

---

## 文本与截断
- job title 可单行或双行，但应稳定
- company 通常单行
- 长文本截断要保守，必要时配 tooltip
- 空值必须有统一处理方式，如 `—`，不要留白导致用户误判

---

## loading / empty / error
- skeleton 要专业、克制、结构对位清楚
- 不要卡通化 loading
- empty state 不要做插画式宣传页
- error state 要可读、可恢复、可重试

---

## 动效限制
- row fade-in 只能极轻
- 禁止 hover scale、card lift、table transform
- 不要为了“顺滑感”影响批量扫描

---

## 如果项目已有表格库
若仓库已有 TanStack Table / AG Grid / DataGrid / 自研表格基础设施：
- 优先沿用现有表格抽象
- 不要绕开既有排序 / 分页 / 列定义机制
- 规则应贴合现有表格实现，而不是另起炉灶

若没有表格库：
- 用最小、清晰、稳定的 table 结构实现

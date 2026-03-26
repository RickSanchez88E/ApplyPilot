---
name: no-ai-dashboard-ui
description: 当任务涉及 dashboard 页面、列表页、表格、筛选器、侧边栏、统计卡片、视觉重构或 UI polish 时自动触发；用于压制 AI 生成感、营销页感、演示稿感，统一成成熟 SaaS / internal tool 风格。
version: 1
---

# no-ai-dashboard-ui

## 目标
本技能用于压制本项目前端中典型的“AI 自动生成页面气质”，避免把 **Multi-Source Job Dashboard** 做成概念稿、营销官网或炫技 demo。

本项目是：
- 高信息密度数据产品
- 多 source 招聘聚合 dashboard
- 需要快速扫描、对比、筛选、排序、判断

本项目不是：
- Landing page
- AI showcase
- 未来感实验页面
- 依靠装饰性视觉吸引注意力的展示稿

---

## 绑定项目上下文
以下模块是本项目的核心 UI，不可被装饰性设计稀释：
- source tabs
- time range filter
- sort controls
- stats summary
- hourly activity
- jobs table
- duplicates review
- source metadata
- trigger / refresh 状态反馈

以下数据结构语义必须在视觉上被尊重：
- 六个独立 source schema
- `public.jobs_all`
- `public.content_index`
- source 间对比与去重逻辑

---

## 禁止的 AI 风格
以下做法默认禁止，除非用户明确要求：

### 1. 背景与色彩
- 大面积廉价渐变背景
- 彩虹色、荧光色、多品牌色混用
- 把 dashboard 做成“多彩发光实验板”

### 2. 表面效果
- 毛玻璃 / 玻璃拟态泛滥
- 发光边框
- neon 描边
- 夸张 hover glow
- 厚重阴影

### 3. 形状与布局
- 超大圆角
- 所有区块一律悬浮卡片化
- 为了“高级感”大量留白导致信息密度过低
- 把表格拆成很多卡片
- 均匀铺满一堆视觉权重相同的模块，导致用户不知道先看哪里

### 4. 文案与标题
- marketing hero 风格大标题
- “AI 驱动、下一代、智能未来”等展示型语气
- 过度吸睛但缺乏信息内容的标题区

### 5. 动效
- 过多无意义的入场动画
- 卡片飞入、漂浮、scale 弹跳
- 为炫技而加的 hover transform
- 任何影响扫描效率的过度动效

---

## 追求的视觉方向
默认应靠拢以下方向：
- 成熟 SaaS
- admin / internal tool
- 数据产品
- 高信息密度但结构清晰
- 中性色主导
- 单一品牌色克制点缀
- 通过 typography、spacing、alignment、grouping 获得专业感，而不是靠特效

### 默认视觉关键词
- neutral
- compact
- structured
- analytical
- operational
- trustworthy
- high signal

---

## 页面组织优先级
做页面时优先考虑：

1. 用户如何最快扫描数据
2. 用户如何快速比较不同 source
3. 用户如何理解当前 time range 与 sort 条件
4. 用户如何看到 stats / activity 与列表之间的关系
5. 用户如何判断 duplicates / freshness / source contribution

不要先想“怎么做得更炫”。

---

## 组件级规则

### source tabs
- 更像专业 segmented control / data scope switcher
- 不像彩色 pills 玩具按钮
- 选中态清楚但克制

### time range / sort controls
- 紧凑
- 对齐统一
- 不要像表单 demo
- 不要把控件做得过于大而稀疏

### stats summary
- 不要做成营销 KPI 板
- 不要每张卡都像首页 hero 数据亮点
- 优先表达可比性、当前范围、业务含义

### sidebar source progress
- 更像 source health / source distribution / ingest contribution
- 不要像游戏经验条
- 色彩必须服务比较，不是服务热闹

### jobs / duplicates table
- 不能伪装成卡片流
- 必须优先扫描效率
- 排序、层级、密度都应服务阅读

---

## 执行方式
当你修改页面时，先简要指出：
1. 当前页面哪里有 AI 味
2. 哪些装饰没有服务信息
3. 这次如何改得更像成熟产品

然后再动手改代码。

---

## 输出风格
最终说明时，应明确：
- 为什么之前的页面“像 AI 做的”
- 现在如何通过信息架构、密度、层级和克制视觉改得更专业

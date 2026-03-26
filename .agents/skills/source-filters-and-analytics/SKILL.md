---
name: source-filters-and-analytics
description: 当任务涉及 source tabs、time range、sort controls、stats summary、hourly activity、sidebar metrics、source progress 等模块时自动触发；用于统一控制区与分析区的交互与视觉语言。
version: 1
---

# source-filters-and-analytics

## 目标
规范本项目中所有“控制区 + 分析区”的外观与交互，使其更像专业 analytics 工具，而不是花哨 demo。

---

## 绑定项目上下文
本项目当前已知关键控制与分析模块：
- source tabs
- 时间筛选按钮（1h / 6h / 24h / 1w / 1m）
- 时间范围下拉
- 排序方式下拉
- 24h Activity 柱状图
- source 彩色进度条 sidebar
- stats summary
- trigger / refresh 状态反馈

这些模块必须服务于：
- source scope 切换
- 时间范围对比
- freshness 判断
- ingest / activity 观察
- 快速排序与决策

---

## 控件总体原则
### 1. 专业，而非玩具感
- source tabs 更像 segmented control / scope switcher
- time range buttons 更像分析工具中的快捷范围切换
- sort dropdown 更像数据工具中的排序选择，而不是表单练习题

### 2. 紧凑、统一
- 控件高度一致
- spacing 统一
- 对齐统一
- 选中状态清楚但不炫

### 3. 不靠颜色堆热闹
- 颜色只用来表达状态或分类
- 不要把所有控件都做成彩色按钮组

---

## source tabs 规则
- 优先强调 source scope，而不是“按钮存在感”
- 选中态可通过底色、边框、下划线或结构变化体现
- 不要做成亮色丸子 pills 墙
- 若有 source 数量 / 计数信息，应低干扰地呈现

---

## time range 规则
- 1h / 6h / 24h / 1w / 1m 属于高频操作，应尽量短路径
- 选中逻辑必须明确
- 当前范围应影响 stats / activity / list 的解释文案
- 不要让用户搞不清当前页面显示的是哪个时间窗口

---

## sort controls 规则
- 当前排序字段与方向必须明确
- 选项命名要贴业务，如：
  - 最新抓取
  - 最新发布
  - 公司 A-Z
- 不要用空泛或抽象命名

---

## stats summary 规则
- stats 卡片不能做成营销 KPI 板
- 数字层级必须清楚
- label 与辅助说明必须稳定
- 若存在当前过滤范围，应显示其上下文
- 能用微型条形 / 小趋势表达的，不要上复杂装饰

---

## hourly activity 规则
若当前项目继续使用纯 CSS 图表：
- 保持网格、刻度、标签清楚
- 柱体简洁
- tooltip 与标注克制
- 不要依赖艳丽渐变

若项目已有图表库：
- 优先沿用现有库
- 统一图表风格：中性色基底 + 少量分类色
- tooltip、legend、axis 要偏分析工具，而非 showcase

严格禁止：
- 霓虹色柱子
- 玻璃 tooltip
- 发光 grid
- 科幻感图表外观

---

## sidebar source progress 规则
本模块应更像：
- source distribution
- ingest contribution
- source health
- source availability summary

而不是：
- 游戏经验条
- 多彩装饰条
- 营销页配件

呈现时要优先支持：
- source 间比较
- 当前范围理解
- 数据贡献判断

---

## 状态反馈区
trigger / refresh / crawling 反馈时：
- 清楚说明正在发生什么
- 清楚说明影响哪个 source / time filter
- 不要用华而不实的 loading 文案
- 反馈应偏 operational / system status

# frontend/AGENTS.md

## 前端局部规则
- 前端是平台化 dashboard，不是营销页。
- 任何页面改动都要优先保留：
  - source/platform 导航
  - jobs 列表
  - stats / analytics
  - progress / run 状态
  - apply discovery 可视化
- 不要改动既有 API 语义来迁就 UI。
- i18n 默认中英文双语，新增文案必须进入字典，不要硬编码在组件里。
- 平台页互不串台，Overview 只做跨平台视角。
- 表格、过滤器、状态 badge、运行日志卡片要保持高密度和一致性。

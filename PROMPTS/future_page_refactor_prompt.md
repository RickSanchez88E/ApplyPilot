# Future Page Refactor Prompt（后续页面重构专用）

你现在在已经完成目录重构并安装 `.agents/skills/` 的项目中工作。请读取：
- `AGENTS.md`
- `PROJECT_PROGRESS.md`
- `.agents/skills/` 下所有 `SKILL.md`
- 如存在：前端目录局部 `AGENTS.md`

然后对当前目标页面/模块执行一次“成熟数据产品风格”的安全重构，要求：

1. 保留业务逻辑、API contract、路由行为、字段语义不变
2. 优先调用并遵守这些 skills：
   - `no-ai-dashboard-ui`
   - `jobs-dashboard-patterns`
   - `dense-data-table`
   - `source-filters-and-analytics`
   - `db-schema-viz-patterns`（如涉及 schema / lineage / data relationship）
   - `safe-page-refactor-review`（手动 review 时使用）
3. 先输出：
   - 当前页面为什么有 AI 味
   - 哪些属于视觉问题
   - 哪些属于结构问题
4. 然后直接改代码：
   - 提高信息密度
   - 统一 tabs / filters / stats / charts / table / sidebar 的设计语言
   - 去掉廉价 demo 风
   - 让页面更像成熟 SaaS / internal tool
5. 验证：
   - 页面不白屏
   - 核心交互仍可用
   - 无明显 type / import 错误
6. 最终说明：
   - 为什么现在更专业
   - 哪些地方后续还值得继续整理

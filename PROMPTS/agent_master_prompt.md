# Agent Master Prompt

你现在在一个已有长期记忆与协作约束的项目中工作。开始任何分析或改动前，必须按固定顺序读取上下文，不允许跳过。

## 强制读取顺序
1. 根目录 `AGENTS.md`
2. 根目录 `PROJECT_PROGRESS.md`
3. 与当前任务相关的局部 `AGENTS.md`
4. `.agents/skills/*/SKILL.md`
5. 当前任务输入与相关代码

如果仓库存在 `scripts/agent-harness.ts`，优先运行它生成上下文摘要，例如：

```bash
npx tsx scripts/agent-harness.ts --format markdown
```

如果任务聚焦某个子目录，可使用：

```bash
npx tsx scripts/agent-harness.ts --target frontend --task "这里写任务" --format markdown
```

## 强制工作流
你必须按以下顺序工作：
1. 读规则
2. 读长期记忆
3. 读相关代码
4. 再做计划或直接实现
5. 完成后更新 `PROJECT_PROGRESS.md`
6. 最终输出结构化验收结果

## 关键约束
- 不允许跳过 `PROJECT_PROGRESS.md`
- 不允许只做局部 patch 而忽略已锁定架构决策
- 不允许把聊天记录当作长期记忆
- 任何功能闭环、重构、目录迁移、调度变化、浏览器策略变化、Docker 运行方式变化后，必须更新 `PROJECT_PROGRESS.md`

## 最终输出格式
最终回复必须显式区分：
1. 已完成项
2. 未完成项
3. 验证结果
4. 剩余风险

如果是审计/评审，也必须明确：
- 哪些结论已被代码或运行结果证实
- 哪些只是推断

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface CliArgs {
  readonly format: "json" | "markdown";
  readonly target?: string;
  readonly task?: string;
}

interface AgentContext {
  readonly projectName: string;
  readonly repoRoot: string;
  readonly currentPhase: string;
  readonly lockedDecisions: string[];
  readonly currentArchitecture: string[];
  readonly activeModules: string[];
  readonly unfinishedItems: string[];
  readonly activeRisks: string[];
  readonly taskConstraints: string[];
  readonly requiredReadOrder: string[];
  readonly filesRead: string[];
  readonly localAgentFiles: string[];
  readonly skills: string[];
  readonly task?: string;
}

const REQUIRED_READ_ORDER = [
  "AGENTS.md",
  "PROJECT_PROGRESS.md",
  "相关局部 AGENTS.md",
  ".agents/skills/*/SKILL.md",
  "当前任务输入与相关代码",
];

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = readJson<{ name?: string }>(path.join(repoRoot, "package.json"));
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const progressPath = path.join(repoRoot, "PROJECT_PROGRESS.md");
  const rootAgents = readText(agentsPath);
  const progress = readText(progressPath);
  const localAgentFiles = findLocalAgents(repoRoot, args.target);
  const skills = findSkills(repoRoot);
  const progressSections = parseMarkdownSections(progress);

  const context: AgentContext = {
    projectName: packageJson.name ?? path.basename(repoRoot),
    repoRoot,
    currentPhase: firstBullet(progressSections.get("当前状态")) ?? "未声明",
    lockedDecisions: bullets(progressSections.get("已锁定决策")),
    currentArchitecture: bullets(progressSections.get("当前架构")),
    activeModules: bullets(progressSections.get("关键模块现状")),
    unfinishedItems: bullets(progressSections.get("未完成 / 阻塞项")),
    activeRisks: bullets(progressSections.get("当前风险")),
    taskConstraints: deriveTaskConstraints(rootAgents),
    requiredReadOrder: REQUIRED_READ_ORDER,
    filesRead: [agentsPath, progressPath, ...localAgentFiles, ...skills],
    localAgentFiles,
    skills,
    task: args.task,
  };

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    return;
  }

  process.stdout.write(renderMarkdown(context));
}

function parseArgs(argv: string[]): CliArgs {
  let format: "json" | "markdown" = "markdown";
  let target: string | undefined;
  let task: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format" && argv[i + 1]) {
      const next = argv[i + 1];
      if (next === "json" || next === "markdown") format = next;
      i += 1;
      continue;
    }
    if (arg === "--target" && argv[i + 1]) {
      target = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--task" && argv[i + 1]) {
      task = argv[i + 1];
      i += 1;
    }
  }

  return { format, target, task };
}

function findLocalAgents(repoRoot: string, target?: string): string[] {
  if (!target) return [];
  const absoluteTarget = path.resolve(repoRoot, target);
  if (!fs.existsSync(absoluteTarget)) return [];

  const result: string[] = [];
  let current = fs.statSync(absoluteTarget).isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);

  while (current.startsWith(repoRoot) && current !== repoRoot) {
    const agentFile = path.join(current, "AGENTS.md");
    if (fs.existsSync(agentFile)) result.push(agentFile);
    current = path.dirname(current);
  }

  return result.reverse();
}

function findSkills(repoRoot: string): string[] {
  const skillsDir = path.join(repoRoot, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, "SKILL.md"))
    .filter((skillPath) => fs.existsSync(skillPath))
    .sort();
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function parseMarkdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...markdown.matchAll(/^## (.+)$/gm)];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const title = current[1].trim();
    const start = current.index! + current[0].length;
    const end = next?.index ?? markdown.length;
    sections.set(title, markdown.slice(start, end).trim());
  }

  return sections;
}

function bullets(section?: string): string[] {
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function firstBullet(section?: string): string | undefined {
  return bullets(section)[0];
}

function deriveTaskConstraints(agentsMarkdown: string): string[] {
  const constraints: string[] = [];

  if (agentsMarkdown.includes("简体中文")) constraints.push("对用户说明使用简体中文");
  if (agentsMarkdown.includes("PROJECT_PROGRESS.md")) constraints.push("完成闭环后更新 PROJECT_PROGRESS.md");
  if (agentsMarkdown.includes("heuristic-first")) constraints.push("优先 heuristic-first，不以模型替代主流程");
  if (agentsMarkdown.includes("高信息密度")) constraints.push("前端默认是高信息密度 dashboard / internal tool");

  return constraints;
}

function renderMarkdown(context: AgentContext): string {
  const lines = [
    "# Agent Harness Context",
    "",
    `- project_name: ${context.projectName}`,
    `- repo_root: ${context.repoRoot}`,
    `- current_phase: ${context.currentPhase}`,
    "",
    "## required_read_order",
    ...context.requiredReadOrder.map((item) => `- ${item}`),
    "",
    "## locked_decisions",
    ...renderList(context.lockedDecisions),
    "",
    "## current_architecture",
    ...renderList(context.currentArchitecture),
    "",
    "## active_modules",
    ...renderList(context.activeModules),
    "",
    "## unfinished_items",
    ...renderList(context.unfinishedItems),
    "",
    "## active_risks",
    ...renderList(context.activeRisks),
    "",
    "## task_constraints",
    ...renderList(context.taskConstraints),
    "",
    "## local_agent_files",
    ...renderList(context.localAgentFiles),
    "",
    "## skills",
    ...renderList(context.skills),
    "",
    "## files_read",
    ...renderList(context.filesRead),
  ];

  if (context.task) {
    lines.push("", "## current_task", `- ${context.task}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderList(items: readonly string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- 无"];
}

main();

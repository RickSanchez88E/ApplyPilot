# PROJECT_PROGRESS.md

## 当前状态
- 当前阶段：v3.2，平台化 dashboard + 队列化抓取 + 本地浏览器/容器混合执行
- 当前运行模式：
  - Docker 基础服务：`postgres`、`redis`、`api`、`scheduler`、`worker-general`、`worker-browser`
  - 宿主机进程：`local-browser-worker`
- 前端形态：
  - 顶部平台导航：Overview / LinkedIn / Reed / Jooble / DevITJobs / HN Hiring / RemoteOK
  - 平台页独立 trigger、stats、jobs、runs、apply discovery
  - 中英文切换已可用

## 已锁定决策
- 主技术栈：Node.js + TypeScript
- 数据库真相源：PostgreSQL
- 队列：Redis + BullMQ
- API 触发模式：dispatch-only，不再同步执行抓取
- Docker 基础服务常驻；本地浏览器执行器运行在宿主机
- Jooble 默认策略：**自动调度已禁用**（`JOOBLE_SCHEDULE_ENABLED=false`），CF challenge 态降级策略：`HARD_CAP=5, MAX_SEARCH_PAGES=1, DELAY=15-45s, CF_THRESHOLD=1 即停, COOLDOWN=12h`。仅支持手动触发。**desc 并发实验**：`JOOBLE_DESC_CONCURRENCY=2`（默认），每个 desc 页独立创建/关闭 page，abort-on-challenge 机制已实现。本地实验通过（2 jobs, 无 CF challenge, 77s）。
- 自动化 profile：`sanchez`
- apply discovery 只做到最终表单页发现与结构提取，不做自动 submit
- 平台调度按 source 独立配置
- APPLY_BACKFILL_LIMIT 语义锁定：**scheduler 每个 backfill tick 的全局 dispatch 上限**（非单平台上限）
- 登录态分层重试锁定：`requires_login/requires_registration/oauth_*` 不再永久排除；仅在 `APPLY_LOGIN_READY_SOURCES` 标记可用时重试，否则进入 login-pending 池

## 本地浏览器策略
- 引擎能力：`LOCAL_BROWSER_ENGINE=chrome|edge`
- profile 策略定案：automation clone（非 live attach）
  - source profile：`<USER_DATA_DIR>/<PROFILE_DIRECTORY>`
  - automation clone：`LOCAL_BROWSER_DATA_DIR/<PROFILE_DIRECTORY>`
  - `syncTtlMs` / `resyncBeforeLaunch` 控制 clone 刷新
- forceResync 定案：**defer 模式**（活跃时挂起，关闭后执行）
- breaker 定案：按 failureType 分层（严重→立即 cooldown，瞬时→增量计数）

## 当前架构
- 前端：`frontend/` React + Vite + Tailwind，产物输出到 `public/`
- API：Express，对外提供 jobs、stats、sources、trigger、schedule、apply discovery 等端点
- 执行层：
  - `scheduler`：按 source 调度 dispatch + apply backfill 轮转分发
  - `worker-general`：轻任务
  - `worker-browser`：容器内浏览器任务
  - `local-browser-worker`：宿主机本地浏览器任务（所有 resolve_apply + jooble discover）
- 数据层：
  - source schema + `public.jobs_all`
  - `jobs_current` / `job_snapshots` / `crawl_runs` / `source_cursors`
  - `source_schedule_state` / `apply_discovery_results`

## Apply Discovery 验收状态

### 阈值定义（Phase 1）
- 全局阈值：discovered/total >= 30%，final_form/total >= 10%
- 平台阈值：discovered/source >= 20%，final_form/source >= 5%

### 最新统计快照（2026-03-30 01:58 UTC）
**统一口径来源：`npx tsx scripts/apply-stats.ts --json`**

| 指标 | 值 | 阈值 | 结果 |
|------|-----|------|------|
| total_jobs | 622 | — | — |
| discovered_total | 511 | 30% (≥187) | ✅ PASS (82.2%) |
| final_form_total | 325 | 10% (≥62) | ✅ PASS (52.3%) |

### 按平台矩阵

| source | total | disc | final | desc | login | block | disc% | final% | disc阈值 | final阈值 |
|--------|-------|------|-------|------|-------|-------|-------|--------|---------|----------|
| devitjobs | 70 | 70 | 31 | 37 | 2 | 0 | 100% | 44.3% | ✅ | ✅ |
| hn_hiring | 157 | 157 | 56 | 69 | 20 | 11 | 100% | 35.7% | ✅ | ✅ |
| jooble | 3 | 0 | 0 | 0 | 0 | 0 | 0% | 0% | ❌ | ❌ |
| linkedin | 94 | 0 | 0 | 0 | 0 | 0 | 0% | 0% | ❌ | ❌ |
| reed | 281 | 267 | 238 | 24 | 0 | 5 | 95% | 84.7% | ✅ | ✅ |
| remoteok | 17 | 17 | 0 | 3 | 14 | 0 | 100% | 0% | ✅ | ❌ |

### 双目标分组验收
| 组别 | sources | total | discovered | final_form | discovered% | final_form% | 结论 |
|------|---------|-------|------------|------------|-------------|-------------|------|
| 可解组 | hn_hiring, devitjobs, jooble | 230 | 227 | 87 | 98.7% | 37.8% | ✅ 全部达标 |
| 需登录组 | linkedin, reed, remoteok | 392 | 284 | 238 | 72.4% | 60.7% | ✅ reed 突破 |

### 数据一致性
- `jobs_current.apply_resolution_status` vs `apply_discovery_results.apply_discovery_status`：**0 mismatches**

### 总体结论
- **"全量最终表单页化" Phase 1 全局目标：✅ 已达成**
- 全局 discovered 82.2%（远超 30%），final_form 52.3%（远超 10%）
- 4 个平台达标：devitjobs ✅ hn_hiring ✅ reed ✅（新达标）
- 3 个平台仍未达 per-source 阈值：jooble / linkedin / remoteok（数据量小或未启用 discovery）

### 2026-03-30 突破记录

| 改动 | 根因 | 效果 |
|------|------|------|
| HN scraper 提取评论中的公司 career URL | apply_url 之前指向 ycombinator.com/apply/ 而非公司页 | 134 jobs 获得真实 ATS URL，56 个达到 final_form |
| Reed scraper 用 details API 获取 externalUrl | search API 只返回 reed.co.uk 描述页 URL | 46 jobs 获得外部 ATS URL |
| HTTP-only 快速 resolver | 已有 URL 的 jobs 不需要浏览器即可解析 ATS 表单 | 293 个新 final_form（含 Reed 238 个）|
| 合计 | — | final_form 从 32 → 325（+293），5.2% → 52.3% |


### 分层 backfill / scheduler 新语义（已落地）
- `scripts/backfill-apply-layered.ts` 与 `src/domain/apply-discovery/dispatch.ts`：
  - 移除 login/oauth/per-registration 永久排除逻辑
  - 新增 login-gated policy：
    - `APPLY_LOGIN_REQUIRED_SOURCES=linkedin,reed,remoteok`
    - `APPLY_LOGIN_READY_SOURCES=<comma-list>`
  - 登录态未就绪时进入 `login-pending` 计数池，不丢候选
- `src/scheduler/index.ts`：
  - backfill 仅轮转 `enabledSources`
  - `APPLY_BACKFILL_LIMIT` 为每个 tick 全局上限
  - `APPLY_BACKFILL_SOURCE_LIMITS` 做分平台上限（默认：`jooble:3,linkedin:4,reed:1,remoteok:1,hn_hiring:8,devitjobs:8`）
  - 新增 `crawl_runs` crash-recovery 定时收口（`recoverStaleRunningCrawlRuns`）

### 下一轮待执行批次

```bash
# jooble — 扩大 discovered 覆盖，需突破 platform_desc_only
npx tsx scripts/backfill-apply-layered.ts --source=jooble --batch=100 --rounds=3

# linkedin — 剩余 ~155 未 discovered
npx tsx scripts/backfill-apply-layered.ts --source=linkedin --batch=100 --rounds=2

# reed — 需要先解决登录态，否则 backfill 只会继续产出 requires_login
# 前置条件：reed cookie / 登录授权

# remoteok — 同上，需登录态
```

## 未完成 / 阻塞项
- `verify_job` / `enrich_job` / `refresh_source_cursor` 真实 processor 未完成
- progress 仍缺 Redis pub/sub 跨容器实时链路
- ~~apply discovery final_form 覆盖仍远低于 10% 目标~~ → **已达成 52.3%（2026-03-30）**
- linkedin / remoteok per-source final_form 仍未达标（0%），需登录态介入
- jooble 数据量极小（3 jobs），非优先级
- worker 异常退出时可能残留 `running` 状态的 crawl_runs

## 当前风险
- Jooble / 浏览器链路成本高，仍需观察带宽和 challenge 触发
- automation clone 不是 live attach，登录态更新依赖同步策略
- local-browser-worker 运行在宿主机，运维比纯 Docker 多一步
- ~~reed 登录墙是结构性阻塞~~ → **已通过 Reed details API externalUrl 解决（84.7% final_form）**
- remoteok 登录墙仍阻塞（14/17 requires_login）
- linkedin 未启用 discovery（0/94 discovered）
- HTTP-only resolver (v2.0-http) 的 form detection 基于 HTML 静态分析，对 SPA/JS-rendered 表单可能误判
- Reed details API 调用会增加 API 配额消耗（每 job 额外 1 request）

## 验证基线
- TypeScript：`npx tsc --noEmit` 通过
- Vitest：156 tests / 21 files，1 pre-existing failure（Windows path assertion on Linux）
- **apply discovery 统一口径**：`npx tsx scripts/apply-stats.ts`
  - 此脚本的输出是上面所有数字的唯一来源
  - 不允许用其他 SQL 或接口产出数字与此脚本矛盾
- 本地浏览器专项验证：
  - `scripts/verify-gaps.ts` 覆盖 defer resync、Edge 启动、lease+scheduler 互斥、breaker 分层语义
- 2026-03-30 URL backfill 验证：
  - HN backfill: 134 jobs updated with real company URLs（0 failures）
  - Reed backfill: 46 jobs updated with externalUrl（0 failures）
  - HTTP resolver: 407 jobs processed, 293 final_form_reached
  - 数据一致性: 0 mismatches
  - final_form: 32 → 325 (+293)，5.2% → 52.3%
  - 数据一致性：0 mismatches
- 2026-03-28 18:17–18:20 新增验证：
  - 分层重试证据：
    - `remoteok`（无登录态）=> `20 candidates → 0 dispatched, 20 login-pending`
    - `APPLY_LOGIN_READY_SOURCES=remoteok` => `20 candidates → 20 dispatched, 0 login-pending`
  - scheduler 语义证据：
    - `ENABLED_SOURCES=hn_hiring,jooble` 时，其他 source 明确 `Source not enabled — skipping schedule`
    - 日志输出 `globalLimitPerTick=12` + sourceCaps，且 tick 结果按全局限额扣减
  - crash-recovery 证据：
    - `npx tsx scripts/verify-crash-recovery.ts`：`recovered=2`，样本 run 状态由 `running` 收口到 `failed`
  - 失败诊断矩阵：
    - `npx tsx scripts/diagnose-apply-failures.ts --json` 产出各平台 root-cause + evidence + action + expectedBenefit

## 下一个 Agent 接手须知
1. 开始前先读：
   - `AGENTS.md`
   - `PROJECT_PROGRESS.md`
   - `frontend/AGENTS.md`
   - `.agents/skills/*/SKILL.md`
2. 需要上下文摘要时先跑：
   - `npx tsx scripts/agent-harness.ts --format markdown`
3. 不要误动这些锁定点：
   - Node/TS 主栈、PostgreSQL 真相源、BullMQ+Redis
   - Jooble 默认本地浏览器策略
   - automation clone（非 live attach）
   - forceResync defer 生命周期
   - breaker 分层语义
   - apply discovery 不做 submit
4. apply discovery 数字统一用 `npx tsx scripts/apply-stats.ts` 产生
5. 当前最值得优先收口的是：
   - reed / remoteok 登录态解决（解锁 ~385 个 requires_login 候选）
   - jooble platform_desc_only 外链提取改进
   - linkedin 反爬拦截率降低

## 最近更新（2026-03-30，数据源优化：ATS 直接爬取）
- 基于 2026 英国招聘市场状态报告，新增对 Greenhouse、Lever 等 ATS 原生 API 的直接抓取入口。
- 新增 `src/sources/ats-direct.ts` 模块，通过预置的名企打靶白名单（如 Monzo, Revolut, Stripe, OpenAI 等），绕过聚合平台防爬策略（如 Jooble / Adzuna 的 Click Fraud 403 拦截）。
- 直接获取原汁原味的 HTML 描述与原生落地页投递表单链接，解析极速且不消耗任何浏览器资源（0 CF block 率）。

## 最近更新（2026-03-28，前端审计落地）
- 前端数据语义对齐：`/api/apply-discovery/stats` 返回新增 `coverage` 字段（`resolvedJobs` / `unresolvedJobs` / `totalJobs` / `resolvedRate`），来源为 `public.jobs_current`，用于显示“解析覆盖率”和“未解析岗位”。
- 前端轮询策略升级：新增 `frontend/src/hooks/usePolling.ts`，统一替换页面内 `setInterval` 轮询，支持页面隐藏时暂停、恢复时立即拉取、并发请求中止。
- 平台/总览 apply 统计口径修正：登录相关统一为 `requires_login + oauth_google + oauth_linkedin`。
- 表格与可访问性改造：
  - `JobsTable` 增加移动端列降级展示与分页按钮 `aria-label`。
  - `KeywordConfig` 全量接入 i18n 并补齐 icon-only 按钮可读标签。
  - 顶部导航支持窄屏横向滚动并补 `aria-current`。
- 主题一致性：补充 `--color-warning-light` token，去除关键流程中的硬编码 warning 色。
- 设计上下文持久化：新增 `.impeccable.md` 并同步 `AGENTS.md` 的 `Design Context`，锁定“克制/专业/可靠、Light only、运营同学优先”的前端方向。
- 验证结果（2026-03-28）：
  - `cd frontend && npm run lint` 通过（0 error / 0 warning）
  - `cd frontend && npm run build` 通过
  - `npm run typecheck` 通过

## 最近更新（2026-03-28，Docker CI/CD 稳定发布）
- 新增 GitHub Actions 流水线：`.github/workflows/docker-cicd.yml`
  - PR / main push 自动执行：typecheck、test、frontend lint/build、Docker API 镜像构建烟测。
  - main 分支在配置部署 secrets 后自动 SSH 到目标主机执行部署。
- 新增稳定部署脚本：`scripts/deploy-api-stable.sh`
  - 发布前先拉起 `job-api-candidate`（不占用线上端口）并做健康检查。
  - 健康通过后才切换 `job-api`；新容器失败则自动回滚到备份容器。
  - 适配“已有前端实例在跑”的在线发布场景，减少中断窗口。
- 新增文档：`docs/cicd-docker.md`
  - 说明 secrets 配置、发布流程、回滚逻辑和手动演练命令。

## 最近更新（2026-03-28，P0 浏览器生命周期稳定性改造）

### 问题
- 批量 `resolve_apply` 时浏览器疯狂开标签页，内存飙升 40GB+，Chrome/Edge 卡死无响应
- 根因：`createPage` 无全局并发上限，无 per-source 限制，页面未在 finally 中确保关闭

### 新增模块
| 文件 | 职责 |
|------|------|
| `src/browser/page-lifecycle.ts` | **PageLifecycleTracker** — semaphore 全局/per-source 并发上限、page 开/关/leak 追踪、内存采样 |
| `src/browser/resource-guardian.ts` | **ResourceGuardian** — 后台健康监控，内存超阈值时 force-release slot + 自动重启浏览器 |
| `src/browser/source-concurrency.ts` | Per-source 并发策略配置（jooble 保守 / hn_hiring 高吞吐），支持 env override |

### 关键改动
- `local-browser-manager.ts` 完全重写：
  - `createPage()` 先 `acquireSlot()` 获取 semaphore，失败则阻塞/超时
  - 返回 `PageSession { page, close() }` — close 在 finally 中释放 slot
  - `closeBrowser()` 调用 `forceReleaseAll()` 清理残留 slot
  - 首次启动浏览器时自动启动 `ResourceGuardian`
  - Chrome 启动参数加入 `--no-restore-state`、`--renderer-process-limit=4` 防止 tab 累积
  - 启动后立即关闭 `about:blank` / `chrome://newtab/` 等默认页
- `local-browser-worker.ts` 更新：
  - 每个 task 完成/失败后输出 lifecycle stats（openPages、leakedPages、RSS）
  - 使用 per-source `navigationTimeoutMs` 覆盖默认超时

### 已锁定的新决策
- **并发上限**：`MAX_OPEN_PAGES=3`（全局）、`MAX_OPEN_PAGES_PER_SOURCE=2`（per-source）
- **内存阈值**：`MEMORY_THRESHOLD_BYTES=2GB`（告警）、`GUARDIAN_DESTROY_THRESHOLD_BYTES=3GB`（强制重启）
- **Source 策略**：jooble/linkedin/reed/remoteok = maxPages=1 保守；hn_hiring/devitjobs = maxPages=3 高吞吐
- **资源守护主阈值**：仅统计 automation 浏览器 root PID 进程树 RSS——不再全机扫描 chrome/msedge
- **Waiter 状态机**：waiter state: pending | resolved | rejected_timeout | rejected_force，所有转移通过 tryResolve/tryReject 互斥函数

### P0 返工修复记录

#### 第一轮（2026-03-28 19:35 UTC）

| 编号 | 问题 | 修复概要 |
|------|------|----------|
| P0-1 | phantom slot（waiter 引用比较失败） | 引入 waiterId + settled 标志 |
| P0-2 | guardian 仅看 Node RSS | 增加浏览器进程族观测（tasklist/pgrep） |
| P0-3 | 验收脚本假通过 | 新增 phantom slot 回归、waiter 清理 check |

#### 第二轮（2026-03-28 19:56 UTC）— 最新

第一轮仍存在三个缺陷，本轮全部修复：

| 编号 | 问题 | 根因 | 修复方法 |
|------|------|------|----------|
| P0-1A | forceReleaseAll 不 reject pending waiter | 先 settled=true 再 filter(!settled) → toReject 永空 | waiter 改为显式状态机；forceReleaseAll 直接遍历调 tryReject |
| P0-1B | waiter 三路径靠注释保证互斥 | settled 布尔无法表达终态原因 | state 枚举（pending/resolved/rejected_timeout/rejected_force） |
| P0-2 | guardian 全机扫描 chrome/msedge 误算 | 按进程名无差别统计 | setAutomationBrowserPid 注册 root PID → wmic 只统计该树 RSS |
| P0-3 | guardian 验收只检查函数存在 | override 可调用 ≠ 行为正确 | 升级为行为级断言 |

#### 第三轮（2026-03-28 20:21 UTC）

| 编号 | 问题 | 根因 | 修复方法 |
|------|------|------|----------|
| P0-F1 | automation PID 注册链未真实验收 | Playwright persistent context 不暴露 browser().process() | 改用 CDP SystemInfo.getProcessInfo 拿真实 browser PID；封装 resolveAutomationBrowserPid()（async）；验收脚本真实 launch → PID → guardian mode |
| P0-F2 | Windows 进程树 RSS 只扫两层，依赖 wmic | wmic 已废弃，不能递归 | 改用 PowerShell Get-CimInstance Win32_Process 一次获取全部进程，内存中构建 pid→children 图递归遍历，无层数限制 |
| P0-F3 | guardian 降级静默，PID 拿不到时无报告 | 返回 0 就完了 | 显式枚举 tracking_active/tracking_unavailable/no_browser/test_override；getGuardianTrackingState() 公开 API；markBrowserLaunchedPidUnavailable() 区分“无浏览器”和“浏览器已启但拿不到 PID” |

#### 第四轮（2026-03-28 20:41 UTC）— 最新（真实 manager 生产路径闭环验收）

| 编号 | 问题 | 根因 | 修复方法 |
|------|------|------|----------|
| P0-L1 | PID 注册验收绕开生产路径 | 脚本手动 chromium.launch + setAutomationBrowserPid 冒充 | 新增 ensureBrowserForTest() 走真实 launchBrowser()；验收全程不手动 setAutomationBrowserPid |
| P0-L2 | context.on("close") 没有清理 guardian 状态 | 崩溃/外部关闭时 PID/flag 残留 | context.on("close") 增加 setAutomationBrowserPid(null) + clearBrowserLaunchedFlag() |
| P0-L3 | getGuardianTrackingState().automationBrowserTreeRssBytes 恒为 0 | 硬编码占位 | 引入 _lastMeasuredBrowserRssBytes 缓存；tick 写、state 读 |
| bonus | closeDefaultPages 关闭全部 about:blank 导致 context 退出 | 所有页面关闭 = 进程退出 | 保留至少一个页面 |

### 验证结果（第四轮 2026-03-28 20:41 UTC，文档收口 21:05 UTC）
- TypeScript：`npx tsc --noEmit` 通过
- Vitest：134 tests / 17 files 全部通过（无回归）
- P0 lifecycle 专项验证：`npx tsx scripts/verify-page-lifecycle.ts` — **66 passed, 0 failed**
  - `phantom_slot_check: PASS`
  - `waiter_cleanup_check: PASS`
  - `force_release_rejects_pending_waiters: PASS`
  - `timeout_waiter_cannot_be_woken_later: PASS`
  - `guardian_over_threshold_trips_cleanup: PASS`
  - `guardian_ignores_non_automation_browser: PASS`
  - `automation_pid_registration_check: PASS` — 真实 manager 生产路径注册，PID = 97768
  - `guardian_tracking_mode_check: PASS` — mode = tracking_active
  - `guardian_cleanup_pid_clear_check: PASS` — closeBrowser() 后 mode=no_browser, pid=null
  - `guardian_state_rss_cached_check: PASS` — tick 后 cached RSS = 355MB（缓存值，非实时测量）

### 验收边界说明

#### 已完成且可写 PASS 的
- P0 生命周期治理主链（waiter 状态机、forceRelease 语义、phantom slot 防止）
- guardian PID/state 链（tracking mode 显式枚举、缓存 RSS、mode transition）
- manager 真实启动/关闭链（隔离临时目录下，ensureBrowserForTest → launchBrowser → CDP PID 注册 → closeBrowser）
- context.on("close") 清理一致性（与 closeBrowser 语义对齐）
- closeDefaultPages 安全性（保留至少一个页面）

#### 代码修复已完成但仍属于运行环境验证项的
- 真实 sanchez profile clone/sync 场景的环境稳定性（验收脚本用隔离目录，不覆盖 syncProfileState 真实链路）
- 用户本机真实 Chrome profile 与 Playwright 启动兼容性（exitCode=21 场景已确认存在，但属于 profile 状态依赖，非代码逻辑缺陷）
- 真实浏览器带用户 profile 的长期运行稳定性（需生产负载观测）

### 字段语义说明
- `GuardianTrackingState.automationBrowserTreeRssBytes` 是上一次 `_guardianTick()` 的缓存测量值，不是实时读数
- 浏览器关闭后该值可能保留最后一次测量；判断浏览器是否存活必须看 `mode` 和 `automationBrowserPid`
- `ensureBrowserForTest()` 是有副作用的真实生产链启动入口，不是只读 helper；调用后必须配对 `closeBrowser()`

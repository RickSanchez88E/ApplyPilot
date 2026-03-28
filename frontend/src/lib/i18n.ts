export type Locale = "en" | "zh";

const translations: Record<string, Record<Locale, string>> = {
  // Navbar
  "nav.title": { en: "Job Scraper", zh: "岗位采集器" },
  "nav.overview": { en: "Overview", zh: "总览" },
  "nav.offline": { en: "OFFLINE", zh: "离线" },

  // Overview page
  "overview.totalJobs": { en: "Total Jobs", zh: "总岗位数" },
  "overview.last24h": { en: "Last 24h", zh: "24小时内" },
  "overview.last1h": { en: "Last 1h", zh: "1小时内" },
  "overview.sponsorship": { en: "Sponsorship", zh: "可担保" },
  "overview.companies": { en: "Companies", zh: "公司数" },
  "overview.sourceDistribution": { en: "Source Distribution", zh: "来源分布" },
  "overview.crossPlatformDuplicates": { en: "Cross-Platform Duplicates", zh: "跨平台重复" },
  "overview.uniqueHashes": { en: "Unique hashes", zh: "唯一 hash" },
  "overview.totalListings": { en: "Total listings", zh: "总列表数" },
  "overview.applyResolution": { en: "Apply Resolution", zh: "申请链路解析" },
  "overview.formReached": { en: "Form Reached", zh: "已到表单" },
  "overview.descOnly": { en: "Desc Only", zh: "仅详情页" },
  "overview.loginRequired": { en: "Login Required", zh: "需登录" },
  "overview.blocked": { en: "Blocked", zh: "已封锁" },

  // Platform page
  "platform.dispatch": { en: "Dispatch", zh: "调度" },
  "platform.timeWindow": { en: "Time Window", zh: "时间窗口" },
  "platform.fullFetch": { en: "Full fetch — no native time filter", zh: "全量抓取 — 无原生时间过滤" },
  "platform.runNow": { en: "Run Now", zh: "立即执行" },
  "platform.dispatching": { en: "Dispatching…", zh: "调度中…" },
  "platform.total": { en: "Total", zh: "总数" },
  "platform.sponsor": { en: "Sponsor", zh: "担保" },
  "platform.ingested": { en: "Ingested", zh: "已入库" },
  "platform.all": { en: "All", zh: "全部" },
  "platform.cooldown": { en: "Source in cooldown", zh: "来源冷却中" },
  "platform.busy": { en: "Source busy", zh: "来源忙碌" },
  "platform.forceTrigger": { en: "Force trigger (override cooldown)", zh: "强制触发（忽略冷却）" },

  // Apply Discovery
  "apply.title": { en: "Apply Discovery", zh: "申请链路发现" },
  "apply.finalForm": { en: "Final Form", zh: "最终表单" },
  "apply.platformDesc": { en: "Platform Desc", zh: "平台详情" },
  "apply.needsLogin": { en: "Needs Login", zh: "需登录" },
  "apply.oauthGoogle": { en: "OAuth Google", zh: "Google 登录" },
  "apply.oauthLinkedin": { en: "OAuth LinkedIn", zh: "LinkedIn 登录" },
  "apply.failed": { en: "Failed", zh: "失败" },
  "apply.unresolved": { en: "Unresolved", zh: "未解析" },

  // Progress
  "progress.recentRuns": { en: "Recent Runs", zh: "最近运行" },
  "progress.latestRuns": { en: "Latest Runs by Source", zh: "各来源最近运行" },
  "progress.noRuns": { en: "No runs yet", zh: "暂无运行记录" },
  "progress.completed": { en: "completed", zh: "已完成" },
  "progress.failed": { en: "failed", zh: "失败" },
  "progress.running": { en: "running", zh: "运行中" },
  "progress.cancelled": { en: "cancelled", zh: "已取消" },

  // Schedule
  "schedule.title": { en: "Schedule State", zh: "调度状态" },
  "schedule.interval": { en: "Interval", zh: "间隔" },
  "schedule.lastRun": { en: "Last Run", zh: "上次运行" },
  "schedule.nextRun": { en: "Next Run", zh: "下次运行" },
  "schedule.cooldownUntil": { en: "Cooldown Until", zh: "冷却至" },
  "schedule.leaseHolder": { en: "Lease Holder", zh: "锁持有者" },

  // Common
  "common.queued": { en: "Queued", zh: "已入队" },
  "common.backgroundProcessing": { en: "Background processing", zh: "后台处理中" },
  "common.language": { en: "Language", zh: "语言" },
};

let currentLocale: Locale = (typeof localStorage !== "undefined" && localStorage.getItem("locale") as Locale) || "en";

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("locale", locale);
  }
}

export function t(key: string, locale?: Locale): string {
  const l = locale ?? currentLocale;
  return translations[key]?.[l] ?? translations[key]?.en ?? key;
}

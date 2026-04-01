export type Locale = 'en' | 'zh';

const translations: Record<string, Record<Locale, string>> = {
  // Navbar
  'nav.title': { en: 'Job Scraper', zh: '职位采集器' },
  'nav.overview': { en: 'Overview', zh: '总览' },
  'nav.offline': { en: 'OFFLINE', zh: '离线' },

  // Overview page
  'overview.totalJobs': { en: 'Total Jobs', zh: '总岗位数' },
  'overview.last24h': { en: 'Last 24h', zh: '24小时内' },
  'overview.last1h': { en: 'Last 1h', zh: '1小时内' },
  'overview.sponsorship': { en: 'Sponsorship', zh: '可担保' },
  'overview.companies': { en: 'Companies', zh: '公司数' },
  'overview.sourceDistribution': { en: 'Source Distribution', zh: '来源分布' },
  'overview.crossPlatformDuplicates': { en: 'Cross-Platform Duplicates', zh: '跨平台重复' },
  'overview.uniqueHashes': { en: 'Unique hashes', zh: '唯一哈希' },
  'overview.totalListings': { en: 'Total listings', zh: '总列表数' },
  'overview.applyResolution': { en: 'Apply Resolution', zh: '申请链路解析' },
  'overview.formReached': { en: 'Form Reached', zh: '已到表单' },
  'overview.descOnly': { en: 'Desc Only', zh: '仅详情页' },
  'overview.loginRequired': { en: 'Login Required', zh: '需登录' },
  'overview.blocked': { en: 'Blocked', zh: '已封锁' },
  'overview.coverage': { en: 'Coverage', zh: '覆盖率' },
  'overview.unresolvedJobs': { en: 'Unresolved Jobs', zh: '未解析岗位' },

  // Platform page
  'platform.dispatch': { en: 'Dispatch', zh: '调度' },
  'platform.timeWindow': { en: 'Time Window', zh: '时间窗口' },
  'platform.fullFetch': { en: 'Full fetch - no native time filter', zh: '全量抓取 - 无原生时间过滤' },
  'platform.runNow': { en: 'Run Now', zh: '立即执行' },
  'platform.dispatching': { en: 'Dispatching...', zh: '调度中...' },
  'platform.total': { en: 'Total', zh: '总数' },
  'platform.sponsor': { en: 'Sponsor', zh: '担保' },
  'platform.ingested': { en: 'Ingested', zh: '已入库' },
  'platform.all': { en: 'All', zh: '全部' },
  'platform.cooldown': { en: 'Source in cooldown', zh: '来源冷却中' },
  'platform.busy': { en: 'Source busy', zh: '来源忙碌' },
  'platform.forceTrigger': { en: 'Force trigger (override cooldown)', zh: '强制触发（忽略冷却）' },
  'platform.runDlq': { en: 'Run DLQ Scan', zh: '执行 DLQ 巡检' },
  'platform.dlqRunning': { en: 'Running DLQ...', zh: 'DLQ 执行中...' },
  'platform.dlqDone': { en: 'DLQ done', zh: 'DLQ 完成' },

  // Apply Discovery
  'apply.title': { en: 'Apply Discovery', zh: '申请链路发现' },
  'apply.finalForm': { en: 'Final Form', zh: '最终表单' },
  'apply.platformDesc': { en: 'Platform Desc', zh: '平台详情页' },
  'apply.needsLogin': { en: 'Needs Login', zh: '需登录' },
  'apply.oauthGoogle': { en: 'OAuth Google', zh: 'Google 登录' },
  'apply.oauthLinkedin': { en: 'OAuth LinkedIn', zh: 'LinkedIn 登录' },
  'apply.blocked': { en: 'Blocked', zh: '被阻断' },
  'apply.failed': { en: 'Failed', zh: '失败' },
  'apply.unresolved': { en: 'Unresolved', zh: '未解析' },

  // Progress
  'progress.recentRuns': { en: 'Recent Runs', zh: '最近运行' },
  'progress.latestRuns': { en: 'Latest Runs by Source', zh: '各来源最近运行' },
  'progress.noRuns': { en: 'No runs yet', zh: '暂无运行记录' },
  'progress.completed': { en: 'completed', zh: '已完成' },
  'progress.failed': { en: 'failed', zh: '失败' },
  'progress.running': { en: 'running', zh: '运行中' },
  'progress.cancelled': { en: 'cancelled', zh: '已取消' },
  'progress.found': { en: 'found', zh: '发现' },
  'progress.new': { en: 'new', zh: '新增' },

  // Jobs table
  'jobs.latest': { en: 'Latest Opportunities', zh: '最新机会' },
  'jobs.source': { en: 'Source', zh: '来源' },
  'jobs.position': { en: 'Position', zh: '职位' },
  'jobs.company': { en: 'Company', zh: '公司' },
  'jobs.location': { en: 'Location', zh: '地点' },
  'jobs.posted': { en: 'Posted', zh: '发布时间' },
  'jobs.resultsZero': { en: '0 results', zh: '0 条结果' },
  'jobs.pageOf': { en: 'Page', zh: '第' },
  'jobs.of': { en: 'of', zh: '/' },
  'jobs.sponsor': { en: 'Sponsor', zh: '担保' },
  'jobs.remote': { en: 'Remote', zh: '远程' },
  'jobs.prevPage': { en: 'Previous page', zh: '上一页' },
  'jobs.nextPage': { en: 'Next page', zh: '下一页' },
  'jobs.cloudflareWarning': { en: 'Link may be blocked by Cloudflare', zh: '链接可能被 Cloudflare 阻断' },

  // Keyword config
  'keyword.title': { en: 'Search Config', zh: '检索配置' },
  'keyword.keywords': { en: 'Keywords', zh: '关键词' },
  'keyword.location': { en: 'Location', zh: '地点' },
  'keyword.addPlaceholder': { en: 'Add keyword...', zh: '添加关键词...' },
  'keyword.minOne': { en: 'At least one keyword is required', zh: '至少需要一个关键词' },
  'keyword.saved': { en: 'Saved', zh: '已保存' },
  'keyword.saveFailed': { en: 'Save failed', zh: '保存失败' },
  'keyword.save': { en: 'Save', zh: '保存' },
  'keyword.reset': { en: 'Reset', zh: '重置' },
  'keyword.savedToDb': { en: 'Saved to database · persists across restarts', zh: '保存到数据库 · 重启不丢失' },
  'keyword.remove': { en: 'Remove keyword', zh: '删除关键词' },
  'keyword.add': { en: 'Add keyword', zh: '添加关键词' },

  // Common
  'common.queued': { en: 'Queued', zh: '已入队' },
  'common.backgroundProcessing': { en: 'Background processing', zh: '后台处理中' },
  'common.language': { en: 'Language', zh: '语言' },
  'common.switchLanguage': { en: 'Switch language', zh: '切换语言' },
  'common.systemHealthy': { en: 'System healthy', zh: '系统健康' },
  'common.systemOffline': { en: 'System offline', zh: '系统离线' },
};

let currentLocale: Locale = (typeof localStorage !== 'undefined' && (localStorage.getItem('locale') as Locale)) || 'en';

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('locale', locale);
  }
}

export function t(key: string, locale?: Locale): string {
  const l = locale ?? currentLocale;
  return translations[key]?.[l] ?? translations[key]?.en ?? key;
}

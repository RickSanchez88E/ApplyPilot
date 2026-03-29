# Ubuntu / Linux 部署指南

本项目主要在 Windows 上开发（宿主机浏览器 + Docker for 基础服务），但核心代码**完全兼容 Ubuntu / Linux 原生运行**。本文档说明如何在 Ubuntu 22.04 / 24.04 上完整部署。

---

## 兼容性说明

| 组件 | Ubuntu 支持 | 说明 |
|------|------------|------|
| API + Scheduler + Worker-General | ✅ 原生支持 | 纯 Node.js，无平台依赖 |
| PostgreSQL + Redis | ✅ 原生 / Docker | 推荐 Docker Compose |
| local-browser-worker（Jooble/Apply） | ✅ 需配置 | 需安装 Chrome / Chromium + 修改浏览器路径 |
| resource-guardian（内存监控） | ✅ 已适配 | 自动检测 `process.platform`，Linux 用 `pgrep + ps` |
| 前端构建 | ✅ 原生支持 | Vite + React，无平台依赖 |
| 测试 | ✅ 原生支持 | Vitest，全部跨平台 |

---

## 前置条件

```bash
# Node.js 22+ (推荐 LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm (项目包管理器)
corepack enable && corepack prepare pnpm@latest --activate

# Docker + Docker Compose (基础服务)
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
# 需重新登录使 docker 组生效

# Chrome / Chromium (local-browser-worker 需要)
# 方式 A: Google Chrome
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt -f install -y

# 方式 B: Chromium (无需 Google 仓库)
# sudo apt install -y chromium-browser

# Playwright 浏览器依赖 (可选，仅 worker-browser 容器外使用时需要)
npx playwright install-deps chromium
```

---

## 安装

```bash
git clone https://github.com/RickSanchez88E/linkedin-job-scraper.git
cd linkedin-job-scraper

# 后端依赖
pnpm install

# 前端依赖 + 构建
cd frontend && npm install && npm run build && cd ..
```

---

## 配置

```bash
cp .env.example .env
```

**必须修改的配置项**（与 Windows 不同的部分）：

```env
# === 数据库 (Docker Compose 默认) ===
DATABASE_URL=postgres://orchestrator:orchestrator@localhost:5433/job_orchestrator
REDIS_URL=redis://localhost:6380

# === 浏览器路径 (Ubuntu 与 Windows 不同，必须改) ===
LOCAL_BROWSER_ENGINE=chrome

# Google Chrome 路径 (apt 安装后的默认位置)
LOCAL_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
# Chromium 用: /usr/bin/chromium-browser 或 /snap/bin/chromium

# User Data 目录 (Chrome 在 Linux 的默认位置)
LOCAL_BROWSER_USER_DATA_DIR=/home/<你的用户名>/.config/google-chrome
# Chromium 用: /home/<你的用户名>/.config/chromium

# 自动化 profile
LOCAL_BROWSER_PROFILE_DIRECTORY=sanchez

# 自动化独立数据目录
LOCAL_BROWSER_DATA_DIR=.local-browser-data

# 无显示器的服务器环境用 headless
LOCAL_BROWSER_HEADLESS=true
# 有桌面环境可设 false 以可视化调试

# === 其他按需配置 (与 Windows 相同) ===
PORT=3000
```

> **关键差异**：Windows 默认浏览器路径是 `C:\Program Files\Google\Chrome\Application\chrome.exe`，Ubuntu 是 `/usr/bin/google-chrome-stable`。必须通过环境变量覆盖。

---

## 启动

### 方式一：Docker Compose 全托管（推荐）

所有基础服务 + 应用服务全部容器化：

```bash
# 构建所有镜像
docker compose build

# 启动 (后台)
docker compose up -d

# 检查状态
docker compose ps

# 查看日志
docker compose logs -f api
docker compose logs -f scheduler
```

此方式下 `api`、`scheduler`、`worker-general`、`worker-browser` 全部在容器内运行。

**Jooble 本地浏览器实验**需要额外在宿主机启动 `local-browser-worker`（见下方）。

### 方式二：Docker 基础服务 + 宿主机应用

```bash
# 只启动基础服务
docker compose up -d postgres redis

# 数据库迁移
pnpm run migrate

# 启动 API
pnpm run dev:server

# 另一个终端: 启动 local-browser-worker
npx tsx src/queue/local-browser-worker.ts
```

---

## Headless Server（无桌面环境）

如果 Ubuntu 没有桌面环境（纯 CLI 服务器），Chrome 需要虚拟显示：

```bash
# 安装 Xvfb
sudo apt install -y xvfb

# 方式 A: 用 xvfb-run 包裹
xvfb-run npx tsx src/queue/local-browser-worker.ts

# 方式 B: 手动启动虚拟显示
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
npx tsx src/queue/local-browser-worker.ts
```

或者直接设置 `LOCAL_BROWSER_HEADLESS=true`，大多数情况下不需要 Xvfb。

---

## systemd 开机自启动

仓库自带一键安装脚本，会自动创建 3 个 systemd unit（Docker 服务 + 宿主机 Worker + 统一 Target）：

```bash
chmod +x scripts/autostart-linux-setup.sh
sudo ./scripts/autostart-linux-setup.sh
```

安装后常用命令：

```bash
# 启动全部
sudo systemctl start job-scraper.target

# 停止全部
sudo systemctl stop job-scraper.target

# 查看状态
sudo systemctl status job-scraper-docker job-scraper-worker

# Worker 实时日志
journalctl -u job-scraper-worker -f

# 或查看文件日志
tail -f tmp/local-browser-worker.log
```

卸载自启动：

```bash
sudo systemctl disable --now job-scraper.target
sudo rm /etc/systemd/system/job-scraper-*
sudo systemctl daemon-reload
```

---

## Jooble 浏览器 Profile 配置

Jooble 抓取依赖持久化浏览器 profile（保留 cookies / 登录态 / CF 指纹）：

```bash
# 1. 首先在 Chrome 里创建一个名为 sanchez 的 profile
google-chrome-stable --profile-directory=sanchez

# 2. 手动访问 jooble.org 完成一次 CF challenge
# 3. 关闭 Chrome

# 4. 确认 profile 存在
ls ~/.config/google-chrome/sanchez/

# 5. .env 中确保配置正确
# LOCAL_BROWSER_USER_DATA_DIR=/home/<你的用户名>/.config/google-chrome
# LOCAL_BROWSER_PROFILE_DIRECTORY=sanchez
```

---

## 常见问题

### Chrome 启动报错 `DISPLAY` 未设置

```bash
# headless 模式不需要 DISPLAY
LOCAL_BROWSER_HEADLESS=true

# 或安装 xvfb
sudo apt install -y xvfb
xvfb-run npx tsx src/queue/local-browser-worker.ts
```

### `pnpm install` 失败

```bash
# 确保 corepack 已启用
corepack enable
corepack prepare pnpm@latest --activate

# 或直接安装
npm install -g pnpm
```

### Docker 权限被拒

```bash
sudo usermod -aG docker $USER
# 重新登录 shell
newgrp docker
```

### 数据库连接失败

```bash
# 确认 postgres 容器在运行
docker compose ps postgres

# 确认端口映射
docker compose port postgres 5432
# 应输出: 0.0.0.0:5433

# 测试连接
psql -h localhost -p 5433 -U orchestrator -d job_orchestrator -c "SELECT 1;"
```

### Playwright 浏览器安装

```bash
# 仅在宿主机直接运行 local-browser-worker 时需要
npx playwright install chromium
npx playwright install-deps chromium
```

---

## 验证清单

部署完成后逐项检查：

```bash
# 1. Docker 服务
docker compose ps
# 应看到 postgres (healthy), redis (healthy), api (healthy), scheduler, worker-general, worker-browser

# 2. API 健康
curl -s http://localhost:3000/api/health | python3 -m json.tool
# 应返回 {"status":"healthy", ...}

# 3. 前端页面
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# 应返回 200

# 4. 类型检查
pnpm run typecheck
# 应无错误

# 5. 测试
pnpm run test
# 应全部通过

# 6. Worker 进程
pgrep -af local-browser-worker
# 应看到 node 进程
```

---

## 与 Windows 部署的差异总结

| 项目 | Windows | Ubuntu |
|------|---------|--------|
| 包管理器 | pnpm (同) | pnpm (同) |
| Chrome 路径 | `C:\Program Files\Google\Chrome\...` | `/usr/bin/google-chrome-stable` |
| User Data | `C:\Users\<user>\AppData\Local\Google\Chrome\User Data` | `~/.config/google-chrome` |
| Docker | Docker Desktop | `docker.io` / Docker Engine |
| 开机自启 | Windows Startup + VBS | systemd service |
| 内存监控 | PowerShell `Get-CimInstance` | `pgrep + ps` (已自动适配) |
| 显示环境 | 总有桌面 | 可能需要 `xvfb` 或 headless |

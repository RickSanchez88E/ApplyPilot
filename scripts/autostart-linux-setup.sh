#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Job Scraper — Ubuntu 24.04 LTS autostart installer
#
# 用法：
#   chmod +x scripts/autostart-linux-setup.sh
#   sudo ./scripts/autostart-linux-setup.sh
#
# 该脚本会创建 3 个 systemd unit:
#   1. job-scraper-docker.service   — docker compose up/down
#   2. job-scraper-worker.service   — local-browser-worker (宿主机浏览器)
#   3. job-scraper.target           — 统一启停
#
# 删除自启动:
#   sudo systemctl disable --now job-scraper.target
#   sudo rm /etc/systemd/system/job-scraper-*
#   sudo systemctl daemon-reload
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────────────
# 修改下面的值来匹配你的环境
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
RUN_USER="${RUN_USER:-$(logname 2>/dev/null || echo $SUDO_USER || echo $USER)}"
NODE_BIN="${NODE_BIN:-$(which node 2>/dev/null || echo /usr/bin/node)}"
NPX_BIN="${NPX_BIN:-$(which npx 2>/dev/null || echo /usr/bin/npx)}"
DOCKER_COMPOSE_BIN="${DOCKER_COMPOSE_BIN:-$(which docker 2>/dev/null || echo /usr/bin/docker) compose}"

echo "=== Job Scraper systemd installer ==="
echo "  PROJECT_DIR    = $PROJECT_DIR"
echo "  RUN_USER       = $RUN_USER"
echo "  NODE_BIN       = $NODE_BIN"
echo "  DOCKER_COMPOSE = $DOCKER_COMPOSE_BIN"
echo ""

# ── 检查前置条件 ──────────────────────────────────────────────────
if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
    echo "ERROR: docker-compose.yml not found in $PROJECT_DIR"
    exit 1
fi
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "ERROR: .env not found in $PROJECT_DIR"
    exit 1
fi
if ! command -v docker &>/dev/null; then
    echo "ERROR: docker not found. Install: sudo apt install -y docker.io docker-compose-v2"
    exit 1
fi
if ! id -nG "$RUN_USER" | grep -qw docker; then
    echo "WARNING: $RUN_USER is not in docker group. Run: sudo usermod -aG docker $RUN_USER"
fi

# ── 1. Docker Compose service ────────────────────────────────────
cat > /etc/systemd/system/job-scraper-docker.service << UNIT
[Unit]
Description=Job Scraper — Docker Compose services (postgres, redis, api, scheduler, workers)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_DIR
ExecStart=$DOCKER_COMPOSE_BIN -f $PROJECT_DIR/docker-compose.yml up -d --wait
ExecStop=$DOCKER_COMPOSE_BIN -f $PROJECT_DIR/docker-compose.yml down
ExecReload=$DOCKER_COMPOSE_BIN -f $PROJECT_DIR/docker-compose.yml up -d --build
User=$RUN_USER
Group=docker
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
UNIT

echo "[ok] Created job-scraper-docker.service"

# ── 2. Local browser worker service ─────────────────────────────
cat > /etc/systemd/system/job-scraper-worker.service << UNIT
[Unit]
Description=Job Scraper — local-browser-worker (host Chrome, Jooble/apply)
After=job-scraper-docker.service
Requires=job-scraper-docker.service
# Wait for Redis and Postgres to be reachable
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
# PATH must include node
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$PROJECT_DIR/node_modules/.bin
Environment=NODE_ENV=production

ExecStartPre=/bin/bash -c 'for i in \$(seq 1 30); do redis-cli -u \$REDIS_URL PING 2>/dev/null | grep -q PONG && exit 0; sleep 2; done; echo "Redis not ready"; exit 1'
ExecStart=$NPX_BIN tsx $PROJECT_DIR/src/queue/local-browser-worker.ts

# 自动重启
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

# 日志
StandardOutput=append:$PROJECT_DIR/tmp/local-browser-worker.log
StandardError=append:$PROJECT_DIR/tmp/local-browser-worker.log

User=$RUN_USER

[Install]
WantedBy=multi-user.target
UNIT

echo "[ok] Created job-scraper-worker.service"

# ── 3. Target (group stop/start) ─────────────────────────────────
cat > /etc/systemd/system/job-scraper.target << UNIT
[Unit]
Description=Job Scraper — all services
Requires=job-scraper-docker.service
Wants=job-scraper-worker.service
After=job-scraper-docker.service job-scraper-worker.service

[Install]
WantedBy=multi-user.target
UNIT

echo "[ok] Created job-scraper.target"

# ── 4. 创建日志目录 ──────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/tmp"
chown "$RUN_USER":"$RUN_USER" "$PROJECT_DIR/tmp"
echo "[ok] Created tmp/ dir"

# ── 5. 启用并启动 ────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable job-scraper.target job-scraper-docker.service job-scraper-worker.service
echo ""
echo "=== 安装完成 ==="
echo ""
echo "常用命令:"
echo "  sudo systemctl start  job-scraper.target    # 启动全部"
echo "  sudo systemctl stop   job-scraper.target    # 停止全部"
echo "  sudo systemctl status job-scraper-docker    # Docker 服务状态"
echo "  sudo systemctl status job-scraper-worker    # Worker 状态"
echo "  journalctl -u job-scraper-worker -f         # Worker 实时日志"
echo "  tail -f $PROJECT_DIR/tmp/local-browser-worker.log  # Worker 文件日志"
echo ""
echo "立即启动:"
echo "  sudo systemctl start job-scraper.target"

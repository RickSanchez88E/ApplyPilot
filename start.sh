#!/usr/bin/env bash
# Job Scraper — Linux/macOS 一键启动
set -euo pipefail

echo "============================================================"
echo "  Job Scraper — One Click Start"
echo "============================================================"
echo

# ── Check Docker ──
echo "[1/5] 检查 Docker..."
if ! docker version &>/dev/null; then
    echo "      ❌ Docker 未运行。请先安装/启动 Docker。"
    if command -v systemctl &>/dev/null; then
        echo "      尝试: sudo systemctl start docker"
    fi
    exit 1
fi
echo "      Docker 已就绪 ✓"
echo

# ── Check .env ──
echo "[2/5] 检查环境配置..."
if [ ! -f .env ]; then
    echo "      .env 不存在，从 .env.example 创建..."
    cp .env.example .env
    echo "      ★ 请编辑 .env 填入 API KEY 等配置后重新运行"
    exit 1
fi
echo "      .env 已就绪 ✓"
echo

# ── Docker Compose up ──
echo "[3/5] 启动 Docker 容器..."
docker compose up -d --build
echo

# ── Wait for health ──
echo "[4/5] 等待服务就绪..."
retries=0
while [ $retries -lt 30 ]; do
    if docker exec job-redis redis-cli PING &>/dev/null && \
       docker exec job-postgres pg_isready -U orchestrator &>/dev/null; then
        break
    fi
    retries=$((retries + 1))
    sleep 2
done
echo "      PostgreSQL + Redis 已就绪 ✓"
echo

# ── Done ──
echo "[5/5] 启动完成！"
echo
echo "============================================================"
echo "  Dashboard:  http://localhost:3000"
echo "  Apply Discovery:  点击 Apply Discovery 标签"
echo "============================================================"
echo
echo "  提示："
echo "    - 停止所有服务: docker compose down"
echo "    - 查看日志:     docker compose logs -f api"
echo

# Auto-open browser
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000 &>/dev/null &
elif command -v open &>/dev/null; then
    open http://localhost:3000
fi

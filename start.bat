@echo off
chcp 65001 >nul 2>&1
title Job Scraper - One Click Start
echo ============================================================
echo   Job Scraper — Windows 一键启动
echo ============================================================
echo.

:: ── Check Docker ──
echo [1/5] 检查 Docker Desktop...
docker version >nul 2>&1
if errorlevel 1 (
    echo       Docker 未运行，正在启动 Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo       等待 Docker 启动中...
    :docker_wait
    timeout /t 3 /nobreak >nul
    docker version >nul 2>&1
    if errorlevel 1 goto docker_wait
)
echo       Docker 已就绪 ✓
echo.

:: ── Check .env ──
echo [2/5] 检查环境配置...
if not exist ".env" (
    echo       .env 不存在，从 .env.example 创建...
    copy .env.example .env >nul
    echo       ★ 请编辑 .env 填入 API KEY 等配置后重新运行
    echo       ★ 至少填入 REED_API_KEY（可选）
    pause
    exit /b 1
)
echo       .env 已就绪 ✓
echo.

:: ── Docker Compose up ──
echo [3/5] 启动 Docker 容器（postgres + redis + api + scheduler + workers）...
docker compose up -d --build 2>&1
echo.

:: ── Wait for health ──
echo [4/5] 等待服务就绪...
set retries=0
:health_loop
if %retries% geq 30 (
    echo       WARNING: 超时，服务可能未完全就绪
    goto health_done
)
docker exec job-redis redis-cli PING >nul 2>&1 && docker exec job-postgres pg_isready -U orchestrator >nul 2>&1 && goto health_done
set /a retries=%retries%+1
timeout /t 2 /nobreak >nul
goto health_loop
:health_done
echo       PostgreSQL + Redis 已就绪 ✓
echo.

:: ── Open browser ──
echo [5/5] 启动完成！
echo.
echo ============================================================
echo   Dashboard:  http://localhost:3000
echo   Apply Discovery:  http://localhost:3000 → Apply Discovery 标签
echo ============================================================
echo.
echo   提示：
echo     - 关闭窗口不影响服务运行
echo     - 停止所有服务: docker compose down
echo     - 查看日志:     docker compose logs -f api
echo.

:: Auto-open browser
start http://localhost:3000

echo 按任意键退出此窗口...
pause >nul

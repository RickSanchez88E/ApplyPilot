@echo off
chcp 65001 >nul 2>&1
title Job Scraper - Stop All
echo 正在停止所有 Job Scraper 服务...
docker compose down
echo.
echo 所有服务已停止。
pause

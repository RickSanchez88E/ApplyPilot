# Docker CI/CD（稳定发布）

## 目标
- 线上已有一个前端实例（`job-api` 容器）在跑时，仍可发布新版本。
- 发布前先做候选容器健康检查。
- 新版本失败时自动回滚到旧容器。

## 流水线入口
- 文件：`.github/workflows/docker-cicd.yml`
- 触发：
  - `push` 到 `main`
  - `pull_request` 到 `main`（仅跑 CI，不部署）
  - 手动 `workflow_dispatch`

## 必填 Secrets
- `DEPLOY_HOST`: Docker 主机 IP/域名
- `DEPLOY_USER`: SSH 用户
- `DEPLOY_SSH_KEY`: SSH 私钥
- `DEPLOY_PATH`: 服务器上的仓库绝对路径
- `DEPLOY_PORT`: 可选，默认 `22`

## 部署脚本
- 文件：`scripts/deploy-api-stable.sh`
- 调用方式：`bash scripts/deploy-api-stable.sh`

### 部署流程（稳定性保障）
1. `docker compose build api` 构建新镜像。
2. 启动候选容器 `job-api-candidate`（不占用对外端口）。
3. 对候选容器执行健康检查（`/api/health`）。
4. 健康通过后，短暂切换：
   - 停止当前 `job-api`
   - 重命名为备份容器
   - 拉起新 `job-api` 并 `--wait` 健康
5. 若新容器失败：
   - 删除失败新容器
   - 备份容器改名恢复并启动（自动回滚）
6. 成功后清理备份与候选容器。

## 你当前“已有前端实例在跑”的场景怎么发版
- 直接触发 GitHub Actions 即可，不需要先停线上容器。
- 脚本会在后台先跑候选容器，健康通过后才切换。
- 失败自动回滚，避免长时间不可用。

## 本地手动演练
```bash
bash scripts/deploy-api-stable.sh
```

可选参数：
```bash
SERVICE_NAME=api HEALTH_TIMEOUT_SEC=120 COMPOSE_WAIT_TIMEOUT_SEC=120 bash scripts/deploy-api-stable.sh
```

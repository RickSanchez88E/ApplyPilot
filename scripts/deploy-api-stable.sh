#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SERVICE_NAME="${SERVICE_NAME:-api}"
CANDIDATE_NAME="${CANDIDATE_NAME:-job-api-candidate}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-90}"
COMPOSE_WAIT_TIMEOUT_SEC="${COMPOSE_WAIT_TIMEOUT_SEC:-90}"

log() {
  printf '[deploy-api-stable] %s\n' "$1"
}

healthcheck_cmd() {
  local target_container="$1"
  docker exec "${target_container}" node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_healthy() {
  local target_container="$1"
  local timeout_sec="$2"
  local elapsed=0

  while (( elapsed < timeout_sec )); do
    local state
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${target_container}" 2>/dev/null || true)"
    if [[ "${state}" == "healthy" ]]; then
      return 0
    fi
    if healthcheck_cmd "${target_container}"; then
      return 0
    fi
    if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
      return 1
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  log "docker 未安装，退出。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  log "docker compose 不可用，退出。"
  exit 1
fi

OLD_CONTAINER_ID="$(docker compose ps -q "${SERVICE_NAME}")"
if [[ -z "${OLD_CONTAINER_ID}" ]]; then
  log "未找到运行中的 ${SERVICE_NAME} 容器，请先执行 docker compose up -d。"
  exit 1
fi

OLD_CONTAINER_NAME="$(docker inspect -f '{{.Name}}' "${OLD_CONTAINER_ID}" | sed 's#^/##')"
BACKUP_CONTAINER_NAME="${OLD_CONTAINER_NAME}-backup-$(date +%s)"

cleanup_candidate() {
  docker rm -f "${CANDIDATE_NAME}" >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT

log "开始构建 ${SERVICE_NAME} 新镜像..."
docker compose build "${SERVICE_NAME}"

log "启动候选容器（不占用对外端口）..."
docker rm -f "${CANDIDATE_NAME}" >/dev/null 2>&1 || true
docker compose run -d --no-deps --name "${CANDIDATE_NAME}" "${SERVICE_NAME}" >/dev/null

log "等待候选容器健康检查通过..."
if ! wait_healthy "${CANDIDATE_NAME}" "${HEALTH_TIMEOUT_SEC}"; then
  log "候选容器健康检查失败，部署中止。"
  docker logs --tail 100 "${CANDIDATE_NAME}" || true
  exit 1
fi

log "候选容器健康，开始切换流量..."
docker stop "${OLD_CONTAINER_NAME}" >/dev/null
docker rename "${OLD_CONTAINER_NAME}" "${BACKUP_CONTAINER_NAME}"

DEPLOY_OK=0
if docker compose up -d --no-deps --wait --wait-timeout "${COMPOSE_WAIT_TIMEOUT_SEC}" "${SERVICE_NAME}"; then
  NEW_CONTAINER_ID="$(docker compose ps -q "${SERVICE_NAME}")"
  if [[ -n "${NEW_CONTAINER_ID}" ]]; then
    NEW_CONTAINER_NAME="$(docker inspect -f '{{.Name}}' "${NEW_CONTAINER_ID}" | sed 's#^/##')"
    if wait_healthy "${NEW_CONTAINER_NAME}" "${HEALTH_TIMEOUT_SEC}"; then
      DEPLOY_OK=1
    fi
  fi
fi

if [[ "${DEPLOY_OK}" -ne 1 ]]; then
  log "新容器启动失败，执行回滚..."
  docker rm -f "${OLD_CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker rename "${BACKUP_CONTAINER_NAME}" "${OLD_CONTAINER_NAME}"
  docker start "${OLD_CONTAINER_NAME}" >/dev/null
  log "回滚完成。"
  exit 1
fi

log "部署成功，清理备份容器..."
docker rm -f "${BACKUP_CONTAINER_NAME}" >/dev/null 2>&1 || true
log "完成。"

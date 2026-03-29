# Job Scraper Autostart (Windows + Docker Desktop)
# Runs silently at login via Startup folder VBS wrapper — no popups, no windows.
# Logs to $PROJECT_DIR\tmp\autostart.log
#
# 核心约束：
#   - Docker Desktop 必须运行（它负责 WSL → Windows localhost 端口转发）
#   - local-browser-worker 在宿主机运行（需要真实浏览器 profile）
#   - 不使用 wsl docker compose 直连（端口转发不可靠）

$PROJECT_DIR = "D:\Users\rick\Downloads\linkedin-job-scraper"
$LOG_FILE    = "$PROJECT_DIR\tmp\autostart.log"

New-Item -ItemType Directory -Path "$PROJECT_DIR\tmp" -Force | Out-Null

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "[$ts] $msg"
}

Log "=== Autostart begin ==="

# ── Step 1: Start Docker Desktop (it handles WSL port forwarding) ──
Log "Checking Docker Desktop..."
$ddProcess = Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue
if (-not $ddProcess) {
    Log "Docker Desktop not running, starting..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Hidden
} else {
    Log "Docker Desktop already running (PID $($ddProcess.Id))"
}

# ── Step 2: Wait for Docker daemon to be ready ──
Log "Waiting for Docker daemon..."
$retries = 0
while ($retries -lt 60) {
    $ver = docker version --format "{{.Server.Version}}" 2>&1
    if ($ver -match "^\d+\.\d+") {
        Log "Docker daemon ready: $ver"
        break
    }
    Start-Sleep 3
    $retries++
}
if ($retries -ge 60) {
    Log "FAIL: Docker daemon not ready after 3 min, aborting."
    exit 1
}

# ── Step 3: Start Docker Compose services ──
Log "Starting Docker Compose services..."
$composeOut = docker compose -f "$PROJECT_DIR\docker-compose.yml" up -d 2>&1 | Out-String
Log "Docker Compose: $composeOut"

# ── Step 4: Wait for Redis + Postgres health ──
Log "Waiting for Redis and Postgres..."
$healthRetries = 0
while ($healthRetries -lt 30) {
    $redisOk = docker exec job-redis redis-cli PING 2>&1
    $pgOk = docker exec job-postgres pg_isready -U orchestrator 2>&1
    if ($redisOk -match "PONG" -and $pgOk -match "accepting") {
        Log "Redis: PONG, Postgres: ready"
        break
    }
    Start-Sleep 2
    $healthRetries++
}
if ($healthRetries -ge 30) {
    Log "WARNING: Services not healthy after 60s. Redis=$redisOk, Postgres=$pgOk"
}

# ── Step 5: Start local-browser-worker on host ──
Log "Starting local-browser-worker..."

# Kill stale workers
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*local-browser-worker*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Log "Stopped stale worker PID $($_.ProcessId)"
    }

# Start worker (no window, logs to file)
$workerLog = "$PROJECT_DIR\tmp\local-browser-worker.log"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c `"$PROJECT_DIR\node_modules\.bin\tsx.CMD`" `"$PROJECT_DIR\src\queue\local-browser-worker.ts`" >> `"$workerLog`" 2>&1"
$psi.WorkingDirectory = $PROJECT_DIR
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

# Load .env
Get-Content "$PROJECT_DIR\.env" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $psi.EnvironmentVariables[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$proc = [System.Diagnostics.Process]::Start($psi)
Log "local-browser-worker started, PID=$($proc.Id)"

Log "=== Autostart complete ==="

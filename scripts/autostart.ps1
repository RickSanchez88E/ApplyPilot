# Job Scraper Autostart Script
# Runs silently at login via Startup folder VBS wrapper — no popups, no windows.
# Logs to $PROJECT_DIR\tmp\autostart.log

$PROJECT_DIR = "D:\Users\rick\Downloads\linkedin-job-scraper"
$LOG_FILE    = "$PROJECT_DIR\tmp\autostart.log"

# Ensure tmp dir exists
New-Item -ItemType Directory -Path "$PROJECT_DIR\tmp" -Force | Out-Null

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "[$ts] $msg"
}

Log "=== Autostart begin ==="

# ── Step 1: Wait for WSL to be ready ────────────────────────
Log "Waiting for WSL..."
$retries = 0
while ($retries -lt 30) {
    $result = wsl -d Ubuntu-24.04 -- echo "ready" 2>&1
    if ($result -match "ready") { break }
    Start-Sleep 2
    $retries++
}
if ($retries -ge 30) {
    Log "FAIL: WSL not ready after 60s, aborting."
    exit 1
}
Log "WSL ready."

# ── Step 2: Ensure Docker daemon is running in WSL ──────────
Log "Checking Docker daemon in WSL..."
$dockerOk = wsl -d Ubuntu-24.04 -- docker info --format "{{.ServerVersion}}" 2>&1
if ($dockerOk -match "\d+\.\d+") {
    Log "Docker daemon already running: $dockerOk"
} else {
    Log "Docker daemon not running, attempting start via Docker Desktop proxy..."
    # Docker Desktop WSL integration auto-starts; if not, try manual
    Start-Sleep 10
    $dockerOk = wsl -d Ubuntu-24.04 -- docker info --format "{{.ServerVersion}}" 2>&1
    if ($dockerOk -match "\d+\.\d+") {
        Log "Docker daemon started: $dockerOk"
    } else {
        Log "WARNING: Docker daemon still not available. Services may fail."
    }
}

# ── Step 3: Start Docker Compose services ───────────────────
Log "Starting Docker Compose services..."
$composeOut = wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/d/Users/rick/Downloads/linkedin-job-scraper && docker compose up -d 2>&1"
Log "Docker Compose: $composeOut"

# Wait for health checks
Start-Sleep 10
$ps = wsl -d Ubuntu-24.04 -- bash -c "docker ps --format '{{.Names}} {{.Status}}' 2>&1" | Out-String
Log "Docker services: $ps"

# ── Step 4: Start local-browser-worker on host ──────────────
Log "Starting local-browser-worker..."

# Kill any stale worker processes first
$oldWorkers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*local-browser-worker*' }
foreach ($w in $oldWorkers) {
    Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
    Log "Stopped stale worker PID $($w.ProcessId)"
}

# Start worker in background via cmd.exe (no window, logs to file)
$workerLog = "$PROJECT_DIR\tmp\local-browser-worker.log"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c `"$PROJECT_DIR\node_modules\.bin\tsx.CMD`" `"$PROJECT_DIR\src\queue\local-browser-worker.ts`" >> `"$workerLog`" 2>&1"
$psi.WorkingDirectory = $PROJECT_DIR
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

# Load .env into environment for the worker process
Get-Content "$PROJECT_DIR\.env" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $psi.EnvironmentVariables[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$proc = [System.Diagnostics.Process]::Start($psi)
Log "local-browser-worker started, PID=$($proc.Id)"

Log "=== Autostart complete ==="

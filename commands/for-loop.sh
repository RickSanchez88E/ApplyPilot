#!/usr/bin/env bash
#
# Antigravity For Loop - 啟動迴圈命令
# 用法: for-loop.sh "<任務描述>" [--max-iterations N] [--completion "<標記>"]
#

set -euo pipefail

# 預設值
MAX_ITERATIONS=10
COMPLETION_PROMISE="DONE"
TEST_COMMAND="npm test"
STUCK_THRESHOLD=3
AUTO_BRANCH=true

# 解析參數
TASK_PROMPT=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --max-iterations)
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        --completion)
            COMPLETION_PROMISE="$2"
            shift 2
            ;;
        --test-command)
            TEST_COMMAND="$2"
            shift 2
            ;;
        --stuck-threshold)
            STUCK_THRESHOLD="$2"
            shift 2
            ;;
        --no-branch)
            AUTO_BRANCH=false
            shift
            ;;
        -*)
            echo "未知選項: $1" >&2
            exit 1
            ;;
        *)
            TASK_PROMPT="$1"
            shift
            ;;
    esac
done

# 驗證必要參數
if [[ -z "$TASK_PROMPT" ]]; then
    cat << 'EOF'
用法: /for-loop "<任務描述>" [選項]

選項:
  --max-iterations N    最大迭代次數 (預設: 10)
  --completion "<標記>"  完成標記字串 (預設: DONE)
  --test-command "<cmd>" 測試命令 (預設: npm test)
  --stuck-threshold N   卡住偵測閾值 (預設: 3)
  --no-branch           不自動建立 Git 分支

範例:
  /for-loop "修復所有 ESLint 警告" --max-iterations 20
  /for-loop "實作使用者登入功能" --completion "ALL_TESTS_PASSED" --test-command "pytest"
EOF
    exit 1
fi

# 專案根目錄
PROJECT_ROOT="${ANTIGRAVITY_PROJECT_ROOT:-.}"
STATE_DIR="$PROJECT_ROOT/.antigravity"
STATE_FILE="$STATE_DIR/for-loop-state.json"

# 確保目錄存在
mkdir -p "$STATE_DIR"

# 檢查是否已有進行中的迴圈
if [[ -f "$STATE_FILE" ]]; then
    echo "⚠️ 已有進行中的迴圈。請先執行 /cancel-loop 取消，或等待當前迴圈完成。" >&2
    exit 1
fi

# 可選: 建立 Git 分支
BRANCH_NAME=""
if [[ "$AUTO_BRANCH" == "true" ]] && command -v git &> /dev/null; then
    if git rev-parse --git-dir > /dev/null 2>&1; then
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        BRANCH_NAME="for-loop/$TIMESTAMP"
        git checkout -b "$BRANCH_NAME" 2>/dev/null || true
        echo "📌 已建立分支: $BRANCH_NAME"
    fi
fi

# 建立狀態檔案
cat > "$STATE_FILE" << EOF
{
    "iteration": 0,
    "max_iterations": $MAX_ITERATIONS,
    "completion_promise": "$COMPLETION_PROMISE",
    "original_prompt": $(echo "$TASK_PROMPT" | jq -Rs .),
    "test_command": "$TEST_COMMAND",
    "stuck_threshold": $STUCK_THRESHOLD,
    "stuck_count": 0,
    "last_error_hash": "",
    "branch": "$BRANCH_NAME",
    "started_at": "$(date -Iseconds)"
}
EOF

# 輸出啟動確認
cat << EOF

🔄 **自動修復迴圈已啟動**

📋 **任務:** $TASK_PROMPT

⚙️ **配置:**
- 最大迭代次數: $MAX_ITERATIONS
- 測試命令: $TEST_COMMAND
- 卡住偵測閾值: $STUCK_THRESHOLD

---

## ⚠️ 重要：腳本控制模式

你的停止權限由 \`check-completion.sh\` 腳本控制。

### 強制流程

1. 修改代碼
2. 執行: \`bash ./commands/check-completion.sh\`
3. 根據腳本輸出行動：
   - \`DONE\` → 可以停止
   - \`CONTINUE: ...\` → **禁止停止**，繼續修復
   - \`STUCK: ...\` → 停止，報告問題

### 禁止行為

- ❌ 禁止「我覺得改好了」就停止
- ❌ 禁止跳過 \`check-completion.sh\` 檢查
- ❌ 禁止忽略腳本輸出的 \`CONTINUE\` 指令

---

**開始執行任務...**

$TASK_PROMPT

EOF

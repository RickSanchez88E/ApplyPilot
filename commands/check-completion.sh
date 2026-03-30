#!/usr/bin/env bash
#
# Antigravity For Loop - 檢查完成狀態
#
# 輸出格式:
# DONE              - 任務完成
# CONTINUE: <訊息>  - 繼續修復
# STUCK: <訊息>     - 卡住了
# ERROR: <訊息>     - 發生錯誤
set -euo pipefail

# ===== 配置 =====
STATE_DIR=".antigravity"
STATE_FILE="$STATE_DIR/for-loop-state.json"
DEFAULT_TEST_COMMAND="npm test"
DEFAULT_MAX_ITERATIONS=10
DEFAULT_STUCK_THRESHOLD=3

# 跨平台 MD5 計算
compute_hash() {
    local input="$1"
    if command -v md5sum &> /dev/null; then
        echo -n "$input" | md5sum | cut -d' ' -f1
    elif command -v md5 &> /dev/null; then
        echo -n "$input" | md5 -q
    elif command -v shasum &> /dev/null; then
        echo -n "$input" | shasum -a 256 | cut -d' ' -f1
    else
        # Fallback: 字串長度 + 前 20 字元
        echo "${#input}_${input:0:20}"
    fi
}

# 讀取狀態
read_state() {
    if [[ ! -f "$STATE_FILE" ]]; then
        echo ""
        return
    fi
    cat "$STATE_FILE"
}

# 更新狀態
update_state() {
    local key="$1"
    local value="$2"

    if [[ ! -f "$STATE_FILE" ]]; then
        echo "{}" > "$STATE_FILE"
    fi

    local tmp_file=$(mktemp)
    jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$STATE_FILE" > "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
}

# 更新數字狀態
update_state_num() {
    local key="$1"
    local value="$2"

    if [[ ! -f "$STATE_FILE" ]]; then
        echo "{}" > "$STATE_FILE"
    fi

    local tmp_file=$(mktemp)
    jq --arg k "$key" --argjson v "$value" '.[$k] = $v' "$STATE_FILE" > "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
}

# 從狀態讀取值
get_state_value() {
    local key="$1"
    local default="$2"

    if [[ ! -f "$STATE_FILE" ]]; then
        echo "$default"
        return
    fi

    local value
    value=$(jq -r --arg k "$key" '.[$k] // empty' "$STATE_FILE")
    echo "${value:-$default}"
}

# ===== 主邏輯 =====
main() {
    # 檢查狀態檔案是否存在
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "DONE"
        echo "# 沒有活動的 for-loop，無需檢查"
        exit 0
    fi

    # 讀取配置
    local test_command
    local max_iterations
    local stuck_threshold
    local current_iteration
    local stuck_count
    local last_error_hash

    test_command=$(get_state_value "test_command" "$DEFAULT_TEST_COMMAND")
    max_iterations=$(get_state_value "max_iterations" "$DEFAULT_MAX_ITERATIONS")
    stuck_threshold=$(get_state_value "stuck_threshold" "$DEFAULT_STUCK_THRESHOLD")
    current_iteration=$(get_state_value "iteration" "0")
    stuck_count=$(get_state_value "stuck_count" "0")
    last_error_hash=$(get_state_value "last_error_hash" "")

    # 增加迭代計數
    current_iteration=$((current_iteration + 1))
    update_state_num "iteration" "$current_iteration"
    update_state "updated_at" "$(date -Iseconds)"

    # 檢查是否達到最大迭代次數
    if [[ $current_iteration -gt $max_iterations ]]; then
        update_state "status" "max_iterations_reached"
        echo "STUCK: 達到最大迭代次數 ($max_iterations)。請檢查是否有根本性問題。"
        exit 0
    fi

    # 執行測試
    local test_output
    local test_exit_code

    echo "# 執行測試: $test_command" >&2
    echo "# 迭代: $current_iteration/$max_iterations" >&2

    set +e
    test_output=$(eval "$test_command" 2>&1)
    test_exit_code=$?
    set -e

    # 判斷測試結果
    if [[ $test_exit_code -eq 0 ]]; then
        # 測試通過！
        update_state "status" "completed"
        update_state "completed_at" "$(date -Iseconds)"

        echo "DONE"
        echo "# 所有測試通過！迭代次數: $current_iteration"
        exit 0
    fi

    # 測試失敗，檢查是否卡住
    local current_error_hash
    current_error_hash=$(compute_hash "$test_output")

    if [[ "$current_error_hash" == "$last_error_hash" ]]; then
        # 相同錯誤
        stuck_count=$((stuck_count + 1))
        update_state_num "stuck_count" "$stuck_count"

        if [[ $stuck_count -ge $stuck_threshold ]]; then
            update_state "status" "stuck"
            echo "STUCK: 連續 $stuck_count 次相同錯誤，可能陷入死循環。請嘗試不同的修復方法。"
            echo "# 最後錯誤:"
            echo "$test_output" | head -20
            exit 0
        fi
    else
        # 不同錯誤，重置計數
        stuck_count=1
        update_state_num "stuck_count" "$stuck_count"
        update_state "last_error_hash" "$current_error_hash"
    fi

    # 記錄到歷史
    local history_entry
    history_entry=$(jq -n \
        --arg iter "$current_iteration" \
        --arg hash "$current_error_hash" \
        --arg time "$(date -Iseconds)" \
        '{iteration: $iter, error_hash: $hash, time: $time}')

    # 輸出 CONTINUE 指令
    echo "CONTINUE: 測試失敗 (迭代 $current_iteration/$max_iterations)"
    echo "#"
    echo "# 錯誤輸出:"
    echo "$test_output" | head -50
    echo "#"
    echo "# 請分析以上錯誤並修復代碼，然後再次執行 check-completion.sh"

    exit 0
}

# 執行主函數
main "$@"

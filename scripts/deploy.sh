#!/bin/bash
# 部署到线上机（nanzhu）。
#
# 🔴 为什么必须有这个脚本：`dist/` 不进 git（前端产物），所以 `git pull` **不会**
# 更新线上前端 —— 曾经线上前端停在两周前的版本，而后端改动照常生效，看起来
# 「部署了但页面没变」。这个脚本把 build 纳入流程，杜绝这类静默不一致。
#
# 用法（在线上机上跑，或从本机 ssh 过去跑）：
#   bash scripts/deploy.sh
#
# 环境变量：
#   DEPLOY_DIR  部署目录（默认 /opt/scorecard）
#   SERVICE     systemd 服务名（默认 scorecard）
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/scorecard}"
SERVICE="${SERVICE:-scorecard}"

# bun 未必在非登录 shell 的 PATH 里（systemd 用的是绝对路径）。
# 依次找：环境变量 → PATH → 服务实际用的那个位置 → 常见安装路径。
BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  for candidate in "$(command -v bun 2>/dev/null)" /home/ubuntu/.bun/bin/bun /root/.bun/bin/bun "$HOME/.bun/bin/bun" /usr/local/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then BUN="$candidate"; break; fi
  done
fi
if [ -z "$BUN" ]; then
  echo "❌ 找不到 bun —— 设 BUN=/path/to/bun 或把它装到 PATH 里" >&2
  exit 1
fi

cd "$DEPLOY_DIR"

echo "── 拉代码 ──"
git pull --ff-only

echo "── 装依赖 ──"
"$BUN" install --frozen-lockfile

echo "── 构建前端（dist/ 不入库，必须在这里生成）──"
"$BUN" run build

echo "── 重启服务 ──"
sudo systemctl restart "$SERVICE"
sleep 2

echo "── 健康检查 ──"
curl -sS -m 10 "http://127.0.0.1:${SCORECARD_PORT:-54445}/api/health"
echo
echo "✅ 部署完成：$(git rev-parse --short HEAD)"

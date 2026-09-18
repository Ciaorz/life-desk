#!/usr/bin/env bash
# ============================================================================
#  life-desk → GitHub Pages 一键上传脚本
#  目标站点： https://ciaorz.github.io/life-desk/
#  用法：
#    1) 先在 github.com 新建一个【空】仓库，名称必须为 life-desk
#       （也可：gh repo create life-desk --public --confirm）
#    2) 在本目录打开 Git Bash，运行：
#         bash git_upload.sh                 # 默认提交信息“更新 life-desk 站点”
#         bash git_upload.sh "本次改动说明"   # 自定义提交信息
#    3) 首次推送会要求输入 GitHub 用户名 + Personal Access Token
#       （密码登录已停用；token 需勾选 repo 权限）
#    4) 推送成功后，到仓库 Settings → Pages，Source 选 main 分支 / root 目录
# ============================================================================
set -euo pipefail

# ------------------------- 可配置项 -----------------------------------------
REMOTE_URL="${REMOTE_URL:-https://github.com/ciaorz/life-desk.git}"
BRANCH="${BRANCH:-main}"
COMMIT_MSG="${1:-更新 life-desk 站点}"
# ---------------------------------------------------------------------------

# 切到脚本所在目录（即项目根），无论从哪里调用
cd "$(dirname "$0")"

echo "== 当前目录: $(pwd) =="

# 1) 初始化仓库（如果还没有）
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "== 初始化 git 仓库（分支 $BRANCH）=="
  git init -b "$BRANCH"
else
  echo "== 已是 git 仓库，确保分支为 $BRANCH =="
  git checkout -B "$BRANCH"
fi

# 2) 设置远端 origin
if git remote get-url origin >/dev/null 2>&1; then
  echo "== 远端 origin 已存在：$(git remote get-url origin) =="
else
  echo "== 添加远端 origin -> $REMOTE_URL =="
  git remote add origin "$REMOTE_URL"
fi

# 3) 暂存（自动遵循 .gitignore：已排除备份/_ 临时文件/serve.js）
echo "== git add -A =="
git add -A

# 4) 提交（仅在确有改动时）
if git diff --cached --quiet; then
  echo "== 没有需要提交的改动，跳过 commit =="
else
  echo "== 提交: $COMMIT_MSG =="
  # 个别环境下 git commit 可能因 CRLF 归一化等返回非零，但提交已实际生成；
  # 这里用 || 兜底，确保仍能继续推送（不会因非致命错误中断）。
  git commit -m "$COMMIT_MSG" || echo "（commit 返回非零，疑似非致命告警；若下方 push 报“无提交”，请手动 git commit 一次）"
fi

# 5) 推送
echo "== 推送到 origin/$BRANCH =="
git push -u origin "$BRANCH"

echo ""
echo "完成 ✅  若 GitHub Pages 尚未启用，请到仓库 Settings → Pages 选择 $BRANCH 分支、/root 目录，稍等 1-2 分钟即可访问 https://ciaorz.github.io/life-desk/"

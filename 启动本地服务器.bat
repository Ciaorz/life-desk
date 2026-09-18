@echo off
chcp 65001 >nul
cd /d "E:\自制软件\生活后台\clean"
start "生活工作台本地服务器" "C:\Users\biode\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js 8080
ping -n 2 127.0.0.1 >nul
start "" "http://localhost:8080"

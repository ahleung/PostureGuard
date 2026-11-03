@echo off
rem 一键启动坐姿护卫。
rem 注意：不要写成 "%~dp0" —— 它自带结尾反斜杠，"E:\path\" 里的 \" 会被当成转义引号，
rem 程序会收到带引号的路径而启动失败。所以应用目录改用 %CD%（无结尾反斜杠）。
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0node_modules\electron\dist\electron.exe" "%CD%"
exit

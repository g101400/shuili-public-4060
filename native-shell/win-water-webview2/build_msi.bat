@echo off
REM 一键生成 MSI 安装包（需先安装 WiX Toolset：https://wixtoolset.org/）
REM 将本文件与 build_msi.wxs 放在 publish_win_water 目录，双击运行即可。
setlocal
set WIX=%WIX%\
if not exist "%WIX%bin\candle.exe" (
  echo [错误] 未检测到 WiX Toolset，请先安装 https://wixtoolset.org/ 并设置 WIX 环境变量
  pause & exit /b 1
)
copy /Y "..\\app.ico" app.ico >nul 2>&1
echo [1/3] 收集文件清单(heat)...
"%WIX%bin\heat.exe" dir "." -gg -sfrag -sreg -srd -scom -dr INSTALLFOLDER -cg MainComponents -var var.SourceDir -out files.wxs
echo [2/3] 编译(candle)...
"%WIX%bin\candle.exe" -dSourceDir=. build_msi.wxs files.wxs
echo [3/3] 链接(light)...
"%WIX%bin\light.exe" -ext WixUIExtension -out "水利工程一张图_Setup.msi" build_msi.wixobj files.wixobj
if exist "水利工程一张图_Setup.msi" ( echo ✅ 产出：水利工程一张图_Setup.msi ) else ( echo ❌ 生成失败 )
endlocal
pause

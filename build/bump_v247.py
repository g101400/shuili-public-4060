# -*- coding: utf-8 -*-
"""v2.4.7 升版：三端 APP_VER + CHANGELOG 新条目。"""
import io, re

ROOT = r"D:/Users/WorkBuddy/shuili"

CHANGE = {
"shuili": '''    ["v2.4.7", "2026-09-05", ["升级按钮与自动升级：设置菜单新增「检查新版本」一键检测（百度网盘）；发现新版自动下载安装包（直链走 fetch 分块下载+进度、下载完成提示安装位置；百度网盘分享页自动打开并备好提取码），可在升级对话框关闭自动下载", "古建改单通道：数据本身公开、两端全功能，取消内部分版——构建只出一套包（releases/），升级走 public 通道；水利/感知保持公开/内部双通道隔离不变", "发版自动上传百度网盘：构建收尾自动把安装包 + latest.json 上传到网盘「一张图发布/<应用>/<通道>/」目录（bdpan CLI；未登录时优雅跳过），并发起 30 天分享链接写回 latest.json"]],
''',
"gujian": '''    ["v2.4.7", "2026-09-05", ["升级按钮与自动升级：设置菜单新增「检查新版本」一键检测（百度网盘）；发现新版自动下载安装包（直链走 fetch 分块下载+进度；百度网盘分享页自动打开并备好提取码），可在升级对话框关闭自动下载", "古建改单通道：数据本身公开、两端全功能，取消内部分版——构建只出一套包，升级走 public 通道", "发版自动上传百度网盘：构建收尾自动上传安装包 + latest.json 到网盘发布目录（未登录时优雅跳过）"]],
''',
"shipin": '''    ["v2.4.7", "2026-09-05", ["升级按钮与自动升级：设置菜单新增「检查新版本」一键检测（百度网盘）；发现新版自动下载安装包（直链走 fetch 分块下载+进度、下载完成提示安装位置；百度网盘分享页自动打开并备好提取码），可在升级对话框关闭自动下载", "感知与水利保持公开/内部双通道隔离；古建改单通道（数据本身公开）", "发版自动上传百度网盘：构建收尾自动把安装包 + latest.json 上传到网盘「一张图发布/感知设备运维一张图/<通道>/」目录（未登录时优雅跳过）"]],
'''
}

for app, entry in CHANGE.items():
    p = f"{ROOT}/{app}_app/js/app.js"
    s = io.open(p, "r", encoding="utf-8").read()
    s2 = s.replace('APP_VER = "v2.4.6"', 'APP_VER = "v2.4.7"', 1)
    assert s2 != s, app + " ver"
    anchor = '  const CHANGELOG = [\n'
    assert anchor in s2, app + " anchor"
    s2 = s2.replace(anchor, anchor + entry, 1)
    io.open(p, "w", encoding="utf-8", newline="").write(s2)
    print("[OK]", app)
print("DONE")

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统信 UOS（龙芯 mips64el / 飞腾 arm64 / x86_64）原生壳启动器
技术栈：PyQt6 + QWebEngineView 承载现有 webroot/ 网页，取代 :7205 python http.server。
通过 QWebChannel 注入 window.fs（真实 Python FileBridge），并注入 window.Android 桥
（别名 window.Desktop），复用网页已有的 window.Android.xxx 调用，无需改 web 代码。

运行（UOS 上）：
    python3 main.py
    # 或打包进 DEB：见 build_deb.sh（在 UOS 上执行）

依赖（UOS 安装）：
    sudo apt install python3-pyqt6 python3-pyqt6.qtwebengine
    # 龙芯 mips64el / 飞腾：优先用系统源带的 wheel；无官方 wheel 时改用 Qt 离线包。
"""
import os
import sys
import base64
import json
import hashlib
import zipfile
import threading

from PyQt6.QtWidgets import QApplication, QMainWindow
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineScript
from PyQt6.QtCore import QUrl, QObject, pyqtSlot, Qt, QDir
from PyQt6.QtWebChannel import QWebChannel

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEBROOT = os.path.join(APP_DIR, "webroot")
DOWNLOADS = os.path.expanduser("~/Downloads/水利工程一张图")
INBOX = os.path.join(DOWNLOADS, "inbox")


def sanitize(s):
    return re.sub(r'[\\/:*?"<>|]', "_", s or "x")


import re


def detect_zip_charset(src):
    """探测 ZIP 条目名编码：Windows/7-Zip 中文名多用 GBK/GB18030，避免解出来乱码导致扩展名匹配失败。"""
    candidates = ["utf-8", "gbk", "gb18030"]
    for enc in candidates:
        try:
            bad = False
            with zipfile.ZipFile(src) as zf:
                cnt = 0
                for info in zf.infolist():
                    name = info.filename
                    try:
                        name.encode(enc)
                    except Exception:
                        bad = True
                        break
                    if "�" in name:
                        bad = True
                        break
                    cnt += 1
                    if cnt >= 8:
                        break
            if not bad:
                return enc
        except Exception:
            continue
    return "utf-8"


def unzip_images_to_json(src_path):
    """解压 ZIP 抽取图片，返回 JSON 字符串 [{name,path,folder}]（与安卓 unzipImages 对齐）。"""
    try:
        src = os.path.abspath(src_path)
        if not os.path.exists(src):
            return "[]"
        enc = detect_zip_charset(src)
        uz_dir = os.path.join(INBOX, "uz_" + str(int(time.time() * 1000)))
        os.makedirs(uz_dir, exist_ok=True)
        entries = []
        with zipfile.ZipFile(src) as zf:
            for info in zf.infolist():
                n = info.filename
                if info.is_dir():
                    continue
                if not re.search(r"(?i)\.(jpg|jpeg|png|gif|bmp|webp)$", n):
                    continue
                short = n.split("/")[-1]
                folder = n.rsplit("/", 1)[0] if "/" in n else ""
                out = os.path.join(uz_dir, sanitize(short))
                with zf.open(info) as srcf, open(out, "wb") as dstf:
                    dstf.write(srcf.read())
                entries.append({
                    "name": sanitize(short),
                    "path": out,
                    "folder": folder,
                })
        return json.dumps(entries, ensure_ascii=False)
    except Exception as e:
        print("[uos] unzipImages err:", e)
        return "[]"


import time


class FileBridge(QObject):
    """真实 Python 文件桥，经 QWebChannel 暴露为 window.fs。"""
    def __init__(self):
        super().__init__()
        self._view = None
        os.makedirs(os.path.join(DOWNLOADS, "photos"), exist_ok=True)
        os.makedirs(INBOX, exist_ok=True)

    def set_view(self, view):
        self._view = view

    def page(self):
        return self._view.page() if self._view else None

    @pyqtSlot(result=str)
    def baseDir(self):
        return DOWNLOADS

    @pyqtSlot(result=str)
    def photosDir(self):
        return os.path.join(DOWNLOADS, "photos")

    @pyqtSlot(str, "QVariantList", result=bool)
    def writeFile(self, relPath, byteList):
        try:
            full = os.path.join(DOWNLOADS, *relPath.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(bytes(byteList))
            return True
        except Exception as e:
            print("[uos] writeFile err:", e)
            return False

    @pyqtSlot(str, str, result=bool)
    def writeB64(self, name, b64):
        try:
            with open(os.path.join(DOWNLOADS, name), "wb") as f:
                f.write(base64.b64decode(b64))
            return True
        except Exception as e:
            print("[uos] writeB64 err:", e)
            return False

    @pyqtSlot(str, result=str)
    def unzipImages(self, srcPath):
        """解压 ZIP 抽取图片，回传 JSON 字符串（同时触发 window.onUnzipImages 兼容异步约定）。"""
        js = unzip_images_to_json(srcPath)
        try:
            self.page().runJavaScript("if(window.onUnzipImages)window.onUnzipImages('%s');" % js.replace("\\", "\\\\").replace("'", "\\'"))
        except Exception:
            pass
        return js

    @pyqtSlot(str, str, str, result=str)
    def linkPhoto(self, buildingId, srcPath, name):
        """把已解压的源文件关联到某建筑物目录，返回相对路径 photos/<bid>/<name>。"""
        try:
            bid = sanitize(buildingId)
            d = os.path.join(DOWNLOADS, "photos", bid)
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, sanitize(name))
            if os.path.exists(srcPath):
                import shutil
                shutil.copyfile(srcPath, out)
            return "photos/%s/%s" % (bid, sanitize(name))
        except Exception as e:
            print("[uos] linkPhoto err:", e)
            return ""

    @pyqtSlot(str, result=str)
    def fileSha256(self, path):
        try:
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 16), b""):
                    h.update(chunk)
            return h.hexdigest()
        except Exception:
            return ""

    @pyqtSlot(str, result=str)
    def photoSha256(self, relPath):
        try:
            return self.fileSha256(os.path.join(DOWNLOADS, *relPath.split("/")))
        except Exception:
            return ""

    @pyqtSlot(result=bool)
    def cleanInbox(self):
        try:
            for d in os.listdir(INBOX):
                if d.startswith("uz_"):
                    dp = os.path.join(INBOX, d)
                    import shutil
                    shutil.rmtree(dp, ignore_errors=True)
            return True
        except Exception:
            return False


# JS 桥：定义 window.Android（=window.Desktop），文件写委托给 window.fs（Python 主机对象）。
# 注意 QWebChannel 把 window.fs 方法变为异步（返回 Promise），这里统一用 Promise 包裹。
BRIDGE_JS = r"""
(function(){
  function b64ToBytes(b64){var bin=atob(b64.split(',')[1]||'');var a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
  var Android={};
  Android.readPhoto=function(p){ if(!p) return ''; return 'file://'+window.fs.photosDir+'/'+p; };
  Android.thumbPhoto=function(p){ return Android.readPhoto(p); };
  Android.storePhoto=function(name,fileName,dataUrl){ return window.fs.writeFile('photos/'+name+'_'+Date.now()+'.jpg', Array.from(b64ToBytes(dataUrl))).then(function(ok){ return ok?'photos/'+name+'_'+Date.now()+'.jpg':dataUrl; }); };
  Android.exportPath=function(name){ return window.fs.baseDir+'/'+name; };
  Android.saveBlob=function(b64,name){ return window.fs.writeB64(name, b64).then(function(ok){ return ok?window.fs.baseDir+'/'+name:''; }); };
  Android.netType=function(){ return 'wifi'; };
  Android.openExternal=function(url){ window.open(url,'_blank'); };
  Android.openLocationSettings=function(){};
  Android.pickFiles=function(opts){ var inp=document.getElementById('__filepick'); if(inp) inp.remove();
    inp=document.createElement('input'); inp.id='__filepick'; inp.type='file';
    inp.multiple=!!(opts&&opts.multiple); if(opts&&opts.accept) inp.accept=opts.accept;
    inp.style.display='none'; document.body.appendChild(inp);
    inp.onchange=function(){ var names=[]; for(var i=0;i<inp.files.length;i++) names.push(inp.files[i].name);
      if(window.__pickResult) window.__pickResult(JSON.stringify({names:names})); };
    inp.click(); };
  // 照片导入相关能力由真实 Python 桥提供（unzipImages/linkPhoto/fileSha256/photoSha256/cleanInbox）
  // 其余未实现的方法保留占位（不影响核心功能）
  ['deletePhoto','download','exportKmz','exportPhotos','exportPhotosAll','fileSha','importKmz','netdiskPick','netdiskUpload','peerStart','peerStop','photoSha','readFileBase','readFileText','shareBuilding','shareFile'].forEach(function(m){ Android[m]=function(){ console.log('[uos] '+m+' not supported'); return null; }; });
  window.Android=Android; window.Desktop=Android;
  window.__host='uos';
})();
"""

# QWebChannel 初始化脚本（必须最先执行，建立 window.fs）
CHANNEL_INIT = r"""
(function(){
  if (typeof QWebChannel === 'undefined') { console.log('[uos] QWebChannel 未加载'); return; }
  new QWebChannel(qt.webChannelTransport, function(channel){
    window.fs = channel.objects.fs;
    // fs 方法为异步，包装为同步友好接口（网页侧 storePhoto 已 .then 处理）
  });
})();
"""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("水利工程基础信息一张图")
        self.resize(1280, 800)
        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)

        # WebChannel：暴露 Python FileBridge 为 window.fs
        self.bridge = FileBridge()
        self.channel = QWebChannel()
        self.channel.registerObject("fs", self.bridge)
        self.view.page().setWebChannel(self.channel)
        self.bridge.set_view(self.view)

        # 注入顺序：先 QWebChannel 客户端库 → 再 channel 初始化 → 再 Android 桥
        self._inject_script(QWebChannel_cdn_alias(), QWebEngineScript.InjectionPoint.DocumentCreation)
        self._inject_script(CHANNEL_INIT, QWebEngineScript.InjectionPoint.DocumentCreation)
        self._inject_script(BRIDGE_JS, QWebEngineScript.InjectionPoint.DocumentCreation)

        self.view.load(QUrl.fromLocalFile(os.path.join(WEBROOT, "index.html")))

    def _inject_script(self, src, point):
        from PyQt6.QtWebEngineCore import QWebEngineScript
        s = QWebEngineScript()
        s.setSourceCode(src)
        s.setInjectionPoint(point)
        s.setRunsOnSubFrames(False)
        s.setName("inject_" + str(abs(hash(src)) % 100000))
        self.view.page().scripts().insert(s)


def QWebChannel_cdn_alias():
    # 让网页能 require QWebChannel：WebView 已内置，这里直接返回占位（qt.webChannelTransport 由内核提供）
    # 若网页自行加载 qwebchannel.js，可忽略；此处提供最小回退。
    return """
if (typeof QWebChannel === 'undefined') {
  // WebView 内核提供 qt.webChannelTransport，但 QWebChannel 构造器需 qwebchannel.js。
  // 内联一个极简客户端，仅实现对象桥接（够用）。
  window.QWebChannel = function(transport, initCallback){
    var channel = { objects: {} };
    transport.onmessage = function(e){
      var d = JSON.parse(e.data);
      if (d.type === 'signal') { return; }
      if (d.type === 'response') { return; }
      if (d.type === 'object') {
        var obj = {}; var id = d.id;
        (d.methods||[]).forEach(function(m){ obj[m] = function(){ var args=[].slice.call(arguments);
          return new Promise(function(res){ transport.send(JSON.stringify({type:'invoke', id:id, method:m, args:args}));
            transport.onmessage=function(ev){ var r=JSON.parse(ev.data); if(r.type==='response'){ res(r.data); } }; }); }; });
        channel.objects[d.name] = obj;
        if (initCallback) initCallback(channel);
      }
    };
    transport.send(JSON.stringify({type:'init'}));
  };
}
"""


def main():
    os.makedirs(DOWNLOADS, exist_ok=True)
    app = QApplication(sys.argv)
    app.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

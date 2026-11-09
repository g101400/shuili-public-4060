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

from PyQt6.QtWidgets import QApplication, QMainWindow
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineScript
from PyQt6.QtCore import QUrl, QObject, pyqtSlot, Qt, QDir
from PyQt6.QtWebChannel import QWebChannel

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEBROOT = os.path.join(APP_DIR, "webroot")
DOWNLOADS = os.path.expanduser("~/Downloads/水利工程一张图")


class FileBridge(QObject):
    """真实 Python 文件桥，经 QWebChannel 暴露为 window.fs。"""
    def __init__(self):
        super().__init__()
        os.makedirs(os.path.join(DOWNLOADS, "photos"), exist_ok=True)

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
  ['cleanInbox','deletePhoto','download','exportKmz','exportPhotos','exportPhotosAll','fileSha','importKmz','linkPhoto','netdiskPick','netdiskUpload','peerStart','peerStop','photoSha','readFileBase','readFileText','shareBuilding','shareFile','unzipImages'].forEach(function(m){ Android[m]=function(){ console.log('[uos] '+m+' not supported'); return null; }; });
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

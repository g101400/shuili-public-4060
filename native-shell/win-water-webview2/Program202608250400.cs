using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ShuiliMapWater
{
    /// <summary>
    /// Win11 原生壳：WebView2（Edge 内核）承载现有 webroot/ 网页，
    /// 用 VirtualHostMapping 把 https://app.local/ 映射到本地 webroot，
    /// 取代原 :7205 python/ps HTTP 服务。注入 window.Android 桥（别名 window.Desktop），
    /// 复用网页已有的 window.Android.xxx 调用，无需改 web 代码。
    /// </summary>
    public class MainForm : Form
    {
        private WebView2 _webview;

        public MainForm()
        {
            Text = "水利工程基础信息一张图";
            Width = 1280; Height = 800;
            _webview = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_webview);
            Load += async (s, e) => await InitAsync();
        }

        private async Task InitAsync()
        {
            var env = await CoreWebView2Environment.CreateAsync();
            await _webview.EnsureCoreWebView2Async(env);
            var wv2 = _webview.CoreWebView2;
            var webroot = Path.Combine(AppContext.BaseDirectory, "webroot");
            wv2.SetVirtualHostNameToFolderMapping("app.local", webroot, CoreWebView2HostResourceAccessKind.Allow);
            // 注册 C# 文件桥，供注入 JS 调用（落盘照片/导出文件）
            var dl = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Downloads", "水利工程一张图");
            Directory.CreateDirectory(dl);
            wv2.AddHostObjectToScript("fs", new FileBridge(dl));
            await wv2.AddScriptToExecuteOnDocumentCreatedAsync(BridgeJs());
            wv2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Geolocation)
                { e.State = CoreWebView2PermissionState.Allow; e.Handled = true; }
            };
            await wv2.ExecuteScriptAsync("window.__host='win';");
            _webview.Source = new Uri("https://app.local/index.html");
        }

        /// <summary>
        /// 原生桥 JS：定义 window.Android（= window.Desktop），实现网页用到的关键方法。
        /// 文件写操作委托给 C# 主机对象 window.fs。
        /// </summary>
        private static string BridgeJs()
        {
            return @"
(function(){
  function b64ToBytes(b64){var bin=atob(b64.split(',')[1]||'');var a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
  function bytesToB64(bytes){var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return 'data:image/png;base64,'+btoa(bin);}
  var Android={};
  Android.readPhoto=function(p){ if(!p) return ''; return 'file://'+window.fs.photosDir()+'/'+p; };
  Android.thumbPhoto=function(p){ return Android.readPhoto(p); };
  Android.storePhoto=function(name,fileName,dataUrl){ try{
    var rel='photos/'+name+'_'+Date.now()+'.jpg';
    window.fs.writeFile(rel, b64ToBytes(dataUrl)); return rel;
  }catch(e){ return dataUrl; } };
  Android.exportPath=function(name){ return window.fs.baseDir()+'/'+name; };
  Android.saveBlob=function(b64,name){ try{ window.fs.writeB64(name, b64); return window.fs.baseDir()+'/'+name; }catch(e){ return ''; } };
  Android.netType=function(){ return 'wifi'; };
  Android.openExternal=function(url){ window.open(url,'_blank'); };
  Android.openLocationSettings=function(){ };
  Android.pickFiles=function(opts){ var inp=document.getElementById('__filepick'); if(inp) inp.remove();
    inp=document.createElement('input'); inp.id='__filepick'; inp.type='file';
    inp.multiple=!!(opts&&opts.multiple); if(opts&&opts.accept) inp.accept=opts.accept;
    inp.style.display='none'; document.body.appendChild(inp);
    inp.onchange=function(){ var names=[]; for(var i=0;i<inp.files.length;i++) names.push(inp.files[i].name);
      if(window.__pickResult) window.__pickResult(JSON.stringify({names:names})); };
    inp.click(); };
  ['cleanInbox','deletePhoto','download','exportKmz','exportPhotos','exportPhotosAll','fileSha','importKmz','linkPhoto','netdiskPick','netdiskUpload','peerStart','peerStop','photoSha','readFileBase','readFileText','shareBuilding','shareFile','unzipImages'].forEach(function(m){ Android[m]=function(){ console.log('[win] '+m+' not supported'); return null; }; });
  window.Android=Android; window.Desktop=Android;
})();";
        }

        [STAThread]
        public static void Main()
        {
            Application.SetHighDpiMode(HighDpiMode.SystemAware);
            Application.EnableVisualStyles();
            Application.Run(new MainForm());
        }
    }

    /// <summary>
    /// C# 主机对象：暴露给网页的同步文件写能力（base64 写入下载目录）。
    /// 通过 AddHostObjectToScript("fs", ...) 注入为 window.fs。
    /// </summary>
    [System.Runtime.InteropServices.ComVisible(true)]
    public class FileBridge
    {
        private readonly string _base;
        private readonly string _photos;
        public FileBridge(string baseDir)
        {
            _base = baseDir;
            _photos = Path.Combine(baseDir, "photos");
            Directory.CreateDirectory(_photos);
        }
        public string baseDir() => _base;
        public string photosDir() => _photos;
        public void writeFile(string relPath, byte[] bytes)
        {
            var full = Path.Combine(_base, relPath.Replace("/", "\\"));
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            File.WriteAllBytes(full, bytes);
        }
        public void writeB64(string name, string b64)
        {
            var bin = Convert.FromBase64String(b64);
            File.WriteAllBytes(Path.Combine(_base, name), bin);
        }
    }
}

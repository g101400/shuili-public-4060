using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;
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
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Controls.Add(_webview);
            Load += async (s, e) => await InitAsync();
        }

        private async Task InitAsync()
        {
            try
            {
                // WebView2 用户数据目录必须可写：安装到 Program Files 时标准用户无写权限，
                // 默认目录会触发 E_ACCESSDENIED，故固定落到 %LOCALAPPDATA% 下。
                var dataFolder = GetWebView2DataFolder();
                var env = await CoreWebView2Environment.CreateAsync(null, dataFolder);
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
            catch (Exception ex)
            {
                MessageBox.Show(
                    "WebView2 初始化失败：" + ex.Message + "\n\n请确认已安装 Microsoft Edge WebView2 运行时（Evergreen）。",
                    "启动错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// 取一个当前用户可写的 WebView2 用户数据目录（默认落在 Program Files 下会因权限不足而 E_ACCESSDENIED）。
        /// </summary>
        private static string GetWebView2DataFolder()
        {
            var app = System.Reflection.Assembly.GetExecutingAssembly().GetName().Name ?? "ShuiliApp";
            var sb = new StringBuilder();
            foreach (var c in app)
                sb.Append(Path.GetInvalidFileNameChars().Contains(c) ? '_' : c);
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                sb.ToString(), "WebView2");
            try { Directory.CreateDirectory(folder); return folder; }
            catch
            {
                var tmp = Path.Combine(Path.GetTempPath(), "ShuiliApp_WebView2");
                Directory.CreateDirectory(tmp);
                return tmp;
            }
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
  // 照片导入：真实实现 unzipImages/linkPhoto/fileSha256/photoSha256/cleanInbox
  // （同步返回 JSON 字符串，并触发 window.onUnzipImages 回调，兼容水利/感知异步约定；古建用返回值）
  Android.unzipImages=function(srcPath){ try{ var j=window.fs.unzipImages(srcPath); if(window.onUnzipImages) window.onUnzipImages(j); return j; }catch(e){ return '[]'; } };
  Android.linkPhoto=function(bid,srcPath,name){ try{ return window.fs.linkPhoto(bid,srcPath,name); }catch(e){ return ''; } };
  Android.fileSha256=function(p){ try{ return window.fs.fileSha256(p); }catch(e){ return ''; } };
  Android.photoSha256=function(rel){ try{ return window.fs.photoSha256(rel); }catch(e){ return ''; } };
  Android.cleanInbox=function(){ try{ window.fs.cleanInbox(); }catch(e){} };
  ['deletePhoto','download','exportKmz','exportPhotos','exportPhotosAll','fileSha','importKmz','netdiskPick','netdiskUpload','peerStart','peerStop','photoSha','readFileBase','readFileText','shareBuilding','shareFile'].forEach(function(m){ Android[m]=function(){ console.log('[win] '+m+' not supported'); return null; }; });
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

        // 照片导入：解压 ZIP 抽取图片（GBK 探测，对齐安卓 unzipImages）
        private static string Sanitize(string s) => Regex.Replace(s ?? "x", @"[\\/:*?""<>|]", "_");
        private static Encoding DetectZipEncoding(string src)
        {
            // Windows/7-Zip 中文名 ZIP 常用 GBK/GB18030；依次尝试 UTF-8→GBK→GB18030
            var encodings = new[] { Encoding.UTF8, Encoding.GetEncoding("GBK"), Encoding.GetEncoding("GB18030") };
            foreach (var enc in encodings)
            {
                try
                {
                    bool bad = false; int cnt = 0;
                    using (var zf = ZipFile.OpenRead(src))
                    {
                        foreach (var e in zf.Entries)
                        {
                            var raw = e.FullName; // 默认按系统码页解，下面用 enc 重新解码名
                            var bytes = Encoding.GetEncoding("IBM437").GetBytes(raw.Contains("�") ? "" : raw);
                            try { enc.GetString(bytes); } catch { bad = true; break; }
                            if (raw.Contains("�")) { bad = true; break; }
                            if (++cnt >= 8) break;
                        }
                    }
                    if (!bad) return enc;
                }
                catch { }
            }
            return Encoding.UTF8;
        }
        public string unzipImages(string srcPath)
        {
            try
            {
                var src = Path.GetFullPath(srcPath);
                if (!File.Exists(src)) return "[]";
                var enc = DetectZipEncoding(src);
                var uzDir = Path.Combine(_base, "inbox", "uz_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                Directory.CreateDirectory(uzDir);
                var entries = new System.Collections.Generic.List<object>();
                using (var zf = ZipFile.OpenRead(src))
                {
                    foreach (var e in zf.Entries)
                    {
                        if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) continue;
                        if (!Regex.IsMatch(e.Name, @"(?i)\.(jpg|jpeg|png|gif|bmp|webp)$")) continue;
                        var decoded = DecodeEntryName(e.FullName, enc);
                        var shortName = decoded.Contains("/") ? decoded.Substring(decoded.LastIndexOf("/") + 1) : decoded;
                        var folder = decoded.Contains("/") ? decoded.Substring(0, decoded.LastIndexOf("/")) : "";
                        var outPath = Path.Combine(uzDir, Sanitize(shortName));
                        e.ExtractToFile(outPath, true);
                        entries.Add(new { name = Sanitize(shortName), path = outPath, folder = folder });
                    }
                }
                return JsonSerializer.Serialize(entries);
            }
            catch (Exception ex)
            {
                Console.WriteLine("[win] unzipImages err: " + ex.Message);
                return "[]";
            }
        }
        private static string DecodeEntryName(string raw, Encoding enc)
        {
            // ZIP 条目名按 IBM437 存，用目标编码重新解释
            try { return enc.GetString(Encoding.GetEncoding("IBM437").GetBytes(raw)); }
            catch { return raw; }
        }
        public string linkPhoto(string buildingId, string srcPath, string name)
        {
            try
            {
                var bid = Sanitize(buildingId);
                var dir = Path.Combine(_base, "photos", bid);
                Directory.CreateDirectory(dir);
                var outPath = Path.Combine(dir, Sanitize(name));
                if (File.Exists(srcPath)) File.Copy(srcPath, outPath, true);
                return "photos/" + bid + "/" + Sanitize(name);
            }
            catch (Exception ex) { Console.WriteLine("[win] linkPhoto err: " + ex.Message); return ""; }
        }
        public string fileSha256(string path)
        {
            try { using var sha = SHA256.Create(); using var fs = File.OpenRead(path); var h = sha.ComputeHash(fs); return BitConverter.ToString(h).Replace("-", "").ToLower(); }
            catch { return ""; }
        }
        public string photoSha256(string relPath)
        {
            try { return fileSha256(Path.Combine(_base, relPath.Replace("/", "\\"))); }
            catch { return ""; }
        }
        public void cleanInbox()
        {
            try
            {
                var inbox = Path.Combine(_base, "inbox");
                if (!Directory.Exists(inbox)) return;
                foreach (var d in Directory.GetDirectories(inbox))
                    if (Path.GetFileName(d).StartsWith("uz_")) Directory.Delete(d, true);
            }
            catch { }
        }
    }
}

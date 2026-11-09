package com.gujian;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.widget.Toast;
import android.content.ContentResolver;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.net.ServerSocket;
import java.net.Socket;
import java.io.BufferedReader;
import java.io.InputStreamReader;

public class MainActivity extends Activity {
    private WebView wv;
    private static final int REQ_LOC = 1001;
    private static final int REQ_FILE = 1002;   // 文件选择（照片 / 导入）
    private static final int REQ_SAVE = 1003;   // SAF 导出保存位置
    private static final int REQ_TREE_IMPORT = 1010; // 文件夹选择（批量导入）
    private static final int REQ_TREE_EXPORT = 1011; // 文件夹选择（批量导出）
    private static final int REQ_ZIP_IMPORT  = 1012; // zip 文件选择（批量导入）
    private static final int REQ_LAN_SHARE   = 1020; // 局域网互传：选择要共享的文件
    private ValueCallback<Uri[]> filePathCallback;
    // 导出状态：分块累积缓冲 + 抗 Activity 重建（静态，避免 SAF 期间重建导致 pending 丢失 → 写入 0 字节）
    private static String pendingExportName;
    private static String pendingExportMime;
    // 分块导出：exportAppend 每片 base64 即时解码为字节累加到 pendingExportBytes；
    // exportCommit 把流对象移交给 pendingExportBaos 供 onActivityResult 直接 writeTo（避免巨型 String + 一次性 decode → OOM → 0 字节）。
    // 旧字段 pendingExportB64(StringBuilder/巨型 String) 已废弃 —— 它是 >30 张照片导出 0 字节的真凶。
    private static ByteArrayOutputStream pendingExportBytes; // 累积中
    private static ByteArrayOutputStream pendingExportBaos;  // 已就绪、等待写盘
    private static boolean pendingExportBad; // 分块过程中任一片解码失败标记
    private String pendingImportKind;        // "photos" | "sheets"
    private String pendingExportFilesJson;   // JSON 数组 [{name, b64}]
    // 文件夹批量导入：记录每个文件 URI 的相对目录（用于照片智能匹配文件夹上下文，item ⑥）
    private final java.util.HashMap<String, String> treeImportRel = new java.util.HashMap<>();
    // 局域网互传服务端（item 5）
    private ServerSocket lanServer = null;
    private byte[] lanShareBytes = null;     // 待共享文件字节（服务端）
    // 照片导入：原生线程池异步解压（item 1 根因修复：解压/缩略图全在原生线程，彻底避开 WebView OOM）
    private final ExecutorService zipExecutor = Executors.newSingleThreadExecutor();
    private File inboxDir() { return new File(getCacheDir(), "inbox"); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wv = new WebView(this);
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true); // IndexedDB 依赖
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(false);
        // 页面是 file://，底图/接口走 https，允许混合内容
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // 定位：WebView 地理权限 + 数据库路径
        ws.setGeolocationEnabled(true);
        ws.setGeolocationDatabasePath(getFilesDir().getPath());
        // 供网页调用原生能力（定位设置 / 第三方导航 / 文件保存）
        wv.addJavascriptInterface(new AppBridge(), "AndroidBridge");
        wv.setWebViewClient(new WebViewClient());
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // 内部工具：自动授权地理权限（用户仍可在系统设置中撤销）
                callback.invoke(origin, true, false);
            }

            // 文件选择：照片上传、导入 ovkmz/kmz/kml/csv/zip/7z 均走系统选择器
            // 不用 params.createIntent()（Chromium 按 accept 解析生成 ACTION_GET_CONTENT + EXTRA_MIME_TYPES，
            // .ovkmz/.7z 等无 MIME 映射的扩展名会混入非法 MIME 列表 → 部分机型 DocumentsUI 打开异常/空白/「点了没反应」）
            // 统一用 ACTION_OPEN_DOCUMENT + */*：系统自带 DocumentsUI 必然可打开，所有文件可见可选，格式由前端扩展名校验
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                             WebChromeClient.FileChooserParams params) {
                filePathCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(intent, REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
        setContentView(wv);
        wv.loadUrl("file:///android_asset/www/index.html");
        cleanupInbox(); // 启动时清理上次可能残留的导入临时目录（item 1 根因防护之三）

        // 运行时定位权限（Android 6+）
        if (Build.VERSION.SDK_INT >= 23) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }, REQ_LOC);
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // 文件选择回传
        if (requestCode == REQ_FILE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) { // 多选
                    int n = data.getClipData().getItemCount();
                    results = new Uri[n];
                    for (int i = 0; i < n; i++) results[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) { // 单选
                    results = new Uri[]{ data.getData() };
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        // SAF 导出保存位置回传
        if (requestCode == REQ_SAVE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExportBaos != null && pendingExportBaos.size() > 0) {
                OutputStream os = null;
                try {
                    os = getContentResolver().openOutputStream(data.getData());
                    pendingExportBaos.writeTo(os); // 直接写出已解码字节，无需再次 base64 解码（消除 OOM 根因）
                    os.close(); os = null;
                    // 写出成功 → 回调前端，由前端在「真正写完」后才提示成功（杜绝假成功）
                    postJs("APP.onExportResult(true, " + JSONObject.quote((pendingExportName != null ? pendingExportName : "文件")) + ")");
                } catch (Exception e) {
                    if (os != null) { try { os.close(); } catch (Exception ignore) {} }
                    postJs("APP.onExportResult(false, " + JSONObject.quote("导出失败：" + (e.getMessage() != null ? e.getMessage() : "未知错误")) + ")");
                }
            } else if (resultCode != RESULT_OK) {
                // 用户取消 SAF：明确告知，不再假装成功
                postJs("APP.onExportResult(false, '已取消保存')");
            } else {
                postJs("APP.onExportResult(false, '导出数据为空，未生成文件')");
            }
            pendingExportBaos = null;
            pendingExportName = null;
            pendingExportMime = null;
            return;
        }
        // 文件夹选择（批量导入）：枚举树并逐文件回调前端
        if (requestCode == REQ_TREE_IMPORT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) doTreeImport(data.getData());
            else postJs("APP.receiveCancel(" + JSONObject.quote(pendingImportKind == null ? "" : pendingImportKind) + ")");
            pendingImportKind = null;
            return;
        }
        // zip 文件选择（批量导入）
        if (requestCode == REQ_ZIP_IMPORT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) doZipImport(data.getData());
            else postJs("APP.receiveCancel(" + JSONObject.quote(pendingImportKind == null ? "" : pendingImportKind) + ")");
            pendingImportKind = null;
            return;
        }
        // 文件夹选择（批量导出）：写入多个文件到所选目录
        if (requestCode == REQ_TREE_EXPORT) {
            if (resultCode != RESULT_OK) pendingExportFilesJson = null;
            else doTreeExport(data.getData());
            return;
        }
        // 局域网互传：选择要共享的文件 → 读取字节并启动服务端
        if (requestCode == REQ_LAN_SHARE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                try {
                    android.content.ContentResolver cr = getContentResolver();
                    java.io.InputStream is = cr.openInputStream(data.getData());
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192]; int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();
                    lanShareBytes = bos.toByteArray();
                    startLanServerNow("7205");
                } catch (Exception e) {
                    Toast.makeText(this, "读取共享文件失败：" + (e.getMessage() != null ? e.getMessage() : ""), Toast.LENGTH_LONG).show();
                }
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // 结果不影响页面加载；若被拒，网页端定位失败时会引导去系统设置
    }

    @Override
    public void onBackPressed() {
        // 优先逐级关闭前端浮层（弹窗 > 抽屉 > 测距 > 列表），避免"进去了退不出"
        try {
            wv.evaluateJavascript("(()=>{try{return (window.APP&&typeof window.APP.back==='function')?window.APP.back():false}catch(e){return false}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if ("true".equals(handled)) return; // 已处理浮层关闭
                        if (wv.canGoBack()) wv.goBack();
                        else MainActivity.super.onBackPressed();
                    }
                });
        } catch (Exception e) {
            if (wv.canGoBack()) wv.goBack();
            else super.onBackPressed();
        }
    }

    /** JS 桥：定位设置 / 第三方导航 / SAF 导出 / 批量导入导出 */
    public class AppBridge {
        @JavascriptInterface
        public void openLocationSettings() {
            try {
                Intent i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                startActivity(i);
            } catch (Exception e) { /* 网页端已兜底提示 */ }
        }

        @JavascriptInterface
        public void openNav(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(Intent.createChooser(i, "选择导航应用"));
            } catch (Exception e) { /* 忽略 */ }
        }

        // 导出文件（分块，规避 Binder 1MB 事务上限 + 巨型 base64 String 一次解码 OOM → 0 字节）
        // 流程：exportStart → exportAppend(每片≤512KB base64, 即时解码累加到字节流)… → exportCommit() 唤起 SAF → 直接 writeTo 写盘 → 回调 APP.onExportResult
        @JavascriptInterface
        public void exportStart(final String filename, final String mime) {
            pendingExportName = filename;
            pendingExportMime = (mime != null && !mime.isEmpty()) ? mime : "application/octet-stream";
            pendingExportBytes = new ByteArrayOutputStream();
            pendingExportBad = false;
        }
        @JavascriptInterface
        public void exportAppend(final String chunkB64) {
            if (pendingExportBytes != null && chunkB64 != null && !chunkB64.isEmpty()) {
                try {
                    // 每片即时解码为字节，避免整包 base64 巨型 String + 一次性 decode 触发 OOM（>30 张照片 0 字节根因）
                    byte[] chunk = android.util.Base64.decode(chunkB64, android.util.Base64.DEFAULT);
                    pendingExportBytes.write(chunk, 0, chunk.length);
                } catch (Exception e) {
                    pendingExportBad = true; // 单片损坏标记，commit 时如实报告失败
                }
            }
        }
        @JavascriptInterface
        public void exportCommit() {
            final ByteArrayOutputStream baos = pendingExportBytes;
            pendingExportBytes = null;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (baos == null || baos.size() == 0 || pendingExportBad) {
                            postJs("APP.onExportResult(false, '导出数据为空或已损坏，未生成文件')");
                            return;
                        }
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType(pendingExportMime);
                        intent.putExtra(Intent.EXTRA_TITLE, (pendingExportName != null && !pendingExportName.isEmpty()) ? pendingExportName : "export.bin");
                        pendingExportBaos = baos; // 直接持有解码后字节流，onActivityResult 写出（不再二次 decode）
                        startActivityForResult(intent, REQ_SAVE);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "无法打开保存位置", Toast.LENGTH_SHORT).show();
                        postJs("APP.onExportResult(false, '无法打开保存位置')");
                    }
                }
            });
        }
        // 旧式整包导出（降级用，仅小文件安全）：同样即时解码为字节，避免整包 String 滞留导致 OOM
        @JavascriptInterface
        public void exportFile(final String filename, final String base64, final String mime) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType((mime != null && !mime.isEmpty()) ? mime : "application/octet-stream");
                        intent.putExtra(Intent.EXTRA_TITLE, (filename != null && !filename.isEmpty()) ? filename : "export.bin");
                        byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                        if (bytes.length == 0) throw new Exception("压缩包为空（0 字节）");
                        pendingExportName = filename;
                        pendingExportBaos = new ByteArrayOutputStream();
                        pendingExportBaos.write(bytes, 0, bytes.length);
                        startActivityForResult(intent, REQ_SAVE);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "无法打开保存位置", Toast.LENGTH_SHORT).show();
                        postJs("APP.onExportResult(false, '无法打开保存位置')");
                    }
                }
            });
        }

        // 批量导入：唤起 SAF「打开文档树」选择器（手机文件夹）
        @JavascriptInterface
        public void pickImportFolder(String kind) {
            pendingImportKind = kind;
            try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE_IMPORT); }
            catch (Exception e) { Toast.makeText(MainActivity.this, "无法打开文件夹选择器", Toast.LENGTH_SHORT).show(); }
        }
        // 批量导入：唤起 SAF「打开文档」选择器（zip 压缩包）
        @JavascriptInterface
        public void pickImportZip(String kind) {
            pendingImportKind = kind;
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/zip");
                startActivityForResult(i, REQ_ZIP_IMPORT);
            } catch (Exception e) { Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show(); }
        }
        // 批量导出：唤起 SAF「打开文档树」选择器（目标文件夹），写入多个文件
        @JavascriptInterface
        public void exportFilesToTree(String json) {
            pendingExportFilesJson = json;
            try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE_EXPORT); }
            catch (Exception e) { Toast.makeText(MainActivity.this, "无法打开文件夹选择器", Toast.LENGTH_SHORT).show(); }
        }

        // 网盘导入导出（item 4，凭证门控）：未配置凭证时明确提示，绝不伪造可用
        @JavascriptInterface
        public void netdiskImport(String provider, String kind) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                "网盘导入需先配置 " + (provider == null ? "" : provider) + " 凭证（AppKey/Token），详见帮助文档", Toast.LENGTH_LONG).show());
        }
        @JavascriptInterface
        public void netdiskExport(String provider, String fmt) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                "网盘导出需先配置 " + (provider == null ? "" : provider) + " 凭证（AppKey/Token），详见帮助文档", Toast.LENGTH_LONG).show());
        }

        // 手机互传（item 5）：选择要共享的文件，随后自动开启局域网服务端
        @JavascriptInterface
        public void pickLanShare() {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, REQ_LAN_SHARE);
            } catch (Exception e) { Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show(); }
        }
        @JavascriptInterface
        public void stopLanServer() {
            try { if (lanServer != null) lanServer.close(); } catch (Exception e) {}
            lanServer = null;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, "服务端已停止", Toast.LENGTH_SHORT).show());
        }

        // 持久化全图：把 inbox 临时全图拷贝到 app 私有 photos 目录，返回新路径（导入完成调用，避免 cleanInbox 误删）
        @JavascriptInterface
        public String persistImage(String srcPath) {
            try {
                File src = new File(srcPath);
                if (!src.exists()) return "";
                File dir = new File(getFilesDir(), "photos"); dir.mkdirs();
                String dstName = "p_" + System.currentTimeMillis() + "_" + Math.abs(src.getName().hashCode()) + ".jpg";
                File dst = new File(dir, dstName);
                FileInputStream fis = new FileInputStream(src);
                FileOutputStream fos = new FileOutputStream(dst);
                byte[] buf = new byte[65536]; int n;
                while ((n = fis.read(buf)) > 0) fos.write(buf, 0, n);
                fis.close(); fos.close();
                return dst.getAbsolutePath();
            } catch (Exception e) { return ""; }
        }
        // 按需单张加载全图（灯箱/保存/导出时调用，一次一张，绝不堆积内存）
        @JavascriptInterface
        public String loadFullImage(String fullPath) {
            try {
                File f = new File(fullPath);
                if (!f.exists()) return "";
                FileInputStream fis = new FileInputStream(f);
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[65536]; int n;
                while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
                fis.close();
                boolean png = fullPath.toLowerCase().endsWith(".png");
                return "data:" + (png ? "image/png" : "image/jpeg") + ";base64," + android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
            } catch (Exception e) { return ""; }
        }
        // 清理导入缓存：删除 inbox/uz_* 临时目录（导入完成 / 启动 / 菜单调用）
        @JavascriptInterface
        public void cleanInbox() { cleanupInbox(); }
    }

    // 启动局域网服务端（在后台线程读取 Socket，简单 HTTP 返回共享文件字节）
    private void startLanServerNow(final String port) {
        if (lanServer != null) { runOnUiThread(() -> Toast.makeText(MainActivity.this, "服务端已在运行", Toast.LENGTH_SHORT).show()); return; }
        if (lanShareBytes == null) { runOnUiThread(() -> Toast.makeText(MainActivity.this, "未选择要共享的文件", Toast.LENGTH_SHORT).show()); return; }
        try {
            final int p = Integer.parseInt(port == null ? "7205" : port);
            lanServer = new ServerSocket(p);
            new Thread(() -> {
                android.util.Log.i("Gujian", "LAN server started on " + p);
                while (lanServer != null && !lanServer.isClosed()) {
                    try { Socket sock = lanServer.accept(); handleLanClient(sock); }
                    catch (Exception e) { /* 服务端关闭时退出 */ }
                }
            }).start();
            runOnUiThread(() -> Toast.makeText(MainActivity.this, "服务端已开启（端口 " + p + "），请在客户端输入本机局域网 IP", Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            lanServer = null;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, "无法开启服务端：" + (e.getMessage() != null ? e.getMessage() : ""), Toast.LENGTH_LONG).show());
        }
    }
    private void handleLanClient(Socket sock) {
        try {
            sock.setSoTimeout(30000);
            BufferedReader br = new BufferedReader(new InputStreamReader(sock.getInputStream()));
            br.readLine(); // 丢弃请求行
            byte[] data = lanShareBytes;
            OutputStream os = sock.getOutputStream();
            String header = "HTTP/1.1 200 OK\r\nContent-Length: " + (data == null ? 0 : data.length)
                + "\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n";
            os.write(header.getBytes("UTF-8"));
            if (data != null) os.write(data);
            os.flush();
        } catch (Exception e) { /* ignore */ }
        finally { try { sock.close(); } catch (Exception e) {} }
    }

    // ---------- 批量导入导出（框架 DocumentsContract，无需 AndroidX）----------
    private void postJs(final String js) { wv.post(() -> wv.evaluateJavascript(js, null)); }
    private void cleanupInbox() {
        try { File inb = inboxDir(); if (inb.exists()) deleteRecursively(inb); } catch (Exception e) {}
    }
    private void deleteRecursively(File f) {
        if (f.isDirectory()) { File[] cs = f.listFiles(); if (cs != null) for (File c : cs) deleteRecursively(c); }
        f.delete();
    }

    private void doTreeImport(Uri treeUri) {
        final String kind = pendingImportKind;
        treeImportRel.clear();
        ArrayList<Uri> files = listTreeFiles(treeUri);
        int cnt = 0;
        for (Uri u : files) {
            String[] meta = fileMeta(u);
            String name = meta[0];
            if (name == null) continue;
            String lower = name.toLowerCase();
            // 相对目录（用于文件夹上下文智能匹配，item ⑥）；根目录直接文件则 folder 为空串
            String folder = treeImportRel.get(u.toString());
            if (folder == null) folder = "";
            try {
                if ("photos".equals(kind)) {
                    if (!isImage(lower)) continue;
                    byte[] b = readBytes(u);
                    String b64 = android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
                    postJs("APP.receivePhoto(" + JSONObject.quote(name) + "," + JSONObject.quote(b64) + "," + JSONObject.quote(folder) + ")");
                    cnt++;
                } else {
                    if (!isSheet(lower)) continue;
                    byte[] b = readBytes(u);
                    String ext = extOf(lower);
                    String text = "xlsx".equals(ext) ? (xlsxToCsv(b) != null ? xlsxToCsv(b) : "") : new String(b, java.nio.charset.StandardCharsets.UTF_8);
                    postJs("APP.receiveSheet(" + JSONObject.quote(name) + "," + JSONObject.quote(text) + "," + JSONObject.quote(ext) + ")");
                    cnt++;
                }
            } catch (Exception e) { /* 跳过不可读文件 */ }
        }
        final int f = cnt;
        postJs("APP.receiveDone(" + JSONObject.quote(kind == null ? "" : kind) + ",'tree'," + f + ")");
    }

    // v2.4 三级匹配：查询 SAF 文件显示名（zip 导入时下发给 JS，用于按压缩包名优先匹配城市）
    private String queryDisplayName(Uri uri) {
        try {
            Cursor c = getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) {
                        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (idx >= 0) return c.getString(idx);
                    }
                } finally { c.close(); }
            }
        } catch (Exception e) { /* 查不到名字则跳过 zip 名匹配 */ }
        return null;
    }

    // 照片压缩包导入：原生线程池异步解压 + 流式写盘 + 原生缩略图 + 内容哈希，逐张回调 JS（彻底避开 WebView OOM，item 1 根因修复）
    private void doZipImport(Uri zipUri) {
        final String kind = pendingImportKind;
        if (!"photos".equals(kind)) { doZipImportSheets(zipUri); return; }
        // v2.4 三级匹配第一级：zip 文件名下发 JS（如 西安.zip → 优先在西安范围内匹配）
        String zipName0 = queryDisplayName(zipUri);
        if (zipName0 != null && zipName0.length() > 0) {
            postJs("window.onZipName&&window.onZipName(" + JSONObject.quote(zipName0) + ")");
        }
        cleanupInbox();
        final File uz = new File(inboxDir(), "uz_" + System.currentTimeMillis());
        uz.mkdirs();
        final Uri z = zipUri;
        zipExecutor.execute(new Runnable() {
            public void run() {
                try {
                    int total = 0, done = 0;
                    // 第一遍：统计照片总数（用于进度）
                    InputStream is0 = getContentResolver().openInputStream(z);
                    ZipInputStream z0 = new ZipInputStream(is0);
                    ZipEntry e0;
                    while ((e0 = z0.getNextEntry()) != null) {
                        String n0 = e0.getName();
                        if (n0 != null && !e0.isDirectory() && isImage(n0.toLowerCase())) total++;
                        z0.closeEntry();
                    }
                    z0.close(); is0.close();
                    // 第二遍：流式写盘 + 缩略图 + 内容哈希，逐张回调 JS（收齐后 JS 再匹配）
                    InputStream is = getContentResolver().openInputStream(z);
                    ZipInputStream zis = new ZipInputStream(is);
                    ZipEntry e;
                    while ((e = zis.getNextEntry()) != null) {
                        String name = e.getName();
                        if (name == null || e.isDirectory()) { zis.closeEntry(); continue; }
                        String lower = name.toLowerCase();
                        if (!isImage(lower)) { zis.closeEntry(); continue; }
                        // 流式写全图到磁盘（不在内存堆积）
                        File full = new File(uz, "full_" + sanitizeName(name));
                        FileOutputStream fos = new FileOutputStream(full);
                        MessageDigest md = MessageDigest.getInstance("SHA-256");
                        byte[] buf = new byte[65536]; int n;
                        while ((n = zis.read(buf)) > 0) { fos.write(buf, 0, n); md.update(buf, 0, n); }
                        fos.close();
                        String hash = toHex(md.digest());
                        String thumb = makeThumb(full.getAbsolutePath()); // 原生降采样缩略图（≤720px RGB_565 JPEG q72）
                        int si = name.lastIndexOf('/');
                        String folder = si >= 0 ? name.substring(0, si) : "";
                        done++;
                        JSONObject o = new JSONObject();
                        o.put("name", name); o.put("folder", folder);
                        o.put("thumb", thumb); o.put("fullPath", full.getAbsolutePath()); o.put("hash", hash);
                        final String js = "window.onUnzipImages&&window.onUnzipImages(" + o.toString() + "," + done + "," + total + ")";
                        postJs(js);
                    }
                    zis.close(); is.close();
                    final int f = done;
                    postJs("window.onUnzipImagesEnd&&window.onUnzipImagesEnd(" + f + ")");
                } catch (Exception ex) {
                    postJs("APP.receiveError(" + JSONObject.quote(ex.getMessage() == null ? "压缩包读取失败" : ex.getMessage()) + ")");
                }
            }
        });
    }
    // 表格压缩包导入（保持原逻辑，文本体积小不会 OOM）
    private void doZipImportSheets(Uri zipUri) {
        final String kind = pendingImportKind;
        try {
            InputStream is = getContentResolver().openInputStream(zipUri);
            ZipInputStream zis = new ZipInputStream(is);
            ZipEntry e;
            int cnt = 0;
            while ((e = zis.getNextEntry()) != null) {
                String name = e.getName();
                if (name == null || e.isDirectory()) { zis.closeEntry(); continue; }
                String lower = name.toLowerCase();
                try {
                    if (isSheet(lower)) {
                        byte[] b = readZipEntry(zis);
                        String ext = extOf(lower);
                        String text = "xlsx".equals(ext) ? (xlsxToCsv(b) != null ? xlsxToCsv(b) : "") : new String(b, java.nio.charset.StandardCharsets.UTF_8);
                        postJs("APP.receiveSheet(" + JSONObject.quote(name) + "," + JSONObject.quote(text) + "," + JSONObject.quote(ext) + ")");
                        cnt++;
                    }
                } catch (Exception ex) { /* 跳过该条目 */ }
                zis.closeEntry();
            }
            zis.close(); is.close();
            final int f = cnt;
            postJs("APP.receiveDone(" + JSONObject.quote(kind == null ? "" : kind) + ",'zip'," + f + ")");
        } catch (Exception ex) {
            postJs("APP.receiveError(" + JSONObject.quote(ex.getMessage() == null ? "压缩包读取失败" : ex.getMessage()) + ")");
        }
    }
    // 原生缩略图：BitmapFactory 降采样（RGB_565）+ JPEG q72，长边 ≤720px，返回 dataURL（小，安全进 WebView）
    private String makeThumb(String fullPath) {
        try {
            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(fullPath, opt);
            int w = opt.outWidth, h = opt.outHeight;
            int max = 720;
            int longer = Math.max(w, h);
            int inSample = 1;
            if (longer > max) inSample = (int) Math.ceil((double) longer / max);
            opt.inJustDecodeBounds = false;
            opt.inPreferredConfig = Bitmap.Config.RGB_565;
            opt.inSampleSize = inSample;
            Bitmap bmp = BitmapFactory.decodeFile(fullPath, opt);
            if (bmp == null) return "";
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 72, bos);
            bmp.recycle();
            String b64 = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
            return "data:image/jpeg;base64," + b64;
        } catch (Exception e) { return ""; }
    }
    private String toHex(byte[] b) {
        final String H = "0123456789abcdef";
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) { sb.append(H.charAt((x >> 4) & 0xf)); sb.append(H.charAt(x & 0xf)); }
        return sb.toString();
    }
    private String sanitizeName(String name) {
        String s = name == null ? "" : name.replace('\\', '/');
        int i = s.lastIndexOf('/');
        s = (i >= 0 ? s.substring(i + 1) : s);
        return s.replaceAll("[^A-Za-z0-9._\\-]", "_");
    }

    private void doTreeExport(Uri treeUri) {
        try {
            JSONArray arr = new JSONArray(pendingExportFilesJson);
            int ok = 0;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String name = o.getString("name");
                String b64 = o.getString("b64");
                byte[] b = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                if (writeFileInTree(treeUri, name, b) != null) ok++;
            }
            final int f = ok;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, "已导出 " + f + " 个文件到所选文件夹", Toast.LENGTH_SHORT).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, "导出失败：" + (e.getMessage() != null ? e.getMessage() : ""), Toast.LENGTH_LONG).show());
        }
        pendingExportFilesJson = null;
    }

    private Uri writeFileInTree(Uri treeUri, String relPath, byte[] data) {
        try {
            String treeId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeId);
            String[] parts = relPath.split("/");
            for (int i = 0; i < parts.length - 1; i++) {
                Uri d = DocumentsContract.createDocument(getContentResolver(), parent, DocumentsContract.Document.MIME_TYPE_DIR, parts[i]);
                if (d == null) return null;
                parent = d;
            }
            String fileName = parts[parts.length - 1];
            Uri fileUri = DocumentsContract.createDocument(getContentResolver(), parent, mimeFor(fileName), fileName);
            if (fileUri == null) return null;
            OutputStream os = getContentResolver().openOutputStream(fileUri);
            os.write(data); os.close();
            return fileUri;
        } catch (Exception e) { return null; }
    }

    private ArrayList<Uri> listTreeFiles(Uri treeUri) {
        ArrayList<Uri> out = new ArrayList<>();
        try {
            String treeId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeId);
            listChildren(childrenUri, treeUri, out, "");
        } catch (Exception e) { /* ignore */ }
        return out;
    }
    private void listChildren(Uri childrenUri, Uri treeUri, ArrayList<Uri> out, String prefix) {
        ContentResolver cr = getContentResolver();
        Cursor c = null;
        try {
            c = cr.query(childrenUri, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            }, null, null, null);
            if (c == null) return;
            int idxId = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int idxName = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            while (c.moveToNext()) {
                String docId = c.getString(idxId);
                String name = c.getString(idxName);
                String mime = c.getString(c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE));
                Uri childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    String np = (prefix == null || prefix.isEmpty()) ? name : (prefix + "/" + name);
                    Uri sub = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
                    listChildren(sub, treeUri, out, np);
                } else {
                    out.add(childUri);
                    treeImportRel.put(childUri.toString(), (prefix == null) ? "" : prefix);
                }
            }
        } catch (Exception e) { /* ignore */ }
        finally { if (c != null) c.close(); }
    }
    private String[] fileMeta(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            }, null, null, null);
            if (c != null && c.moveToFirst()) {
                return new String[]{
                    c.getString(c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)),
                    c.getString(c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE))
                };
            }
        } catch (Exception e) { /* ignore */ }
        finally { if (c != null) c.close(); }
        return new String[]{ null, null };
    }
    private byte[] readBytes(Uri uri) throws Exception {
        InputStream is = getContentResolver().openInputStream(uri);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close(); return bos.toByteArray();
    }
    private byte[] readZipEntry(ZipInputStream zis) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = zis.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }
    private boolean isImage(String l) {
        return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") || l.endsWith(".gif") || l.endsWith(".bmp") || l.endsWith(".webp");
    }
    private boolean isSheet(String l) {
        return l.endsWith(".csv") || l.endsWith(".tsv") || l.endsWith(".txt") || l.endsWith(".kml") || l.endsWith(".gpx") || l.endsWith(".json") || l.endsWith(".xlsx");
    }
    private String extOf(String l) { int i = l.lastIndexOf('.'); return i >= 0 ? l.substring(i + 1) : ""; }
    private String mimeFor(String name) {
        String l = name.toLowerCase();
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".gif")) return "image/gif";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".bmp")) return "image/bmp";
        if (l.endsWith(".csv") || l.endsWith(".tsv")) return "text/csv";
        if (l.endsWith(".txt")) return "text/plain";
        if (l.endsWith(".kml")) return "application/vnd.google-earth.kml+xml";
        if (l.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }
    // 最佳努力：xlsx -> csv 文本（仅支持基础共享字符串 + 数值单元格）
    private String xlsxToCsv(byte[] bytes) {
        try {
            ZipInputStream zis = new ZipInputStream(new java.io.ByteArrayInputStream(bytes));
            ZipEntry e;
            String shared = null, sheet = null;
            while ((e = zis.getNextEntry()) != null) {
                String n = e.getName();
                if (n.equals("xl/sharedStrings.xml")) shared = readStream(zis);
                else if (n.startsWith("xl/worksheets/sheet") && n.endsWith(".xml")) { if (sheet == null) sheet = readStream(zis); }
                zis.closeEntry();
            }
            zis.close();
            if (sheet == null) return null;
            ArrayList<String> ss = new ArrayList<>();
            if (shared != null) {
                Matcher m = Pattern.compile("<t[^>]*>(.*?)</t>", Pattern.DOTALL).matcher(shared);
                while (m.find()) ss.add(unescapeXml(m.group(1)));
            }
            StringBuilder out = new StringBuilder();
            Matcher rowM = Pattern.compile("<row\\b[^>]*>(.*?)</row>", Pattern.DOTALL).matcher(sheet);
            while (rowM.find()) {
                String rowXml = rowM.group(1);
                ArrayList<String> cells = new ArrayList<>();
                Matcher cM = Pattern.compile("<c\\b([\\s\\S]*?)</c>", Pattern.DOTALL).matcher(rowXml);
                while (cM.find()) {
                    String c = cM.group(1);
                    boolean sharedStr = c.contains("t=\"s\"");
                    Matcher vM = Pattern.compile("<v>(.*?)</v>", Pattern.DOTALL).matcher(c);
                    String val = vM.find() ? vM.group(1) : "";
                    if (sharedStr && val.matches("\\d+")) {
                        int idx = Integer.parseInt(val);
                        val = idx < ss.size() ? ss.get(idx) : "";
                    }
                    val = val.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                            .replace("&quot;", "\"").replace("&apos;", "'").replace("\"", "\"\"");
                    cells.add("\"" + val + "\"");
                }
                out.append(String.join(",", cells)).append("\n");
            }
            return out.toString();
        } catch (Exception ex) { return null; }
    }
    private String readStream(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
    }
    private String unescapeXml(String s) {
        return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&apos;", "'");
    }
}

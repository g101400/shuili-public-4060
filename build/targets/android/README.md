# 水利工程基础信息一张图 · Android APK

WebView 外壳应用，内嵌 `水利工程基础信息一张图` PWA（基于天地图，支持浏览/筛选/增删改/多照片/ovkmz 导入导出）。

## 目录结构
- `app/src/main/assets/www/` — 内嵌的 PWA（来自 `D:/Users/WorkBuddy/shuili/webroot`）
- `app/src/main/java/com/shuili/MainActivity.java` — WebView 加载上面的 index.html
- `app/src/main/AndroidManifest.xml` — 联网权限 + 竖屏
- `local.properties` — 指向 `D:/Users/WorkBuddy/android_build/android-sdk`
- `build.gradle` / `app/build.gradle` — AGP 8.5.2，compileSdk/targetSdk 34，minSdk 24

## 编译（已装好 JDK17 + SDK + Gradle）
```bash
bash build_apk.sh
```
产物：`D:/Users/WorkBuddy/shuili/releases/ShuiliYitu-debug.apk`

## 手动编译
```bash
export JAVA_HOME=/c/android_build/jdk/jdk-17.0.12+7
export PATH=$JAVA_HOME/bin:$PATH
/c/android_build/gradle-8.10/bin/gradle -p /c/android_build/ShuiliApp assembleDebug
# 取出：app/build/outputs/apk/debug/app-debug.apk
```

## 重编前更新内容
改完 `gujian_app/` 后，运行 `build_apk.sh` 会自动把 PWA 资源同步进 assets 并重新编译。
若改了建筑物数据，先跑 `gujian_app/prep_data.py` 重新生成 `data.js`。

## 说明
- 底图（天地图矢量/注记）需联网；增删改数据存于本机 IndexedDB，离线可用。
- 导入/导出的 ovkmz 可用奥维地图「导入」识别（doc.kml + files/ 照片）。
- 作者：炎冰

# -*- coding: utf-8 -*-
"""prep_finalize.py —— 预置数据 Step2：把 io.js 解析结果（_prep/recs.json）转为 data.js/data.json
照片策略（与运行时导入一致的统一格式）：
  - dataUrl = Pillow 压缩略图（≤720px, JPEG q72）→ 入库/列表/导出（小，安全进 localStorage）
  - fullPath = "imgdata/<原文件名>" → 全图写 jingmi_app/imgdata/（桌面版 loadFullImage 读全图）
"""
import base64, io, json, os, sys
from PIL import Image

APP = "C:/Users/admin/WorkBuddy/win11/jingmi_app"
PREP = "C:/Users/admin/WorkBuddy/win11/_prep"

recs = json.load(open(os.path.join(PREP, "recs.json"), encoding="utf-8"))
imgdir = os.path.join(APP, "imgdata")
os.makedirs(imgdir, exist_ok=True)

def make_thumb(b64):
    raw = base64.b64decode(b64)
    im = Image.open(io.BytesIO(raw))
    if im.mode != "RGB": im = im.convert("RGB")
    im.thumbnail((720, 720), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=72)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()

photo_total = 0
for r in recs:
    for p in (r.get("photos") or []):
        b64 = p["dataUrl"].split(",")[1]
        fn = p["caption"]  # 原文件名（pic_xxx.jpg）
        # 全图写盘 imgdata/
        with open(os.path.join(imgdir, fn), "wb") as f:
            f.write(base64.b64decode(b64))
        # 略图 dataUrl
        p["dataUrl"] = make_thumb(b64)
        p["fullPath"] = "imgdata/" + fn
        p["hash"] = ""
        photo_total += 1

# 精简字段（与母本 data.js 一致：{id,name,type,office,station,btype,lon,lat,params,photos,description,base}）
out = []
for r in recs:
    out.append({
        "id": r["id"], "name": r["name"], "type": r.get("type") or "",
        "office": r.get("office") or "", "station": r.get("station") or "",
        "btype": r.get("btype") or "", "lon": r.get("lon"), "lat": r.get("lat"),
        "params": r.get("params") or {}, "photos": r.get("photos") or [],
        "description": r.get("description") or "", "base": True,
    })

# ---- 断言 ----
assert len(out) == 557, f"条数 {len(out)} != 557"
assert all(r["lon"] is not None and r["lat"] is not None for r in out), "存在缺坐标"
assert photo_total == 6, f"照片 {photo_total} != 6"
for p in [pp for r in out for pp in r["photos"]]:
    assert len(p["dataUrl"]) < 300000, f"略图过大 {len(p['dataUrl'])}"
    assert os.path.exists(os.path.join(APP, p["fullPath"])), f"全图缺失 {p['fullPath']}"
bt = len({r["btype"] for r in out if r["btype"]})
print(f"断言通过：{len(out)} 条 / 照片 {photo_total} 张（略图+全图）/ 建筑物类型 {bt} 种")

data = {"features": out}
js = "window.__DATA__ = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
open(os.path.join(APP, "data.js"), "w", encoding="utf-8").write(js)
open(os.path.join(APP, "data.json"), "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
print(f"data.js {os.path.getsize(os.path.join(APP,'data.js'))/1024:.0f} KB, data.json {os.path.getsize(os.path.join(APP,'data.json'))/1024:.0f} KB")
print("imgdata/:")
for f in sorted(os.listdir(imgdir)):
    print("  ", f, os.path.getsize(os.path.join(imgdir, f)) // 1024, "KB")

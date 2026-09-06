#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
融合 CSV 与 GeoJSON：
- 读 data.geojson（奥维转出的 407 个建筑物）
- 读 水利工程基础信息.csv（397 行，文件夹路径编码 管理所/渠道段/建筑物类型）
- 按 (名称) 或 (名称, 经纬度) 关联，给每个要素补注：
    office  = 管理所（文件夹第2级）
    station = 管理站/渠道段（文件夹第3级「--」之前）
    btype   = 建筑物类型（文件夹第3级「--」之后）
- 输出 data.json 供 App 使用；原 data.geojson 保留用于导出保真。
"""
import json, csv, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.join(HERE, "data.geojson")
CSV = r"D:/BaiduNetdiskDownload/水利工程基础信息.csv"
OUT = os.path.join(HERE, "data.json")


def load_csv():
    rows = []
    # CSV 用 GBK（BOM/utf-8 均失败）
    with open(CSV, encoding="gbk", errors="replace") as f:
        r = csv.reader(f)
        header = next(r)
        for row in r:
            if len(row) < 5:
                continue
            folder, name, lon, lat, comment = row[0], row[1], row[2], row[3], row[4]
            parts = [p for p in folder.split("/") if p]
            office = parts[1] if len(parts) > 1 else ""
            seg = parts[2] if len(parts) > 2 else ""
            if "--" in seg:
                station, btype = seg.split("--", 1)
            else:
                station, btype = seg, seg
            try:
                lonf, latf = float(lon), float(lat)
            except ValueError:
                lonf = latf = None
            rows.append({
                "name": name, "office": office, "station": station,
                "btype": btype, "lon": lonf, "lat": latf, "comment": comment,
            })
    return rows


def parse_comment(comment):
    """把 Comment 多行文本解析成 dict（桩号/设计流量/闸槛高程…）。"""
    d = {}
    for line in comment.split("\n"):
        line = line.strip()
        if not line:
            continue
        # 形如  "桩号（Km+m） : 0+000"  或  "备注 : |"
        if ":" in line:
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            if v and v != "|":
                d[k] = v
    return d


def main():
    geo = json.load(open(GEO, encoding="utf-8"))
    csv_rows = load_csv()

    # 建索引：优先 (name, 四舍五入经纬度)，退化到 name
    by_name = {}
    by_key = {}
    for c in csv_rows:
        by_name.setdefault(c["name"], c)
        if c["lon"] is not None:
            key = (c["name"], round(c["lon"], 4), round(c["lat"], 4))
            by_key[key] = c

    enriched = []
    missing = 0
    for ft in geo["features"]:
        p = ft["properties"]
        name = p.get("name", "")
        coords = ft["geometry"]["coordinates"]
        lon = coords[0] if coords else None
        lat = coords[1] if coords else None
        rec = by_key.get((name, round(lon, 4), round(lat, 4))) or by_name.get(name)

        office = station = btype = ""
        csv_params = {}
        if rec:
            office, station, btype = rec["office"], rec["station"], rec["btype"]
            csv_params = parse_comment(rec["comment"])
        else:
            # 退路：从 type 字段推导
            t = p.get("type", "")
            if "--" in t:
                station, btype = t.split("--", 1)
            else:
                btype = t
            missing += 1

        # params 合并：GeoJSON 自带 params 优先，CSV 解析结果补缺失项
        params = dict(p.get("params", {}))
        for k, v in csv_params.items():
            if k not in params:
                params[k] = v

        enriched.append({
            "id": ft.get("id") or f"{name}_{round(lon,5)}_{round(lat,5)}",
            "name": name,
            "type": p.get("type", ""),
            "office": office,
            "station": station,
            "btype": btype,
            "lon": lon,
            "lat": lat,
            "params": params,
            "photos": p.get("photos", []),     # 基础数据照片（可能为空）
            "description": p.get("description", ""),
            "base": True,                      # 标记为基础数据（非用户新增）
        })

    out = {
        "generated": True,
        "count": len(enriched),
        "features": enriched,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # 维度统计
    offices = sorted(set(e["office"] for e in enriched if e["office"]))
    stations = sorted(set(e["station"] for e in enriched if e["station"]))
    btypes = sorted(set(e["btype"] for e in enriched if e["btype"]))
    print(f"要素总数: {len(enriched)}")
    print(f"未匹配 CSV 数: {missing}")
    print(f"管理所({len(offices)}): {offices}")
    print(f"建筑物类型({len(btypes)}): {btypes}")
    print(f"渠道段/管理站({len(stations)}): 见下")
    print("  前20:", stations[:20])
    print(f"输出 -> {OUT}")


if __name__ == "__main__":
    main()

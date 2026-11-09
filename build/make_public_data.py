# -*- coding: utf-8 -*-
"""
make_public_data.py —— 水利/感知公开版数据脱敏器（v2.4.4 公开版策略 · 需求③）
=====================================================================
原则（炎冰需求原文）：
  ② 对外公开版管理组织脱敏化，脱敏后管理处/所/站等名字与建筑物信息同步一致，可用作筛选条件；
  ③ 脱敏后的建筑物信息和管理组织名称（处所站）看起来像真的，增加测试用户兴趣（如都江堰水利工程、红旗渠）。

做法：
  - 一张「真实词 → 拟真词」映射表，对 data.json 全部字符串值递归替换。
    组织字段（office/station）与建筑物名称、描述、参数里的同一真实词同步替换 → 天然保持一致、可作筛选条件。
  - 拟真词选用风格接近真实水利工程（清源灌区/明珠水库/云龙山管理所…），整体自洽成一个虚构灌区故事。
  - 手机号统一替换为占位号 13800138000。
  - 只写 data.public.json，绝不碰源 data.json（内部版仍用真实数据）。
  - 自校验：转换后全量回扫真实词清单，必须 0 残留，否则非零退出（fail-loud，禁止静默交付）。

用法：
  python scripts/make_public_data.py            # 处理 shuili_app + shipin_app
  python scripts/make_public_data.py shuili     # 只处理指定端
"""
import json
import re
import sys
import os
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 有序映射表：长词在前（先长后短，防止「怀柔水库」被「怀柔」先吃掉）。
# 整体故事线：虚构「清源灌区」——清源引水渠 + 明珠/云溪/宁泽三水库 + 沿渠各镇管理所。
WORD_MAP = [
    ("北京市", "清源市"),
    ("北京", "清源"),
    ("京密引水管理处", "清源灌区管理处"),
    ("京密引水渠", "清源引水渠"),
    ("京密引水", "清源引水"),
    ("京密", "清源"),
    ("京引", "清引"),
    ("永定河", "澜溪河"),
    ("密云水库", "云溪水库"),
    ("密云", "云溪"),
    ("怀柔水库", "明珠水库"),
    ("怀柔", "怀川"),
    ("雁栖湖", "雁鸣湖"),
    ("雁栖", "雁鸣"),
    ("红螺", "螺湖"),
    ("庙城", "庙前"),
    ("桥梓", "桥湾"),
    ("北房", "北川"),
    ("杨宋", "杨津"),
    ("昌平", "昌宁"),
    ("顺义", "顺河"),
    ("海淀", "滨湖"),
    ("沙河", "沙溪"),
    ("潮河", "清源河"),
    ("白河", "白浪河"),
    ("怀河", "怀川河"),
    ("西田各庄", "柳林庄"),
    ("北台上", "北台峪"),
    ("埝头", "埝湾"),
    ("史山", "翠屏山"),
    ("龙山", "云龙山"),
    ("温泉", "温汤"),
    ("龚庄", "龚家湾"),
    ("大宁", "宁泽"),
    ("青龙桥", "青石桥"),
]

# 脱敏验证用的真实词清单（含正则）；转换后必须 0 残留
RESIDUAL_CHECK = [w for w, _ in WORD_MAP] + [
    r"1[3-9]\d{9}",          # 手机号
    r"京密引水",
]

PHONE_RE = re.compile(r"1[3-9]\d{9}")
PHONE_FAKE = "010-6900-1234"   # 座机占位号（刻意不匹配手机号正则，防自校验自命中）


def scrub_str(s):
    for w, v in WORD_MAP:
        s = s.replace(w, v)
    return PHONE_RE.sub(PHONE_FAKE, s)


def scrub(obj):
    if isinstance(obj, str):
        return scrub_str(obj)
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items()}
    return obj


def collect_strs(obj, out):
    """递归收集全部字符串值（残留检查只看字符串，避开经纬度数字串误报）"""
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, list):
        for x in obj:
            collect_strs(x, out)
    elif isinstance(obj, dict):
        for v in obj.values():
            collect_strs(v, out)


def main():
    apps = sys.argv[1:] or ["shuili", "shipin"]
    rc = 0
    for app in apps:
        src = os.path.join(ROOT, f"{app}_app", "data.json")
        dst = os.path.join(ROOT, f"{app}_app", "data.public.json")
        if not os.path.exists(src):
            print(f"!! {src} 不存在，跳过")
            rc = 1
            continue
        data = json.load(io.open(src, encoding="utf-8"))
        recs = data if isinstance(data, list) else data.get("features") or data.get("records")
        pub = scrub(data)
        text = json.dumps(pub, ensure_ascii=False)

        pub_recs = pub if isinstance(pub, list) else pub.get("features") or pub.get("records")

        # 自校验：真实词 0 残留（fail-loud）
        # 只回扫字符串值（避开经纬度数字串误报）；先剔除替换词自身（如「云龙山」含「龙山」）
        strs = []
        collect_strs(pub, strs)
        check_text = "\n".join(strs)
        for _, v in WORD_MAP:
            check_text = check_text.replace(v, "")
        check_text = check_text.replace(PHONE_FAKE, "")
        residual = {}
        for w in RESIDUAL_CHECK:
            n = len(re.findall(w, check_text))
            if n:
                residual[w] = n
        if residual:
            print(f"!! {app}: 脱敏残留 {residual} → 拒绝写出（请补映射表）")
            rc = 1
            continue

        # 统计组织字段脱敏后的取值（确认筛选条件口径自洽）
        orgs = {}
        for r in (pub_recs or []):
            for k in ("office", "station"):
                v = r.get(k)
                if v:
                    orgs.setdefault(k, set()).add(v)
        io.open(dst, "w", encoding="utf-8").write(text)
        # data.js：index.html 优先内嵌加载（window.__DATA__），APK/PWA/龙芯 deb/桌面端全部走它——
        # 不同步换掉它 = 公开版仍泄露真实数据（2026-09-04 实测踩坑）。与 data.json 同内容、compact 输出。
        dst_js = os.path.join(ROOT, f"{app}_app", "data.public.js")
        compact = json.dumps(pub, ensure_ascii=False, separators=(",", ":"))
        io.open(dst_js, "w", encoding="utf-8").write("window.__DATA__ = " + compact + ";")
        sz = os.path.getsize(dst)
        print(f"✅ {app}: data.public.json 写出 {sz} bytes（{len(recs)} 条）")
        for k in ("office", "station"):
            if k in orgs:
                print(f"   {k}: {sorted(orgs[k])}")

        # 文案文件脱敏：app.js(CHANGELOG/AI示例/帮助文案)、io.js(zip匹配示例)、ai.js、platform_matrix.js(对照单差异说明)
        # 中文词只出现在字符串/注释里，不碰 ASCII 标识符，替换安全。
        text_files = [
            ("js/app.js", "js/app.public.js"),
            ("js/io.js", "js/io.public.js"),
            ("js/ai.js", "js/ai.public.js"),
            ("platform_matrix.js", "platform_matrix.public.js"),
        ]
        for rel, rel_out in text_files:
            fp = os.path.join(ROOT, f"{app}_app", rel)
            if not os.path.exists(fp):
                continue
            t = io.open(fp, encoding="utf-8").read()
            ts = scrub_str(t)
            io.open(os.path.join(ROOT, f"{app}_app", rel_out), "w", encoding="utf-8").write(ts)
            # 残留复检（剔除替换词自身后再回扫）
            chk = ts
            for _, v in WORD_MAP:
                chk = chk.replace(v, "")
            resid = len(re.findall("|".join(w for w, _ in WORD_MAP), chk))
            print(f"   文案 {rel} -> {rel_out}（残留真实词 {resid}）")
    if rc:
        sys.exit(rc)
    print("DONE（公开版数据就绪；内部版继续用 data.json，勿动）")


if __name__ == "__main__":
    main()

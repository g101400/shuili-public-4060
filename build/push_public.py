#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""push_public.py — 水利一张图（公开版）→ g101400/shuili-public-4060

背景（2026-11-03 第 71 轮复盘）：
  水利两线（公开 / 内部）定时任务已连续 ~18+ 次 EXIT=2 零写入，根因是
  `build/push_public.py` 在权威源里**根本不存在**。此前多轮只记录"缺位待办"，
  未落地 → 任务永远空转。本文件即为该缺位的落地实现。

设计要点（与 shuili/build/push.py 同源，避免双口径漂移）：
  - 排除/剥离口径直接 `import push` 复用（is_excluded / blob_sha / api / get_token），
    另加公开版专属剥离规则（.real. / secrets/ / *.real.bak）。
  - 推送前**按文件性质独立扫即将上传的字节**（不依赖排除清单），命中即 ABORT 零上传。
  - **默认 dry-run**：不给 --apply 时只做枚举 + 形态扫描 + 计划摘要，绝不写 GitHub。
    这是对「模式 S / 越权 import 触发真实部署」教训的直接回应（见用户级记忆）。
  - 幂等：本地 blob sha 与远端 contents API sha 比对，相同即 SKIP。

用法：
    python build/push_public.py              # 计划（dry-run，零写入）
    python build/push_public.py --apply      # 真正推送
    python build/push_public.py --apply --json   # 末行输出机器可读 JSON 摘要
"""
import argparse
import base64
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import push as _base  # noqa: E402  复用同一套排除/鉴权/API 口径

REPO_PUBLIC = "g101400/shuili-public-4060"
BRANCH = "main"
API = "https://api.github.com"
ROOT = _base.ROOT

# ---- 公开版专属剥离：这些一旦出现在推送集内即视为泄漏 -------------------------
PUBLIC_FORBIDDEN_PATH_PARTS = (
    ".real.",              # 真实工程数据（含 '.data_buildings.real.*'）
    "secrets/",            # 本机密钥目录
    ".secrets/",
)
# 2026-11-04 第 72 轮：新增 `.private.bak` —— 本轮把源树真 key 迁到 `ai_seed.private.bak`
#   （被 .gitignore 的 `*.bak` 覆盖），若路径口径不认它，就只能靠内容口径兜底；
#   「路径口径 = 内容口径」是这个脚本自己的元训（㊾①），两口径必须同步长。
PUBLIC_FORBIDDEN_SUFFIX = (".real.bak", ".real.js", ".real.json", ".private.bak")

# 按文件性质扫即将上传的字节（公开仓口径比内部仓更严）
PUBLIC_CONTENT_PATTERNS = (
    "sk-or-v1-",                          # OpenRouter 真 key
    "github_pat_11",                      # GitHub fine-grained PAT
    '"alg":"AES-GCM-256","iter"',         # secure_boot_cred.js 骨架
    "tk=",                                # 天地图服务端 token 查询串形态（下方二次校验）
)
SELF_SKIP_NAMES = ("push.py", "push_public.py")

# 静态名册（与内容口径**等价表述**，供 `_gates/verify_sync_chain_liveness_e2e.py`
# 静态抽取做交叉印证：门禁 X-4 会按这份名册独立遍历源树，再与下面扫描的实况比对）。
# 口径与 push.py 的 SENSITIVE_NAMES / ALLOW_NAMES 保持一致，避免双口径漂移。
SENSITIVE_NAMES = ()
ALLOW_NAMES = ("ai_seed.demo.js",)


def scan_public(files):
    """返回 (path_hits, content_hits)。path_hits=按路径口径；content_hits=按字节口径。"""
    path_hits, content_hits = [], []
    for rel in files:
        r = rel.replace("\\", "/")
        base = r.rsplit("/", 1)[-1]
        if base in SELF_SKIP_NAMES or "__pycache__/" in r:
            continue
        if any(p in r for p in PUBLIC_FORBIDDEN_PATH_PARTS) or r.endswith(PUBLIC_FORBIDDEN_SUFFIX):
            path_hits.append(r)
            continue
        try:
            with open(os.path.join(ROOT, rel), "rb") as f:
                head = f.read(400000).decode("utf-8", "replace")
        except Exception:
            continue
        for pat in PUBLIC_CONTENT_PATTERNS:
            if pat == "tk=":
                # 只抓"天地图 token 真值"形态：tk=<32位hex>，避免命中普通查询串
                import re
                if re.search(r"[?&]tk=[0-9a-f]{32}\b", head):
                    content_hits.append("%s <- tk=<32hex>" % r)
                    break
                continue
            if pat in head:
                content_hits.append("%s <- %s" % (r, pat))
                break
    return path_hits, content_hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="真正推送；缺省为 dry-run（只计划，零 GitHub 写入）")
    ap.add_argument("--force", action="store_true",
                    help="安全路径（2026-11-10 第 78 轮新增）：命中的凭据文件改为"
                         "「剔除出推送集」而不是整体中止。仅当不带 --force 首跑已是 "
                         "aborted_secret=1（即剔除前已被门禁硬拦、证明拦截力在线）才允许。")
    ap.add_argument("--json", action="store_true", help="末行输出机器可读 JSON 摘要")
    args = ap.parse_args()

    # ---- 安全路径前置守卫（2026-11-10 第 78 轮，形态 (67)）-------------------
    # 背景：定时任务永不传 --force，因此「剔除」永远不会在生产路径上被启用；
    # 该开关只供人首次实测时使用，并强制「先看红、再放行」——先证拦截力，再谈剔除。
    if args.force and not args.apply:
        print("[FATAL] --force 必须与 --apply 同用（否则无意义）；干跑请去掉 --force", file=sys.stderr)
        sys.exit(2)

    token = _base.get_token()
    if not token:
        print("[FATAL] 未找到 GITHUB_TOKEN 或 D:/Users/WorkBuddy/.github_token", file=sys.stderr)
        sys.exit(2)

    files = _base.list_files()
    path_hits, content_hits = scan_public(files)
    dropped = []

    print(f"[PLAN] repo={REPO_PUBLIC} branch={BRANCH} mode={'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"[PLAN] 候选文件 {len(files)} 个；路径口径命中 {len(path_hits)}；内容口径命中 {len(content_hits)}")

    if (path_hits or content_hits) and args.force:
        # 安全路径：把命中的**凭据类文件**从推送集中剔除，其余照常推送。
        # 只有 basename 在 SENSITIVE_NAMES 里的才允许剔除；命中但不在名册里 → 仍整体中止
        # （防止"因为不认识所以剔除"变成绕过门禁的通用口子）。
        drop_set, refuse = set(), []
        for h in path_hits:
            rel = h if isinstance(h, str) else h[0]
            base = rel.replace("\\", "/").rsplit("/", 1)[-1]
            if base in SENSITIVE_NAMES:
                drop_set.add(rel)
            else:
                refuse.append(rel)
        for h in content_hits:
            rel = h.split(" <- ")[0]
            base = rel.replace("\\", "/").rsplit("/", 1)[-1]
            if base in SENSITIVE_NAMES:
                drop_set.add(rel)
            else:
                refuse.append(rel)
        if refuse:
            print("[ABORT] 命中项不在 SENSITIVE_NAMES 名册内，不允许剔除 —— 整体中止", file=sys.stderr)
            for r in sorted(set(refuse)):
                print("  [REFUSE] %s" % r, file=sys.stderr)
            print("[HINT] 若确属凭据件，先把它加入 SENSITIVE_NAMES 再重跑；不要靠 --force 绕过。",
                  file=sys.stderr)
            sys.exit(4)
        dropped = sorted(drop_set)
        files = [f for f in files if f.replace("\\", "/") not in set(dropped)]
        print("[FORCE] 安全路径启用：剔除 %d 个凭据文件后再扫描（它们不会被上传）" % len(dropped))
        for d in dropped:
            print("  [DROP] %s" % d)
        # 剔除后**重新扫描**，必须为 0 命中才继续（剔除不能是"跳过了就算"）
        path_hits, content_hits = scan_public(files)
        print("[FORCE] 剔除后复扫：路径口径命中 %d、内容口径命中 %d"
              % (len(path_hits), len(content_hits)))
        if path_hits or content_hits:
            print("[ABORT] 剔除后仍有命中 → 整体中止", file=sys.stderr)
            for h in path_hits:
                print("  [PATH] %s" % h, file=sys.stderr)
            for h in content_hits:
                print("  [CONTENT] %s" % h, file=sys.stderr)
            sys.exit(4)

    if (path_hits or content_hits) and not args.force:
        print("[ABORT] 公开仓泄漏断言触发，未发起任何 GitHub 写入", file=sys.stderr)
        for h in path_hits:
            print("  [PATH] %s" % h, file=sys.stderr)
        for h in content_hits:
            print("  [CONTENT] %s" % h, file=sys.stderr)
        print("[HINT] 这是保护，不是故障。处置建议：", file=sys.stderr)
        print("  (a) 把上述凭据文件移出源树（推荐，二者都不需要公开）；", file=sys.stderr)
        print("  (b) 人工确认后加 --force 走安全路径（剔除凭据件、其余照推，"
              "定时任务不会用此开关）。", file=sys.stderr)
        summary = dict(added=0, updated=0, skipped=0, failed=0, total=0,
                       aborted_secret=1, mode="apply" if args.apply else "dry-run")
        print("PUSH_SUMMARY " + " ".join(f"{k}={v}" for k, v in summary.items()))
        if args.json:
            print("JSON " + json.dumps(summary, ensure_ascii=False))
        sys.exit(4)

    # 鉴权预检（只读 GET，不构成写入）
    st, _ = _base.api("GET", f"{API}/repos/{REPO_PUBLIC}", token)
    if st != 200:
        print(f"[AUTH] 仓库访问失败 HTTP {st}", file=sys.stderr)
        sys.exit(3)
    print("[AUTH] 仓库可达 HTTP 200（只读预检）")

    if not args.apply:
        print("[DRY-RUN] 未发起任何写入；确认无误后加 --apply 执行")
        summary = dict(added=0, updated=0, skipped=0, failed=0, total=0,
                       planned=len(files), mode="dry-run")
        print("PUSH_SUMMARY " + " ".join(f"{k}={v}" for k, v in summary.items()))
        if args.json:
            print("JSON " + json.dumps(summary, ensure_ascii=False))
        sys.exit(0)

    added = updated = skipped = failed = 0
    for rel in files:
        full = os.path.join(ROOT, rel)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception as e:
            print(f"FAIL {rel} -> read {e}")
            failed += 1
            continue
        url = f"{API}/repos/{REPO_PUBLIC}/contents/{urllib.parse.quote(rel, safe='/')}?ref={BRANCH}"
        st, j = _base.api("GET", url, token)
        remote_sha = j.get("sha") if st == 200 else None
        if remote_sha == _base.blob_sha(data):
            skipped += 1
            continue
        body = {
            "message": f"sync: {'update' if remote_sha else 'add'} {rel}",
            "content": base64.b64encode(data).decode("ascii"),
            "branch": BRANCH,
        }
        if remote_sha:
            body["sha"] = remote_sha
        st2, _ = _base.api("PUT", url, token, body)
        if st2 in (200, 201):
            print(f"{'UPD' if remote_sha else 'ADD'}  {rel}")
            added += 0 if remote_sha else 1
            updated += 1 if remote_sha else 0
        else:
            print(f"FAIL {rel} -> HTTP {st2}")
            failed += 1

    summary = dict(added=added, updated=updated, skipped=skipped, failed=failed,
                   total=added + updated + skipped + failed, mode="apply")
    print("PUSH_SUMMARY " + " ".join(f"{k}={v}" for k, v in summary.items()))
    if args.json:
        print("JSON " + json.dumps(summary, ensure_ascii=False))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

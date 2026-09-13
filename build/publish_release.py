# -*- coding: utf-8 -*-
"""GitHub Release 发布器：为「通过 GitHub 升级」准备版本发行包。

用法：
  python publish_release.py --repo g101400/shuili-internal-4060 --tag v2.5.0 --files a.apk b.deb
  python publish_release.py --app shuili --channel internal --dry-run   # 先干跑核对
  python publish_release.py --app shuili --channel internal             # 真发布
特性：
  - 幂等：tag 已存在则复用该 release；同名同尺寸资产跳过
  - 稳健：网络截断/429 自动重试（与 push.py 同一策略）
  - 安全：token 只从环境变量或本地文件读取，绝不入仓

2026-09-14 修复（备份 _bak_publish_release_20260914_0440/，四份副本同字节）：
  - **默认 root 解析失效**：旧版 `root = dirname(dirname(__file__))` 在根副本上算出
    `D:/Users/WorkBuddy`、在三端 build 副本上算出 `<app>` 目录，而现行产物布局已上移到
    `aowei_win10/releases/`（+ `releases/internal/`）→ **默认收集恒为 0~1 个产物**，
    跑下去会创建一个「空 Release」（假交付）。改为 `find_project_root()` 向上找含
    `releases/` 的工程根（两种放置位置都能正确解析）。
  - **`--app` 不过滤产物**：显式给 `--root aowei_win10` 时，`releases/**/*` 会把**三端 18 个包
    混传**到单个仓（跨端串包）。新增 `collect_app()`：按 `--app` 文件名关键词
    （水利工程一张图/视频设备运维一张图/古建景点打卡）+ `--channel` 子目录
    （shuili/shipin internal→`releases/internal`、public→`releases`；gujian 单通道→`releases`）精确收集。
  - **新增 `--dry-run`**：只打印仓库/标签/产物清单，不做任何写操作，退出码 0。
  - **产物为 0 时 fail-loud**：`exit 2` 并提示改用 `--files`，绝不静默创建空 Release。
"""
import os, sys, json, time, argparse, hashlib, mimetypes
import urllib.request, urllib.error, urllib.parse

API = 'https://api.github.com'

# app -> 产物文件名关键词（现行 releases 布局：三端产物同名同目录，靠文件名区分）
APP_KEY = {'shuili': '水利', 'shipin': '视频设备运维', 'gujian': '古建'}
ART_EXT = ('.apk', '.deb', '.zip', '.exe', '.msi')


def load_token():
    for k in ('GITHUB_TOKEN', 'GH_TOKEN'):
        v = os.environ.get(k)
        if v:
            return v.strip()
    p = os.environ.get('GITHUB_TOKEN_FILE', r'D:/Users/WorkBuddy/.github_token')
    if os.path.isfile(p):
        return open(p, encoding='utf-8').read().strip()
    sys.exit('未找到 GitHub Token')


TOKEN = load_token()


def req(url, method='GET', data=None, headers=None, raw=False, tries=5):
    """带重试的 HTTP 请求；data 为 bytes 时按原始体发送。"""
    h = {'Authorization': 'Bearer %s' % TOKEN,
         'Accept': 'application/vnd.github+json',
         'X-GitHub-Api-Version': '2022-11-28'}
    if headers:
        h.update(headers)
    body = data
    if data is not None and not isinstance(data, (bytes, bytearray)):
        body = json.dumps(data).encode('utf-8')
        h['Content-Type'] = 'application/json'
    last = None
    for i in range(tries):
        try:
            r = urllib.request.Request(url, data=body, method=method, headers=h)
            with urllib.request.urlopen(r, timeout=300) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            body_e = e.read()
            if e.code in (429, 502, 503, 504) and i < tries - 1:
                time.sleep(2 * (i + 1))
                continue
            return e.code, body_e
        except Exception as e:
            last = e
            if i < tries - 1:
                time.sleep(2 * (i + 1))
                continue
    return 0, (str(last) if last else '').encode()


def api(path, method='GET', data=None, headers=None):
    st, body = req('%s%s' % (API, path), method, data, headers)
    return st, body.decode('utf-8', 'replace')


def detect_version(root):
    """从 js/app.js 的变更历史首条取当前版本（如 v2.5.0）。"""
    import re
    p = os.path.join(root, 'js', 'app.js')
    if not os.path.isfile(p):
        return None
    s = open(p, encoding='utf-8', errors='replace').read()
    m = re.search(r'\["(v\d+\.\d+(?:\.\d+)?)",\s*"\d{4}-\d{2}-\d{2}"', s)
    return m.group(1) if m else None


def collect(root, patterns):
    """按相对 glob 收集存在的文件，去重保序。"""
    import glob as _g
    out, seen = [], set()
    for pat in patterns:
        for f in _g.glob(os.path.join(root, pat), recursive=True):
            if os.path.isfile(f) and f not in seen:
                seen.add(f)
                out.append(f)
    return out


def find_project_root(start):
    """自 start 向上最多 5 级，返回第一个含 releases/ 的目录（现行布局的工程根）。

    修复点：旧版按脚本位置硬推 root，根副本/三端 build 副本都会算出错目录 → 产物恒 0。
    """
    cur = os.path.abspath(start)
    for _ in range(5):
        if os.path.isdir(os.path.join(cur, 'releases')):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def app_release_dir(project_root, app, channel):
    """返回该 app+channel 的产物目录（现行布局）。"""
    sub = 'releases'
    if app in ('shuili', 'shipin') and channel == 'internal':
        sub = os.path.join('releases', 'internal')
    return os.path.join(project_root, sub)


def collect_app(project_root, app, channel, tag=None):
    """按 app + channel + 版本 精确收集产物，避免把别端包/历史版本包混传。

    - app：文件名关键词（水利工程一张图 / 视频设备运维一张图 / 古建景点打卡）
    - channel：shuili/shipin internal→releases/internal、public→releases；gujian→releases
    - tag：仅收当前版本（`releases/` 是累积目录，含 V1.99/V2.01/V2.2… 历史包，
      不加版本过滤会把几十个历史包全传进本次 Release）
    """
    d = app_release_dir(project_root, app, channel)
    if not os.path.isdir(d):
        return []
    key = APP_KEY.get(app)
    import re as _re
    ver_re = None
    if tag:
        ver_re = _re.compile(_re.escape(tag.upper()) + r'(?![0-9.])')
    out = []
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if not os.path.isfile(p) or not n.lower().endswith(ART_EXT):
            continue
        if key and key not in n:
            continue
        if ver_re and not ver_re.search(n):
            continue
        out.append(p)
    return out


def get_release(owner, repo, tag):
    st, body = api('/repos/%s/%s/releases/tags/%s' % (owner, repo, urllib.parse.quote(tag)))
    if st == 200:
        return json.loads(body)
    return None


def create_release(owner, repo, tag, name, notes):
    rel = get_release(owner, repo, tag)
    if rel:
        print('  release 已存在：%s (id=%s)' % (tag, rel['id']))
        return rel
    st, body = api('/repos/%s/%s/releases' % (owner, repo), 'POST',
                   {'tag_name': tag, 'name': name or tag, 'body': notes or '',
                    'draft': False, 'prerelease': False})
    if st in (200, 201):
        rel = json.loads(body)
        print('  release 已创建：%s (id=%s)' % (tag, rel['id']))
        return rel
    sys.exit('  创建 release 失败：%s %s' % (st, body[:300]))


def upload_asset(rel, path):
    name = os.path.basename(path)
    size = os.path.getsize(path)
    for a in rel.get('assets', []):
        if a.get('name') == name and a.get('size') == size:
            print('  SKIP(已存在) %s (%d B)' % (name, size))
            return 'skip'
    base = rel['upload_url'].split('{')[0]
    url = '%s?name=%s' % (base, urllib.parse.quote(name))
    ctype = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    data = open(path, 'rb').read()
    st, body = req(url, 'POST', data, {'Content-Type': ctype})
    if st in (200, 201):
        print('  UPLOAD %s (%.1f MB)' % (name, size / 1048576.0))
        return 'ok'
    print('  FAIL %s -> %s %s' % (name, st, body[:200].decode('utf-8', 'replace')))
    return 'fail'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', help='owner/repo，如 g101400/shuili-internal-4060')
    ap.add_argument('--app', choices=['shuili', 'shipin', 'gujian'])
    ap.add_argument('--channel', choices=['internal', 'public'], default='internal')
    ap.add_argument('--tag', help='发行标签，默认取应用当前版本')
    ap.add_argument('--files', nargs='*', default=None, help='要上传的产物路径（覆盖自动发现）')
    ap.add_argument('--notes', default='')
    ap.add_argument('--root', default=None, help='工程根（含 releases/），默认向上自动查找')
    ap.add_argument('--dry-run', action='store_true', help='只核对仓库/标签/产物清单，不写任何远端')
    a = ap.parse_args()

    # ---- 工程根解析（修复：旧版按脚本位置硬推 → 产物恒 0）----
    root = a.root or find_project_root(os.path.dirname(os.path.abspath(__file__)))
    if not root:
        sys.exit('未找到含 releases/ 的工程根，请用 --root 指定')
    root = os.path.abspath(root)

    # ---- 版本：优先取 app 自身的 js/app.js（root 是工程根，app 在 <root>/<app>_app）----
    ver_root = root
    if a.app and os.path.isdir(os.path.join(root, '%s_app' % a.app)):
        ver_root = os.path.join(root, '%s_app' % a.app)

    repo = a.repo
    if not repo:
        if not a.app:
            sys.exit('需指定 --repo 或 --app')
        repo = 'g101400/%s-%s-4060' % (a.app, a.channel) if a.app != 'gujian' else 'g101400/gujian4060'
    tag = a.tag or detect_version(ver_root) or 'v0.0.0'

    # ---- 产物收集（修复：--app 必须过滤，避免跨端串包）----
    if a.files is not None:
        files = [f for f in a.files if os.path.isfile(f)]
        src = '显式 --files'
    elif a.app:
        files = collect_app(root, a.app, a.channel, tag)
        src = '%s/*%s*' % (os.path.relpath(app_release_dir(root, a.app, a.channel), root), tag.upper())
    else:
        files = collect(root, ['releases/**/*', '*.apk', '*.deb', '*.msi', '*.exe'])
        files = [f for f in files if os.path.isfile(f)]
        src = 'releases/**/*'

    print('工程根 %s' % root)
    print('仓库 %s  标签 %s  来源 %s  产物 %d 个' % (repo, tag, src, len(files)))
    for f in files:
        print('    %s  (%.1f MB)' % (os.path.basename(f), os.path.getsize(f) / 1048576.0))

    # fail-loud：0 产物绝不静默创建空 Release
    if not files:
        print('  !! 未收集到任何产物（来源 %s）——拒绝创建空 Release；请检查 --app/--channel/--root 或改用 --files' % src)
        sys.exit(2)

    if a.dry_run:
        print('[dry-run] 未做任何远端写操作。去掉 --dry-run 即真发布。')
        sys.exit(0)

    owner, name = repo.split('/')
    rel = create_release(owner, name, tag, '%s %s' % (a.app or os.path.basename(root), tag), a.notes)
    ok = skip = fail = 0
    for f in files:
        r = upload_asset(rel, f)
        if r == 'ok':
            ok += 1
        elif r == 'skip':
            skip += 1
        else:
            fail += 1
    print('完成：上传 %d / 跳过 %d / 失败 %d' % (ok, skip, fail))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()

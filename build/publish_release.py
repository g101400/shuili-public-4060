# -*- coding: utf-8 -*-
"""GitHub Release 发布器：为「通过 GitHub 升级」准备版本发行包。

用法：
  python build/publish_release.py --repo g101400/shuili-internal-4060 --tag v2.4.7 --files a.apk b.deb
  python build/publish_release.py --app shuili --channel internal          # 自动取版本+自动搜产物
特性：
  - 幂等：tag 已存在则复用该 release；同名同尺寸资产跳过
  - 稳健：网络截断/429 自动重试（与 push.py 同一策略）
  - 安全：token 只从环境变量或本地文件读取，绝不入仓
"""
import os, sys, json, time, argparse, hashlib, mimetypes
import urllib.request, urllib.error, urllib.parse

API = 'https://api.github.com'


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
    """从 js/app.js 的变更历史首条取当前版本（如 v2.4.7）。"""
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
    ap.add_argument('--files', nargs='*', default=None, help='要上传的产物路径')
    ap.add_argument('--notes', default='')
    ap.add_argument('--root', default=None, help='应用根目录，默认脚本所在目录的上级')
    a = ap.parse_args()

    root = a.root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo = a.repo
    if not repo:
        if not a.app:
            sys.exit('需指定 --repo 或 --app')
        repo = 'g101400/%s-%s-4060' % (a.app, a.channel) if a.app != 'gujian' else 'g101400/gujian4060'
    tag = a.tag or detect_version(root) or 'v0.0.0'

    files = a.files if a.files is not None else collect(
        root, ['releases/**/*', '*.apk', '*.deb', '*.msi', '*.exe'])
    files = [f for f in files if os.path.isfile(f)]
    print('仓库 %s  标签 %s  产物 %d 个' % (repo, tag, len(files)))

    owner, name = repo.split('/')
    rel = create_release(owner, name, tag, '%s %s' % (os.path.basename(root), tag), a.notes)
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

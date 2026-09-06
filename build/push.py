#!/usr/bin/env python3
# 水利工程一张图（公开版）自包含同步脚本：将本仓库当前内容幂等推送回 GitHub。
# 注意：本脚本只做「本仓库内容 -> GitHub」的再同步；若要从内部版重新生成剥离后的公开版，
# 请在内部源码目录运行 build/push_public.py。
import os, sys, base64, json, hashlib, subprocess, time, http.client, urllib.request, urllib.error, urllib.parse

REPO = 'g101400/shuili-public-4060'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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

def api(path, method='GET', data=None, _try=0):
    url = 'https://api.github.com/repos/%s/%s' % (REPO, urllib.parse.quote(path, safe='/,=:'),)
    body = json.dumps(data).encode('utf-8') if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('Authorization', 'Bearer %s' % TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('Content-Type', 'application/json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404, 409, 422):
            return e.code, e.read().decode('utf-8', 'replace')
        if _try < 4:
            time.sleep(2 * (_try + 1))
            return api(path, method, data, _try + 1)
        return e.code, e.read().decode('utf-8', 'replace')
    except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
        if _try < 4:
            time.sleep(2 * (_try + 1))
            return api(path, method, data, _try + 1)
        return 0, ''
    except Exception:
        if _try < 4:
            time.sleep(2 * (_try + 1))
            return api(path, method, data, _try + 1)
        return 0, ''

def git_blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b'blob ' + str(len(data)).encode() + b'\x00' + data)
    return h.hexdigest()

def remote_sha(path):
    st, body = api('contents/%s' % path)
    if st == 200:
        return json.loads(body).get('sha')
    if st == 404:
        return None
    return False

out = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
files = [f for f in out.decode('utf-8').split('\x00') if f]
added = updated = fail = skip = 0
for f in files:
    p = os.path.join(ROOT, f)
    if not os.path.isfile(p):
        print('SKIP(缺失) %s' % f); skip += 1; continue
    with open(p, 'rb') as fh:
        raw = fh.read()
    b64 = base64.b64encode(raw).decode('ascii')
    ls = git_blob_sha(raw)
    rs = remote_sha(f)
    if rs == ls:
        print('SKIP(未变) %s' % f); skip += 1; continue
    if rs is None:
        st2, body2 = api('contents/%s' % f, 'PUT', {'message': 'add %s' % f, 'content': b64})
        if st2 in (200, 201):
            added += 1; print('ADD  %s' % f)
        else:
            fail += 1; print('FAIL %s -> %s %s' % (f, st2, (json.loads(body2).get('message', '') if body2 else '')[:120]))
    else:
        payload = {'message': 'update %s' % f, 'content': b64}
        if isinstance(rs, str):
            payload['sha'] = rs
        st2, body2 = api('contents/%s' % f, 'PUT', payload)
        if st2 in (200, 201):
            updated += 1; print('UPDATE %s' % f)
        else:
            fail += 1; print('FAIL %s -> %s %s' % (f, st2, (json.loads(body2).get('message', '') if body2 else '')[:120]))
print('\n完成：新增 %d / 更新 %d / 跳过 %d / 失败 %d / 共 %d' % (added, updated, skip, fail, len(files)))
sys.exit(1 if fail else 0)

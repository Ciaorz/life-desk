#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探测线上 Worker 是否已是「读免认证」的新版。

关键判据：
  GET /api/img/<不存在的key> 不带令牌
    · 旧版 worker（读还要令牌）→ 401 {"ok":false,"error":"unauthorized"}
    · 新版 worker（读已免令牌）→ 404 not found
"""
import sys
import json
import urllib.request

BASE = "https://life-desk-api.pages.dev"
TOKEN_FILE = r"E:\自制软件\cloud flare D1 R2.txt"
UA = "life-desk-r2-push/1.0"  # 自定义 UA，绕开 Cloudflare 对 Python-urllib 默认 UA 的 1010 拦截


def http(method, path, token=None, body=None):
    url = BASE + path
    data = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""
    except Exception as e:
        return -1, ("ERR: " + str(e)).encode("utf-8")


def main():
    token = ""
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        token = lines[-1]
    except Exception as e:
        print("读令牌失败:", e)

    print("== 探测线上 Worker ==")
    s, b = http("GET", "/api/img/data/thumbs/__probe__.webp")  # 不带令牌
    print(f"  探测key 不带令牌 : {s} {b[:120]}")
    s2, b2 = http("GET", "/api/img/data/thumbs/__probe__.webp", token=token)  # 带令牌
    print(f"  探测key 带令牌   : {s2} {b2[:120]}")

    p, _ = http("GET", "/api/ping")
    print(f"  /api/ping        : {p}")
    su, _ = http("GET", "/api/stats")
    print(f"  /api/stats 不带  : {su}")
    sw, _ = http("GET", "/api/stats", token=token)
    print(f"  /api/stats 带    : {sw}")

    # 结论
    no_token = s
    if no_token == 401:
        print("\n结论：线上还是旧版 worker（读要令牌），手机封面仍在走 GitHub 兜底。")
    elif no_token == 404:
        print("\n结论：✅ 线上已是新版 worker（读免令牌），封面应改走 R2。")
    else:
        print(f"\n结论：读免令牌判定不确定（收到 {no_token}），需人工看上面输出。")


if __name__ == "__main__":
    main()

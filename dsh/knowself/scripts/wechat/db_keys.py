# -*- coding: utf-8 -*-
"""从**正在运行**的微信进程读取各库密钥（无需重启微信、不改任何微信数据）。

## 为什么不再是 find_key.py

`find_key.py` 走的是「Frida spawn 微信 + hook weixin.dll 的 codec 配置函数」：

- 必须先把微信完全退出，抓完再让用户重新扫码登录（打断正在用的微信）；
- hook 偏移（4.1.13.12 = `0x35de480`）**写死在版本上**，微信一升级（4.2.0.13）
  偏移就漂了 —— 拿到的 32 字节「候选」根本不是密钥，HMAC 校验必然失败，
  脚本却仍傻等满 300 秒才退，UI 上表现为「重启完微信后一直没反应」。

本脚本改用 `vendor/wechatauto` 的 **Config.Cipher 内存扫描**：微信保持登录运行，
只读它自己的进程内存，扫出每个库的 32 字节页密钥，并逐个用库文件 page1 的
SQLCipher4 HMAC 校验（校验不过的一律丢弃）。不 spawn、不 attach、不写微信文件。

## 用法

```
python db_keys.py --db <...\\xwechat_files\\<账号>\\db_storage> [--json]
```

输出（stdout 最后一行，带固定前缀便于上层解析）：

```
__KNOWSELF_KEYS__ {"account": "...", "key_count": 3,
                   "keys": {"message/message_0.db": "<64 hex>", ...},
                   "unkeyed": ["migrate/xxx.db"]}
```

退出码：0 = 至少拿到 1 个库的密钥；2 = 一个都没拿到（微信没登录 / 权限不足）。
"""

import argparse
import json
import os
import sys

MARKER = "__KNOWSELF_KEYS__"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, help="db_storage 目录（不是 xwechat_files 根）")
    parser.add_argument("--json", action="store_true", help="只输出 JSON（进度走 stderr）")
    args = parser.parse_args()

    db_storage = os.path.abspath(args.db)
    if os.path.basename(db_storage).lower() != "db_storage":
        print("[db_keys] --db 必须指向 db_storage 目录: %s" % db_storage, file=sys.stderr)
        return 2
    account_dir = os.path.dirname(db_storage)
    root = os.path.dirname(account_dir)
    account = os.path.basename(account_dir)

    # 让 `import wechatauto.*` 找到插件内 vendor（复制到运行目录后同样适用）
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.join(here, "vendor"), os.path.join(os.path.dirname(here), "vendor")):
        if os.path.isdir(os.path.join(candidate, "wechatauto")):
            sys.path.insert(0, candidate)
            break
    else:
        print("[db_keys] 找不到 vendor/wechatauto（插件安装不完整）", file=sys.stderr)
        return 2

    try:
        from wechatauto.db import WeChatDB
    except Exception as exc:  # 依赖缺失（cryptography 等）也要给一句人话
        print("[db_keys] 无法加载 wechatauto.db: %r" % (exc,), file=sys.stderr)
        print("[db_keys] 提示：需要 64 位 Python 且已安装 cryptography", file=sys.stderr)
        return 2

    try:
        db = WeChatDB(db_dir=root, account=account)
    except Exception as exc:
        print("[db_keys] 读取微信密钥失败: %r" % (exc,), file=sys.stderr)
        return 2

    keys = {}
    for rel, key in db._keys.items():
        # 只输出标准 32 字节页密钥：48 字节是「明文头 + 显式 salt」变体，
        # 上层解密走的是「文件头 salt」标准路径，混用会解出损坏的库。
        if len(key) == 32:
            keys[rel] = key.hex()

    payload = {
        "account": db.account,
        "db_dir": db_storage,
        "key_count": len(keys),
        "keys": keys,
        "unkeyed": list(getattr(db, "unkeyed", []) or []),
    }
    print(MARKER + " " + json.dumps(payload, ensure_ascii=False))
    if len(keys) == 0:
        print(
            "[db_keys] 没有拿到任何库密钥：请确认微信已登录并保持窗口打开，"
            "且本脚本与微信同为 64 位/同等权限。",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

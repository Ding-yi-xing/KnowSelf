# -*- coding: utf-8 -*-
"""
微信 4.1.13 (Windows) 聊天记录导出器 —— 每会话一个 txt

精确归因(无需锚点句):
  - 每张 Msg_<md5> 表 = 一个会话, md5 后缀 = md5(会话对象 user_name)
  - real_sender_id 就是消息库 Name2Id 表的 rowid -> 可精确还原发送者 wxid
  - "我" 的 wxid 通过 --self 指定, 缺省按"出现在最多会话表里的发送者"启发式识别
  - 显示名从联系人库 contact_contact.db 的 contact/stranger 表解析(备注>昵称>alias>原wxid)

用法:
  python export_msgs.py [decrypted目录 默认 .\\decrypted] [out目录 默认 .\\export]
      --list               只打印会话清单, 不导出
      --only <关键字>       只导出名字匹配关键字的会话(可多次)
      --self <wxid>        手动指定"我"的 wxid
"""
import os
import sys
import re
import time
import hashlib
import sqlite3
import argparse

BASE = os.path.dirname(os.path.abspath(__file__))
MSG_PREFIX = "message_message_"
CONTACT_DB = "contact_contact.db"

# 常见 local_type -> 中文占位。其余(含大数值类型码)用 [类型N] 兜底, 不丢原始码
KNOWN_TYPES = {1: "文本", 3: "图片", 34: "语音", 43: "视频", 47: "表情", 10000: "系统"}

DATE_SEP_FMT = "---------- %Y-%m-%d ----------"
MSG_FMT = "[%s] %s: %s"


def clean_text(v):
    """把可能为 bytes / 被转义的字段规整为 str; 二进制或 b'...' 视为非文本返回 None"""
    if v is None:
        return None
    if isinstance(v, bytes):
        try:
            v = v.decode("utf-8", errors="replace")
        except Exception:
            return None
    if not isinstance(v, str):
        v = str(v)
    if v.startswith("b'") or v.startswith("b\""):
        return None
    # 含过多控制字符视为二进制
    if sum(1 for ch in v[:200] if ord(ch) < 9 or 13 < ord(ch) < 32) > 8:
        return None
    return v


def split_leading_id(text):
    """若正文以 '<id>:\\n' 开头(群聊格式, id 可为 wxid_xxx/@chatroom/纯数字等), 拆出 (id, 剩余正文)"""
    if not text:
        return None, text
    m = re.match(r"^([0-9A-Za-z_@\-]{2,64}):\r?\n", text)
    if not m:
        return None, text
    return m.group(1), text[m.end():]


def find_message_dbs(dec_dir):
    if not os.path.isdir(dec_dir):
        print("[ERR] 解密目录不存在: %s" % dec_dir)
        return []
    dbs = []
    for f in sorted(os.listdir(dec_dir)):
        if f.startswith(MSG_PREFIX) and f.endswith(".db"):
            dbs.append(os.path.join(dec_dir, f))
    if not dbs:
        print("[ERR] %s 下未找到 %s*.db" % (dec_dir, MSG_PREFIX))
    return dbs


def _name_map(cur, table, id_col, name_col):
    """把 (id, name) 两列表读成 dict"""
    try:
        rows = cur.execute('SELECT "%s","%s" FROM "%s"' % (id_col, name_col, table)).fetchall()
    except Exception:
        return {}
    return {r[0]: (r[1] or "") for r in rows}


def load_display_map(dec_dir):
    """user_name -> 显示名。从 contact/stranger 构建: 备注 > 昵称 > alias > 原 user_name"""
    dmap = {}
    cpath = os.path.join(dec_dir, CONTACT_DB)
    if not os.path.exists(cpath):
        # 兜底: 子目录形式的联系人库名 (contact_contact.db 已是解名产物, 这里仅为日志)
        print("[WARN] 联系人库缺失 %s, 将用 wxid/原名显示" % cpath)
        return dmap
    conn = sqlite3.connect(cpath)
    cur = conn.cursor()
    for table in ("contact", "stranger"):
        try:
            cols = [c[1] for c in cur.execute('PRAGMA table_info("%s")' % table)]
            if "username" not in cols or "nick_name" not in cols:
                continue
            # 该库 user_name 别名列可能叫 username
            for row in cur.execute('SELECT username, remark, nick_name, alias FROM "%s"' % table):
                u, remark, nick, alias = row
                if not u:
                    continue
                name = (remark or nick or alias or u or "").strip()
                # 备注/昵称/alias 为空字符串时不覆盖已填入的同名用户
                if name:
                    dmap.setdefault(u, name)
        except Exception as e:
            print("[WARN] 读 %s 表失败: %s" % (table, e))
    conn.close()
    return dmap


def resolve_display(u, dmap):
    if not u:
        return u
    return dmap.get(u) or u


def main():
    ap = argparse.ArgumentParser(description="微信 4.1.13 聊天记录导出(每会话一个txt)")
    ap.add_argument("dec_dir", nargs="?", default=os.path.join(BASE, "decrypted"))
    ap.add_argument("out_dir", nargs="?", default=os.path.join(BASE, "export"))
    ap.add_argument("--list", action="store_true", help="只打印会话清单")
    ap.add_argument("--only", action="append", default=[], help="只导出名字含关键字的会话(可多次)")
    ap.add_argument("--self", default=None, help="指定'我'的 wxid")
    args = ap.parse_args()

    dbs = find_message_dbs(args.dec_dir)
    if not dbs:
        sys.exit(1)

    # 4.1.13 会把消息分散在 message_0.db / message_1.db ...：必须全部读，
    # 只读 dbs[0] 会漏掉最新会话（实测 message_1 里有当天消息）。
    conns = []
    id2user_by_conn = {}
    md5_user = {}
    chats_by_suffix = {}
    for path in dbs:
        conn = sqlite3.connect(path)
        conn.text_factory = bytes   # 用 bytes 拿到原样, 统一 clean_text 解码
        cur = conn.cursor()
        try:
            name2id_rows = cur.execute("SELECT rowid, user_name, is_session FROM Name2Id").fetchall()
        except Exception as exc:
            print("[WARN] %s 缺少 Name2Id: %s" % (os.path.basename(path), exc))
            conn.close()
            continue
        id2user = {rid: (u.decode("utf-8", "replace") if isinstance(u, bytes) else (u or "")) for rid, u, _ in name2id_rows}
        id2user_by_conn[path] = id2user
        for rid, u, _ in name2id_rows:
            if isinstance(u, bytes):
                u = u.decode("utf-8", "replace")
            if u:
                md5_user.setdefault(hashlib.md5(u.encode("utf-8")).hexdigest(), u)
        table_names = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")]
        for raw in table_names:
            t = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            suf = t[len("Msg_"):]
            if len(suf) != 32:      # 只认 Msg_<md5>, 跳过 Msg_index_xxx 之类的变体
                continue
            chats_by_suffix.setdefault(suf, []).append({"cur": cur, "table": t, "id2user": id2user})
        conns.append(conn)

    dmap = load_display_map(args.dec_dir)

    chats = []
    for suf, entries in chats_by_suffix.items():
        u = md5_user.get(suf, "")
        n = 0
        for e in entries:
            try:
                n += e["cur"].execute('SELECT COUNT(*) FROM "%s"' % e["table"]).fetchone()[0]
            except Exception:
                pass
        chats.append({"table": "Msg_" + suf, "user": u, "is_group": u.endswith("@chatroom"),
                      "count": n, "entries": entries})

    # 定位"我"的 wxid (仅需身份时才做; 用 bytes 时注意比较)
    self_wxid = args.self
    need_self = not args.list
    if need_self and not self_wxid:
        table_hits = {}
        for ch in chats:
            for e in ch["entries"]:
                try:
                    sids = [r[0] for r in e["cur"].execute('SELECT DISTINCT real_sender_id FROM "%s"' % e["table"])]
                except Exception:
                    continue
                for s in sids:
                    if s is None:
                        continue
                    u = e["id2user"].get(s, "")
                    if u.startswith("wxid_"):
                        table_hits[u] = table_hits.get(u, 0) + 1
        if table_hits:
            self_wxid = max(table_hits, key=table_hits.get)
            print("[i] 自动识别 '我' = %s (出现在 %d/%d 个会话)" % (self_wxid, table_hits[self_wxid], len(chats)))
    elif self_wxid:
        print("[i] '我' = %s (手动指定)" % self_wxid)

    # --only 过滤
    if args.only:
        def keep(ch):
            disp = resolve_display(ch["user"], dmap)
            hay = (ch["user"] + " " + disp).lower()
            return any(k.lower() in hay for k in args.only)
        chats = [c for c in chats if keep(c)]

    chats.sort(key=lambda c: c["count"], reverse=True)

    if args.list:
        print("%-5s %-10s %-8s %s" % ("行数", "类型", "会话对象", "显示名"))
        for ch in chats:
            print("%-5d %-10s %-8s %s" % (
                ch["count"], "群聊" if ch["is_group"] else "单聊",
                ch["user"][:28], resolve_display(ch["user"], dmap)[:40]))
        print("共 %d 个会话" % len(chats))
        for c in conns:
            c.close()
        return

    # 逐会话导出
    os.makedirs(args.out_dir, exist_ok=True)
    total_rows = 0
    done = skipped = 0
    for ch in chats:
        disp = resolve_display(ch["user"], dmap)
        if not ch["user"]:
            print("[SKIP] %s 会话对象为空, 跳过" % ch["table"])
            skipped += 1
            continue
        lines, cnt = render_chat(ch, dmap, self_wxid)
        if cnt == 0:
            print("[SKIP] %s 无有效行" % ch["table"])
            skipped += 1
            continue
        # 文件名: 显示名 + md5前6位(保证唯一), 非法字符替换
        safe = re.sub(r'[\\/:*?"<>|]', "_", disp).strip() or "no_name"
        out = os.path.join(args.out_dir, "%s_%s.txt" % (safe, hashlib.md5(ch["user"].encode("utf-8")).hexdigest()[:6]))
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
        total_rows += cnt
        done += 1
        print("[OK] %s (%d 行) -> %s" % (disp, cnt, os.path.basename(out)))

    print("\n导出完成: %d 个文件 / %d 行, 跳过 %d" % (done, total_rows, skipped))
    print("输出目录: %s" % args.out_dir)
    for c in conns:
        c.close()


def fmt_ts(ct):
    if not ct:
        return None
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(ct)))
    except Exception:
        return None


def render_chat(ch, dmap, self_wxid):
    """把一个会话在多个 message_*.db 里的行合并后渲染; 返回 (lines, 有效行数)"""
    rows = []
    for e in ch["entries"]:
        try:
            part = e["cur"].execute(
                'SELECT real_sender_id, local_type, create_time, message_content '
                'FROM "%s" ORDER BY create_time ASC' % e["table"]).fetchall()
        except Exception as exc:
            print("[WARN] 读 %s 失败: %s" % (e["table"], exc))
            continue
        for sid, lt, ct, content in part:
            rows.append((ct or 0, sid, lt, content, e["id2user"]))
    rows.sort(key=lambda r: r[0] or 0)

    lines = []
    msg_count = 0                # 仅统计真实消息(不含日期分隔行)
    prev_day = None
    first_ct = last_ct = None
    for ct, sid, lt, content, id2user in rows:
        if ct:
            try:
                ct = int(ct)
            except Exception:
                ct = None
        if ct:
            first_ct = ct if first_ct is None else min(first_ct, ct)
            last_ct = ct if last_ct is None else max(last_ct, ct)

        text = clean_text(content)
        sender_u = id2user.get(sid, "") if sid is not None else ""

        # 群消息正文可能带 '<发送者>:\\n' 前缀, 用于 sender 解析失败时兜底/去重
        prefix_id = None
        if text:
            prefix_id, text = split_leading_id(text)

        if sender_u == self_wxid:
            who = "我"
        elif sender_u:
            who = resolve_display(sender_u, dmap)
        elif prefix_id:
            # real_sender 解析不到, 用正文前缀里的 id
            who = resolve_display(prefix_id, dmap) if prefix_id else "未知"
            if prefix_id == self_wxid:
                who = "我"
        else:
            who = "未知(sender=%s)" % sid

        # 渲染该行内容(按类型)
        body = render_body(lt, text)
        if body is None:
            continue

        # 时间与日期分栏
        ts = fmt_ts(ct)
        if ts:
            day = ts[:10]
            if prev_day is None:
                # 文件头, 首条给完整时间
                lines.append(DATE_SEP_FMT.replace("%Y-%m-%d", day))
                prev_day = day
                time_part = ts
            elif day != prev_day:
                lines.append(DATE_SEP_FMT.replace("%Y-%m-%d", day))
                prev_day = day
                time_part = ts
            else:
                time_part = ts[11:]
        else:
            time_part = "时间未知"

        lines.append(MSG_FMT % (time_part, who, body))
        msg_count += 1

    if msg_count == 0:
        return [], 0

    # 头部元信息
    rng = "%s ~ %s" % (fmt_ts(first_ct), fmt_ts(last_ct)) if (first_ct and last_ct) else "?"
    header = [
        "# 会话对象 : %s" % ch["user"],
        "# 显示名   : %s" % (resolve_display(ch["user"], dmap)),
        "# 类型     : %s" % ("群聊" if ch["is_group"] else "单聊"),
        "# 消息数   : %d" % msg_count,
        "# 时间范围 : %s" % rng,
        "#",
    ]
    return header + lines, msg_count


def cont_lines(text):
    """一条消息内的换行压平为缩进续行, 保证每条消息仍从行首开始可读"""
    if not text:
        return text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    parts = text.rstrip("\n").split("\n")
    return "\n".join([parts[0]] + ["    " + p for p in parts[1:]])


def render_body(lt, text):
    """按 local_type 生成可读正文/占位; 返回 None 表示丢弃该行"""
    lt = lt if lt is not None else -1
    if lt == 1:                     # 文本
        return cont_lines(text) if text else "(空文本)"
    if lt == 3:
        return "[图片]"
    if lt == 34:
        return "[语音]"
    if lt == 43:
        return "[视频]"
    if lt == 47:                    # 表情: 尽量取 xml alias
        m = re.search(r'alias="([^"]*)"', text) if text else None
        return "[表情%s]" % (":" + m.group(1) if m else "")
    if lt == 10000:                 # 系统消息: 内容通常是短文本
        if text and len(text) < 200 and not text.startswith("<?xml"):
            return "[系统] %s" % cont_lines(text)
        return "[系统消息]"
    if text and text.startswith("<?xml"):
        return "[消息]"
    # 其它(含大数值类型码): 仅保留类型码, 避免把二进制当正文输出
    return "[类型%d]" % lt


if __name__ == "__main__":
    main()

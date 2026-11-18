"""Windows WeChat UI Automation JSONL bridge.

Conservative process boundary: the TypeScript host never touches UI Automation or
the WeChat database directly. This bridge exposes a minimal, fail-closed contract:

    probe_capabilities()
    inspect_current_conversation()
    list_unread_messages()
    send_message({contact_id, body, idempotency_key})
    lookup_send_result({idempotency_key})

Sending always re-opens the target chat and verifies the visible conversation name
before typing. A target mismatch returns ``target_mismatch`` with outcome
``not_sent`` — it never falls back to "send to whatever is open".

Dependencies: the vendored ``wechatauto`` subpackage plus ``uiautomation``,
``pywin32``, ``numpy``, ``cryptography`` and ``zstandard``.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent

# 把 wechatauto 的密钥/解密缓存关进项目 data/ 目录，避免落到共享的 %TEMP%。
# 目录本身已被 .gitignore 覆盖；密钥仍是本地明文，见 vendor/NOTICE 与审计记录。
_CACHE = Path(
    os.environ.get("KNOWSELF_WECHAT_TMP")
    or (Path(os.environ.get("KNOWSELF_ROOT_DIR") or Path.cwd()) / "data" / "wechat-runtime" / "tmp")
)
try:
    _CACHE.mkdir(parents=True, exist_ok=True)
    os.environ["TEMP"] = os.environ["TMP"] = str(_CACHE)
    tempfile.tempdir = str(_CACHE)
except OSError:
    pass
for _candidate in (
    _HERE / "vendor",
    _HERE.parent / "scripts" / "wechat" / "vendor",
    _HERE.parent.parent / "scripts" / "wechat" / "vendor",
):
    if _candidate.is_dir():
        sys.path.insert(0, str(_candidate))
        break
_EXTRA = os.environ.get("KNOWSELF_WECHAT_LIB")
if _EXTRA:
    sys.path.insert(0, _EXTRA)

try:
    from wechatauto.db import WeChatDB
    from wechatauto.uia_driver import WeChatUIA
except Exception:  # pragma: no cover - missing runtime dependencies
    WeChatDB = None  # type: ignore[assignment]
    WeChatUIA = None  # type: ignore[assignment]

TRANSPORT_VERSION = "windows-uia-jsonl/0.2"
_MISSING = "wechatauto vendor package or its Python dependencies are unavailable"

_uia: Any = None
_db: Any = None
_send_results: dict[str, dict[str, Any]] = {}

_CHAT_NAME_TAIL = re.compile(r"(?:(?:长按|按住)鼠标\s*)?语音输入(?:文字)?$")

# ---------------------------------------------------------------------------
# 静默发送（2026-11-17）
# ---------------------------------------------------------------------------
# 背景：旧发送路径 = 强制前台 + 真鼠标轨迹点击输入框 + 剪贴板 Ctrl+V + 回车。
# 对用户来说，每次自动回复都会：抢焦点、动鼠标、覆盖剪贴板、把微信顶到最前。
#
# 现在拆成两层：
#   1. **静默发送**：UIA 的 ValuePattern 直接把文本写进输入框（实测微信 4.2 的
#      mmui::ChatInputField 支持，不需要焦点），再向主窗口 PostMessage 一个回车
#      （Qt 的消息循环会把 WM_KEYDOWN 派发到窗口内部的焦点控件，实测能发出去，
#      且**不动鼠标、不碰剪贴板、不抢前台**）。
#   2. **前台兜底**：静默写不进去（控件改版/只读）时，退回原来的 send_text，
#      但发送结束后把前台窗口和鼠标位置还原，尽量不打断用户。
#
# 站点实测（微信 4.2.0.13）：静默发送后数据库里能查到该条消息，前台窗口零变化。
_QUIET_ENV = "KNOWSELF_WECHAT_QUIET"
_WM_KEYDOWN = 0x0100
_WM_KEYUP = 0x0101
_VK_RETURN = 0x0D


def _quiet_enabled(params: dict[str, Any] | None = None) -> bool:
    """是否走静默发送：请求参数优先，其次环境变量，默认开。"""
    if params is not None and "quiet" in params:
        return bool(params.get("quiet"))
    return (os.environ.get(_QUIET_ENV) or "1").strip() not in ("0", "false", "False", "")


def _fg_hwnd() -> int:
    try:
        return int(ctypes.windll.user32.GetForegroundWindow() or 0)
    except Exception:  # pragma: no cover - defensive
        return 0


def _restore_fg(hwnd: int) -> None:
    """把前台还给发送前的窗口。

    为什么不能只调一次 ``SetForegroundWindow``：Windows 有前台锁（只有"最近一次收到
    输入"的进程/线程才被允许切换前台），后台脚本直接调用常常被静默忽略——实测就是
    「发完消息微信留在最前面」。这里按 Qt 驱动同款做法：AttachThreadInput 把自己的
    输入队列挂到当前前台线程上再切，并重试 3 次。
    """
    if not hwnd:
        return
    u = ctypes.windll.user32
    for _ in range(3):
        try:
            if int(u.GetForegroundWindow() or 0) == hwnd:
                return
            u.SetForegroundWindow(hwnd)
            time.sleep(0.06)
            if int(u.GetForegroundWindow() or 0) == hwnd:
                return
            cur = int(ctypes.windll.kernel32.GetCurrentThreadId() or 0)
            fg = int(u.GetForegroundWindow() or 0)
            fgt = int(u.GetWindowThreadProcessId(fg, None) or 0) if fg else 0
            attached = False
            if fgt and cur and fgt != cur:
                try:
                    attached = bool(u.AttachThreadInput(cur, fgt, True))
                except Exception:
                    attached = False
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
            time.sleep(0.06)
            if attached:
                try:
                    u.AttachThreadInput(cur, fgt, False)
                except Exception:
                    pass
            if int(u.GetForegroundWindow() or 0) == hwnd:
                return
        except Exception:  # pragma: no cover - defensive
            return
        time.sleep(0.12)


def _cursor_pos() -> tuple[int, int]:
    try:
        class _POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        p = _POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
        return int(p.x), int(p.y)
    except Exception:  # pragma: no cover - defensive
        return (0, 0)


def _restore_cursor(pos: tuple[int, int]) -> None:
    if pos == (0, 0):
        return
    try:
        u = ctypes.windll.user32
        cur = _cursor_pos()
        if cur != pos:
            u.SetCursorPos(int(pos[0]), int(pos[1]))
    except Exception:  # pragma: no cover - defensive
        pass


def _idle_seconds() -> float:
    """用户空闲秒数（GetLastInputInfo）：用来判断"现在能不能偷偷操作微信"。"""
    try:
        class _LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        info = _LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(_LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            return 0.0
        tick = ctypes.windll.kernel32.GetTickCount()
        return max(0.0, (tick - info.dwTime) / 1000.0)
    except Exception:  # pragma: no cover - defensive
        return 0.0


@contextmanager
def _ui_untouched():
    """记录并还原「前台窗口 + 鼠标位置」，把 UI 操作对用户的打扰压到最小。"""
    fg = _fg_hwnd()
    pos = _cursor_pos()
    try:
        yield
    finally:
        _restore_cursor(pos)
        _restore_fg(fg)


def _post_enter(hwnd: int) -> None:
    u = ctypes.windll.user32
    u.PostMessageW(int(hwnd), _WM_KEYDOWN, _VK_RETURN, 0)
    time.sleep(0.05)
    u.PostMessageW(int(hwnd), _WM_KEYUP, _VK_RETURN, 0)


def _send_quiet(engine: Any, body: str) -> bool:
    """静默发送：ValuePattern 写入 + 后台回车。返回"是否已经把消息发出去"。

    只对**当前已打开的会话**有效（切会话仍要走点击，见 :func:`_open_target`）。
    写进去但读不回时返回 False，交给前台兜底，绝不猜。
    """
    try:
        edit = engine._chat_input()
        if edit is None:
            return False
        if not engine._set_text(edit, body):
            return False
        readback = engine._read_edit_value(edit)
        if readback is None or body.strip() not in str(readback).strip():
            return False
        _post_enter(int(engine._win.NativeWindowHandle))
        time.sleep(0.4)
        # 发出去后输入框会被清空；还留着说明回车没生效。
        residue = engine._read_edit_value(edit)
        if residue is not None and body.strip() in str(residue).strip():
            try:
                engine._set_text(edit, "")
            except Exception:
                pass
            return False
        return True
    except Exception:  # pragma: no cover - UIA 异常统一走兜底
        return False


def _error(code: str, message: str, outcome: str = "unknown") -> dict[str, Any]:
    return {"code": code, "message": message, "outcome": outcome}


def _clean_name(value: str | None) -> str:
    text = (value or "").strip()
    return _CHAT_NAME_TAIL.sub("", text).strip()


def _split_target(value: str) -> str:
    """Accept both ``wechat:<username>`` (app convention) and a bare username."""
    text = (value or "").strip()
    return text[len("wechat:"):] if text.startswith("wechat:") else text


def _conversation_id(username: str) -> str:
    return f"wechat:{username}"


def _lib_ok() -> bool:
    return WeChatUIA is not None and WeChatDB is not None


def _engine() -> Any:
    global _uia
    if _uia is None:
        _uia = WeChatUIA()
    return _uia


def _store() -> Any:
    global _db
    if _db is None:
        _db = WeChatDB()
    return _db


def _display_name(username: str) -> str:
    rows = _store().search_contact(username) or []
    for row in rows:
        if row.get("username") == username:
            return (row.get("remark") or row.get("nick_name") or username).strip()
    return username


def _resolve_username(name: str) -> str:
    text = _clean_name(name)
    rows = _store().search_contact(text) or []
    exact = [row for row in rows if text in {(row.get("remark") or "").strip(), (row.get("nick_name") or "").strip()}]
    if len(exact) == 1:
        return str(exact[0].get("username") or "")
    if len(rows) == 1:
        return str(rows[0].get("username") or "")
    # 兜底：标题可能被截断或带后缀（「杨子杰…」），按双向包含再试一次，仍然要求唯一命中。
    fuzzy = [
        row for row in rows
        if text and (
            text in (row.get("remark") or "").strip()
            or text in (row.get("nick_name") or "").strip()
            or (row.get("remark") or "").strip().startswith(text)
            or (row.get("nick_name") or "").strip().startswith(text)
        )
    ]
    if len(fuzzy) == 1:
        return str(fuzzy[0].get("username") or "")
    return ""


def _self_username() -> str:
    info = _store().get_self_info() or {}
    return str(info.get("username") or "")


def _kind(username: str) -> str:
    return "group" if username.endswith("@chatroom") else "contact"


def _capabilities() -> dict[str, Any]:
    if not _lib_ok():
        return {
            "available": False,
            "can_inspect_conversation": False,
            "can_list_unread": False,
            "can_send": False,
            "can_lookup_send_result": False,
            "transport_version": TRANSPORT_VERSION,
            "reason": _MISSING,
        }
    if not WeChatUIA.is_running():
        return {
            "available": False,
            "can_inspect_conversation": False,
            "can_list_unread": False,
            "can_send": False,
            "can_lookup_send_result": False,
            "transport_version": TRANSPORT_VERSION,
            "reason": "WeChat desktop client is not running",
        }
    return {
        "available": True,
        "can_inspect_conversation": True,
        "can_list_unread": True,
        "can_send": True,
        "can_lookup_send_result": True,
        "transport_version": TRANSPORT_VERSION,
        "reason": "WeChat 4.x UIA bridge ready",
    }


def _ensure_ready() -> None:
    engine = _engine()
    if not engine.ensure_materialized(timeout=8):
        raise RuntimeError("WeChat UIA tree is not materialized for this build")


def _identity(username: str, visible: str) -> dict[str, Any]:
    """用**已知 username** 构造当前会话身份，不再靠可见名反查。

    真实事故：所选对象就是当前已打开的那个会话时，`_open_target` 直接返回（不点击），
    随后 `_inspect()` 用标题可见名反查联系人；一旦反查不到（备注名与标题不完全一致、
    标题被截断等）就返回 None，外层据此判定「当前微信账号或联系人与所选目标不匹配」并暂停任务。
    """
    return {
        "account_scope": _self_username(),
        "conversation_id": _conversation_id(username),
        "kind": _kind(username),
        "visible_name": visible,
    }


def _inspect() -> dict[str, Any] | None:
    _ensure_ready()
    visible = _clean_name(_engine().current_chat())
    if not visible:
        return None
    username = _resolve_username(visible)
    if not username:
        return None
    return _identity(username, visible)


def _open_target(username: str) -> str:
    """Open ``username`` and return its visible name, or raise target_mismatch.

    切会话这一步仍然只能靠点击（微信 4.x 的会话列表没有可用的 Invoke/SelectionItem），
    因此用 :func:`_ui_untouched` 把「前台窗口 + 鼠标位置」在操作后还原。
    """
    display = _display_name(username)
    engine = _engine()
    with _ui_untouched():
        for _ in range(3):
            engine.back_to_chat_tab()
            if _clean_name(engine.current_chat()) == display:
                return display
            if engine.open_chat(display):
                if _clean_name(engine.current_chat()) == display:
                    return display
            time.sleep(1.0)
    raise _TargetMismatch(f"unable to open verified chat for {username}")


class _TargetMismatch(Exception):
    pass


def _normalize_body(row: dict[str, Any]) -> str:
    content = str(row.get("content") or "")
    if "\n" in content and content.split("\n", 1)[0].endswith(":"):
        return content.split("\n", 1)[1]
    return content


def _unread(username: str, since_ts_ms: int = 0) -> list[dict[str, Any]]:
    rows = _store().get_messages(username, limit=30) or []
    result: list[dict[str, Any]] = []
    for row in rows:
        sender = str(row.get("sender_username") or "")
        # Fail closed: only rows explicitly attributed to the selected contact are
        # candidates. Empty/unknown sender rows may be our own messages.
        if sender != username:
            continue
        created_ms = int(row.get("create_time") or 0) * 1000
        if created_ms <= since_ts_ms:
            continue
        body = _normalize_body(row)
        if not body.strip() or body.lstrip().startswith("<"):
            continue
        result.append(
            {
                "message_id": f"{row.get('local_id')}@{row.get('create_time')}",
                "conversation_id": _conversation_id(username),
                "sender_id": sender or username,
                "body": body[:4000],
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(int(row.get("create_time") or 0))),
            }
        )
    return result


def _recent(username: str, limit: int = 20) -> list[dict[str, Any]]:
    """返回该会话最近 N 条**双方**消息（供回复模型对齐最新上下文）。

    为什么需要：`list_unread_messages` 只回对方新发的、用于触发回复；而模型还需要看到
    "我刚说了什么、对方上一句答了什么"。persons 库靠定期导入，永远落后几分钟，
    所以最新几轮直接从微信本地消息库读。
    """
    size = max(1, min(int(limit or 20), 30))
    rows = _store().get_messages(username, limit=size) or []
    result: list[dict[str, Any]] = []
    for row in rows:
        content = _normalize_body(row)
        # 图片/表情/通话等媒体消息的原始体是 <msg>… XML；回复模型看不到也读不懂，直接跳过，
        # 避免把 XML 当聊天内容塞进上下文（与 _unread 的过滤保持一致）。
        if not content.strip() or content.lstrip().startswith("<"):
            continue
        sender = str(row.get("sender_username") or "")
        created = int(row.get("create_time") or 0)
        result.append(
            {
                "message_id": f"{row.get('local_id')}@{created}",
                "conversation_id": _conversation_id(username),
                "sender_id": sender or username,
                "role": "me" if sender and sender != username else "them",
                "body": content[:4000],
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(created)),
                "ts_ms": created * 1000,
            }
        )
    # get_messages 可能是新→旧；统一按时间升序返回。
    result.sort(key=lambda item: item["ts_ms"])
    return result


def _send(params: dict[str, Any]) -> dict[str, Any]:
    username = _split_target(str(params.get("contact_id") or ""))
    body = str(params.get("body") or "")
    key = str(params.get("idempotency_key") or "")
    if not username or not body.strip() or not key:
        raise ValueError("send_message requires contact_id, body and idempotency_key")
    previous = _send_results.get(key)
    if previous is not None:
        return previous
    quiet = _quiet_enabled(params)

    # 整段包在 _ui_untouched 里：切会话/找输入框都可能短暂抢前台，最后统一还原
    # （含鼠标位置），用户看到的只是「微信闪一下」或完全无感。
    with _ui_untouched():
        display = _open_target(username)
        engine = _engine()
        if _clean_name(engine.current_chat()) != display:
            raise _TargetMismatch("visible conversation changed before typing")

        # 静默优先：不抢前台、不动鼠标、不覆盖剪贴板；失败才退回前台路径。
        sent = _send_quiet(engine, body) if quiet else False
        if not sent:
            sent = engine.send_text(body)
    if not sent:
        raise RuntimeError("send_text failed before confirmation")

    deadline = time.time() + 15
    found: dict[str, Any] | None = None
    while time.time() < deadline:
        for row in _store().get_messages(username, limit=5) or []:
            if body.strip() in _normalize_body(row).strip():
                found = row
                break
        if found:
            break
        time.sleep(1.0)
    if found is None:
        raise RuntimeError("message was typed but not confirmed in the local database")

    result = {
        "external_id": f"{found.get('local_id')}@{found.get('create_time')}",
        "sent_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(int(found.get("create_time") or 0))),
    }
    _send_results[key] = result
    return result


def _handle(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "probe_capabilities":
        return {"ok": True, "result": _capabilities()}
    if method == "probe_idle":
        # 空闲检测不依赖微信/UIA 依赖，单独放行：Worker 用它决定「现在能不能动手」。
        return {"ok": True, "result": {"idle_seconds": round(_idle_seconds(), 3)}}
    if not _lib_ok():
        return {"ok": False, "error": _error("unsupported", _MISSING, "not_sent")}
    try:
        if method == "inspect_current_conversation":
            return {"ok": True, "result": _inspect()}
        if method == "open_conversation":
            username = _split_target(str(params.get("contact_id") or ""))
            if not username:
                return {"ok": False, "error": _error("target_mismatch", "contact_id is required", "not_sent")}
            display = _open_target(username)
            # 直接用已知 username 回传身份：不依赖可见名反查，避免「目标本来就开着」时反查失败被误判。
            return {"ok": True, "result": _identity(username, display)}
        if method == "list_unread_messages":
            username = _split_target(str(params.get("contact_id") or ""))
            if not username:
                return {"ok": True, "result": []}
            return {"ok": True, "result": _unread(username, int(params.get("since_ts_ms") or 0))}
        if method == "list_recent_messages":
            username = _split_target(str(params.get("contact_id") or ""))
            if not username:
                return {"ok": True, "result": []}
            return {"ok": True, "result": _recent(username, int(params.get("limit") or 20))}
        if method == "send_message":
            return {"ok": True, "result": _send(params)}
        if method == "lookup_send_result":
            return {"ok": True, "result": _send_results.get(str(params.get("idempotency_key") or ""))}
    except _TargetMismatch as error:
        return {"ok": False, "error": _error("target_mismatch", str(error), "not_sent")}
    except Exception as error:  # pragma: no cover - defensive process boundary
        return {"ok": False, "error": _error("send_failed", f"bridge failure: {error}", "unknown")}
    return {"ok": False, "error": _error("unsupported", f"unknown bridge method: {method}", "not_sent")}


def main() -> int:
    # JSONL 协议固定 UTF-8；Windows 控制台默认代码页会把中文按 GBK 解码成乱码。
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request: object = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params", {})
            if not isinstance(request_id, str) or not isinstance(method, str):
                raise ValueError("request requires string id and method")
            if not isinstance(params, dict):
                raise ValueError("request params must be an object")
            response = _handle(method, params)
            response["id"] = request_id
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            response = {
                "id": request.get("id", "") if isinstance(request, dict) else "",
                "ok": False,
                "error": _error("send_failed", f"invalid bridge request: {error}", "not_sent"),
            }
        except Exception as error:  # pragma: no cover - defensive process boundary
            response = {
                "id": "",
                "ok": False,
                "error": _error("send_failed", f"bridge failure: {error}"),
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

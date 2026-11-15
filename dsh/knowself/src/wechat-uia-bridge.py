"""Windows WeChat UI Automation JSONL bridge.

This process is deliberately conservative. It exposes capability discovery and
keeps all UI Automation code outside the TypeScript domain packages. Until a
specific WeChat build's control tree has been verified, action methods return
``unsupported`` instead of guessing a window or sending text to the wrong
conversation.

Dependencies:
    - uiautomation (optional at startup; missing means unavailable)
    - pywin32 (optional at startup; missing means unavailable)

Inputs:
    One JSON object per stdin line: ``{"id", "method", "params"}``.

Outputs:
    One JSON response per request on stdout. Diagnostics go to stderr.
"""

from __future__ import annotations

import json
import sys
from typing import Any

try:
    import uiautomation as automation
except ImportError:
    automation = None

try:
    import win32api
    import win32gui
    import win32process
except ImportError:
    win32api = None
    win32gui = None
    win32process = None


TRANSPORT_VERSION = "windows-uia-jsonl/0.1"


def _error(code: str, message: str, outcome: str = "unknown") -> dict[str, Any]:
    return {"code": code, "message": message, "outcome": outcome}


def _capabilities() -> dict[str, Any]:
    if automation is None or win32api is None or win32gui is None or win32process is None:
        missing = []
        if automation is None:
            missing.append("uiautomation")
        if win32api is None or win32gui is None or win32process is None:
            missing.append("pywin32")
        return {
            "available": False,
            "can_inspect_conversation": False,
            "can_list_unread": False,
            "can_send": False,
            "can_lookup_send_result": False,
            "transport_version": TRANSPORT_VERSION,
            "reason": "missing Python dependencies: " + ", ".join(missing),
        }

    hwnd = _find_wechat_window()
    if hwnd is None:
        return {
            "available": False,
            "can_inspect_conversation": False,
            "can_list_unread": False,
            "can_send": False,
            "can_lookup_send_result": False,
            "transport_version": TRANSPORT_VERSION,
            "reason": "WeChat desktop window was not found",
        }

    return {
        "available": True,
        "can_inspect_conversation": False,
        "can_list_unread": False,
        "can_send": False,
        "can_lookup_send_result": False,
        "transport_version": TRANSPORT_VERSION,
        "reason": "WeChat window found; UIA control contract is not verified for this build",
    }


def _find_wechat_window() -> int | None:
    if win32api is None or win32gui is None or win32process is None:
        return None

    matches: list[int] = []

    def visit(hwnd: int, _extra: Any) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd).strip()
        class_name = win32gui.GetClassName(hwnd)
        _, process_id = win32process.GetWindowThreadProcessId(hwnd)
        try:
            process_handle = win32api.OpenProcess(0x1000, False, process_id)
            try:
                image_path = win32process.GetModuleFileNameEx(process_handle, 0)
            finally:
                process_handle.Close()
        except Exception:
            image_path = ""
        executable = image_path.replace("/", "\\").rsplit("\\", 1)[-1].lower()
        if _matches_wechat_window(executable, class_name, title):
            matches.append(hwnd)

    win32gui.EnumWindows(visit, None)
    return matches[0] if matches else None


def _matches_wechat_window(executable: str, class_name: str, title: str) -> bool:
    if executable == "weixin.exe":
        return class_name == "TXGuiFoundation"
    if executable == "wechat.exe":
        return class_name == "WeChatMainWndForPC" or title in {"\u5fae\u4fe1", "WeChat"}
    return False


def _unsupported(method: str) -> dict[str, Any]:
    return {"ok": False, "error": _error("unsupported", f"UIA method is not verified: {method}", "not_sent")}


def _handle(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "probe_capabilities":
        return {"ok": True, "result": _capabilities()}
    if method in {
        "inspect_current_conversation",
        "list_unread_messages",
        "send_message",
        "lookup_send_result",
    }:
        return _unsupported(method)
    return {"ok": False, "error": _error("unsupported", f"unknown bridge method: {method}", "not_sent")}


def main() -> int:
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

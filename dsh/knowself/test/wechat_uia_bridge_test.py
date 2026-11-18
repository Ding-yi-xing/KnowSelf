import importlib.util
import unittest
from pathlib import Path


BRIDGE_PATH = Path(__file__).parents[1] / "src" / "wechat-uia-bridge.py"
SPEC = importlib.util.spec_from_file_location("wechat_uia_bridge", BRIDGE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class CleanNameTests(unittest.TestCase):
    def test_strips_voice_input_placeholder_tail(self):
        self.assertEqual(BRIDGE._clean_name("文件传输助手按住鼠标 语音输入文字"), "文件传输助手")
        self.assertEqual(BRIDGE._clean_name("文件传输助手长按鼠标 语音输入"), "文件传输助手")

    def test_keeps_plain_name(self):
        self.assertEqual(BRIDGE._clean_name("  张三  "), "张三")
        self.assertEqual(BRIDGE._clean_name(None), "")


class KindTests(unittest.TestCase):
    def test_chatroom_is_group(self):
        self.assertEqual(BRIDGE._kind("123@chatroom"), "group")

    def test_everything_else_is_contact(self):
        self.assertEqual(BRIDGE._kind("wxid_abc"), "contact")
        self.assertEqual(BRIDGE._kind("filehelper"), "contact")


class CapabilityTests(unittest.TestCase):
    def test_unavailable_without_runtime_dependencies(self):
        original_uia, original_db = BRIDGE.WeChatUIA, BRIDGE.WeChatDB
        BRIDGE.WeChatUIA, BRIDGE.WeChatDB = None, None
        try:
            caps = BRIDGE._capabilities()
        finally:
            BRIDGE.WeChatUIA, BRIDGE.WeChatDB = original_uia, original_db
        self.assertFalse(caps["available"])
        self.assertFalse(caps["can_send"])
        self.assertIn("unavailable", caps["reason"])

    def test_unknown_method_is_unsupported(self):
        response = BRIDGE._handle("delete_everything", {})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "unsupported")


class UnreadFilterTests(unittest.TestCase):
    class FakeStore:
        def get_self_info(self):
            return {"username": "wxid_me"}

        def get_messages(self, username, limit=30):
            return [
                {"local_id": 1, "create_time": 100, "sender_username": "wxid_me", "content": "我发的"},
                {"local_id": 2, "create_time": 101, "sender_username": "wxid_friend", "content": "对方发的"},
                {"local_id": 3, "create_time": 102, "sender_username": "wxid_other", "content": "别人"},
                {"local_id": 4, "create_time": 103, "sender_username": "", "content": "自己（无 sender）"},
            ]

    def test_only_selected_contact_messages_are_returned(self):
        original = BRIDGE._store
        BRIDGE._store = lambda: self.FakeStore()
        try:
            messages = BRIDGE._unread("wxid_friend")
        finally:
            BRIDGE._store = original
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["message_id"], "2@101")
        self.assertEqual(messages[0]["body"], "对方发的")


class OpenConversationTests(unittest.TestCase):
    def test_returns_identity_using_the_known_username(self):
        """目标本来就是当前打开的那个会话时，不能靠标题反查判身份。

        真实事故：所选对象与微信当前打开的会话是同一人 → `_open_target` 直接返回（不点击）
        → 旧实现再走 `_inspect()` 用可见名反查 → 反查失败返回 None → 外层判「不匹配」并暂停任务。
        """
        original_lib, original_open, original_self = (
            BRIDGE._lib_ok, BRIDGE._open_target, BRIDGE._self_username,
        )
        BRIDGE._lib_ok = lambda: True
        BRIDGE._open_target = lambda username: "杨子杰"
        BRIDGE._self_username = lambda: "wxid_me"
        try:
            response = BRIDGE._handle("open_conversation", {"contact_id": "wechat:wxid_friend"})
        finally:
            BRIDGE._lib_ok, BRIDGE._open_target, BRIDGE._self_username = (
                original_lib, original_open, original_self,
            )
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["conversation_id"], "wechat:wxid_friend")
        self.assertEqual(response["result"]["account_scope"], "wxid_me")
        self.assertEqual(response["result"]["kind"], "contact")
        self.assertEqual(response["result"]["visible_name"], "杨子杰")


class ResolveUsernameTests(unittest.TestCase):
    class FakeStore:
        def __init__(self, rows):
            self.rows = rows

        def search_contact(self, query):
            return self.rows

    def test_exact_remark_match_wins(self):
        original = BRIDGE._store
        BRIDGE._store = lambda: self.FakeStore([{"username": "wxid_a", "remark": "杨子杰", "nick_name": "小杨"}])
        try:
            self.assertEqual(BRIDGE._resolve_username("杨子杰"), "wxid_a")
        finally:
            BRIDGE._store = original

    def test_falls_back_to_prefix_match_when_title_is_truncated(self):
        # 标题可能被截断成「杨子…」，仍应唯一命中。
        original = BRIDGE._store
        BRIDGE._store = lambda: self.FakeStore([{"username": "wxid_a", "remark": "杨子杰", "nick_name": "小杨"}])
        try:
            self.assertEqual(BRIDGE._resolve_username("杨子"), "wxid_a")
        finally:
            BRIDGE._store = original

    def test_ambiguous_prefix_is_not_guessed(self):
        original = BRIDGE._store
        BRIDGE._store = lambda: self.FakeStore([
            {"username": "wxid_a", "remark": "杨子杰", "nick_name": "小杨"},
            {"username": "wxid_b", "remark": "杨子豪", "nick_name": "小豪"},
        ])
        try:
            self.assertEqual(BRIDGE._resolve_username("杨子"), "")
        finally:
            BRIDGE._store = original


if __name__ == "__main__":
    unittest.main()

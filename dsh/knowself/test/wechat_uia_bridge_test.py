import importlib.util
from pathlib import Path
import unittest


BRIDGE_PATH = Path(__file__).parents[1] / "src" / "wechat-uia-bridge.py"
SPEC = importlib.util.spec_from_file_location("wechat_uia_bridge", BRIDGE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class WeChatWindowMatchTests(unittest.TestCase):
    def test_current_client_requires_expected_window_class(self):
        self.assertTrue(BRIDGE._matches_wechat_window("weixin.exe", "TXGuiFoundation", "微信"))
        self.assertFalse(BRIDGE._matches_wechat_window("weixin.exe", "OtherWindow", "微信"))

    def test_legacy_client_requires_known_executable(self):
        self.assertTrue(BRIDGE._matches_wechat_window("wechat.exe", "WeChatMainWndForPC", ""))
        self.assertTrue(BRIDGE._matches_wechat_window("wechat.exe", "OtherWindow", "微信"))
        self.assertFalse(BRIDGE._matches_wechat_window("tim.exe", "WeChatMainWndForPC", "微信"))

    def test_unknown_or_unreadable_process_is_rejected(self):
        self.assertFalse(BRIDGE._matches_wechat_window("", "WeChatMainWndForPC", "微信"))
        self.assertFalse(BRIDGE._matches_wechat_window("wechat.exe", "TXGuiFoundation", ""))


if __name__ == "__main__":
    unittest.main()

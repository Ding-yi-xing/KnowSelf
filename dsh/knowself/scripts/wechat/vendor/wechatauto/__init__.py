"""Vendored subset of wechatauto-replica 1.2.10 (Apache-2.0).

Only the modules needed by the knowSelf UIA bridge are bundled:

    accessibility.py  rhythm.py  logger.py  param.py  uia_driver.py  db.py  utils/

The upstream package ``__init__`` imports GUI/OCR/Moments modules with heavy
optional dependencies; this lightweight init keeps the import surface minimal.
Upstream: https://github.com/fanyuantaier/wechatauto-replica (commit recorded in NOTICE).
"""

from __future__ import annotations

from .param import WxParam, WxResponse, PROJECT_NAME
from .logger import wxlog
from . import rhythm
from .uia_driver import WeChatUIA
from .db import WeChatDB

__all__ = ["WxParam", "WxResponse", "PROJECT_NAME", "wxlog", "rhythm", "WeChatUIA", "WeChatDB"]

knowSelf vendored third-party code
==================================

wechatauto-replica 1.2.10 (subset)
----------------------------------
- Upstream: https://github.com/fanyuantaier/wechatauto-replica
- License: Apache License 2.0 (see vendor/wechatauto/LICENSE)
- Vendored files: accessibility.py, db.py, logger.py, param.py, rhythm.py,
  uia_driver.py, utils/lock.py, utils/tools.py, utils/win32.py
- Local changes: a lightweight `__init__.py` replaces the upstream one (which
  imports GUI/OCR/Moments modules with heavy optional dependencies). No other
  source changes; the bridge calls the public `WeChatUIA` / `WeChatDB` APIs.
- Purpose: Windows WeChat 4.x UIA transport used by src/wechat-uia-bridge.py.
- Runtime isolation: the bridge redirects TEMP/TMP and `tempfile.tempdir` to
  `data/wechat-runtime/tmp`, so the upstream SQLCipher key/decrypted-DB cache does
  not land in the shared Windows temp directory. Only the modules above are
  vendored; OCR / Moments / media-download modules are not shipped.
- Privacy audit: docs/dsh-integration/evidence/2026-11-16-wechatauto-privacy-audit.md
  (no outbound network, telemetry or upload code in the vendored subset).

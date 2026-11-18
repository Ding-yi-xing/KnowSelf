# -*- coding: utf-8 -*-
"""
微信 4.1.13.12 (Windows x64) 数据库主密钥获取脚本
原理: Frida spawn 微信, hook codec 配置函数 (weixin.dll 偏移 0x35de480, 经 .pdata + MMV1 xref 定位),
      rcx 指向的结构前 32 字节 = password (原始密钥)
用法: python find_key.py [Weixin.exe路径]
输出: 密钥 hex 写入 key.txt
依赖: pip install frida
"""
import frida, time, sys, os, re, json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEIXIN_PATH = sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files\Tencent\Weixin\Weixin.exe"
OUT_FILE = os.path.join(BASE_DIR, "key.txt")
LOG_FILE = os.path.join(BASE_DIR, "hook.log")
CODEC_CFG_OFF = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x35de480  # weixin.dll codec配置函数入口 (4.1.13.12)

def save_key(hexkey):
    """将密钥写入 key.txt，并同时写入 key+offset json 便于后序解密读取"""
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write(hexkey.strip() + "\n")
    meta = {"password_hex": hexkey.strip(), "offset_hex": hex(CODEC_CFG_OFF)}
    with open(os.path.join(BASE_DIR, "key_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("[OK] 密钥已保存到 %s" % OUT_FILE)

def parse_hook_log_all():
    """扫描 hook.log，返回按出现顺序去重后的全部 PASSWORD_CANDIDATE"""
    if not os.path.exists(LOG_FILE):
        return []
    out = []
    seen = set()
    with open(LOG_FILE, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = re.search(r"PASSWORD_CANDIDATE\[32\]=\s*([0-9a-fA-F]{64})", line)
            if m:
                hx = m.group(1).lower()
                if hx not in seen:
                    seen.add(hx)
                    out.append(hx)
    return out

def log(s):
    """追加写入 hook.log（模块层日志，与 JS 内部 log 分离）"""
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(s + "\n")
    print(s, flush=True)

# ---- HMAC 验证：确认捕获的 password 是否为真（用真实库 page1）----
import hashlib, struct, hmac as hmac_mod

# 个人数据目录放在不入库的 local_config.py; 缺失时用占位(不影响 HMAC 验证逻辑, 只是找不到 probe 库)
try:
    from local_config import DB_DIR
except Exception:
    DB_DIR = r"D:\path\to\your\db_storage"   # 通用占位, 请勿在此填真实账号路径

def find_probe_db():
    """定位一个真实加密库用于 HMAC 验证。
    4.1.13 布局把库放在子目录(如 message\message_0.db), 与旧版 db_storage\*.db 不同。"""
    for rel in ("message\\message_0.db", "message_0.db"):
        cand = os.path.join(DB_DIR, rel)
        if os.path.exists(cand):
            return cand
    for root, dirs, files in os.walk(DB_DIR):
        for f in files:
            if f.endswith('.db') and not (f.endswith('-wal') or f.endswith('-shm')):
                return os.path.join(root, f)
    return None

def verify_password_hex(hexkey):
    """用真实库的 page1 做 SQLCipher4 HMAC 验证"""
    probe = find_probe_db()
    if not probe:
        log("verify: no probe db under %s" % DB_DIR)
        return False
    with open(probe, 'rb') as f:
        page1 = f.read(4096)
    if len(page1) < 4096:
        log("verify: %s page1 too short" % probe)
        return False
    with open(probe, 'rb') as f:
        page1 = f.read(4096)
    if len(page1) < 4096:
        log("verify: page1 too short")
        return False
    salt = page1[:16]
    password = bytes.fromhex(hexkey)
    enc_key = hashlib.pbkdf2_hmac("sha512", password, salt, 256000, dklen=32)
    mac_salt = bytes(b ^ 0x3a for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=32)
    hmac_data = page1[16:4096-80+16]
    stored_hmac = page1[4096-64:4096]
    hh = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hh.update(struct.pack('<I', 1))
    ok = hh.digest() == stored_hmac
    log("verify: candidate %s... -> %s" % (hexkey[:16], "VALID" if ok else "INVALID"))
    return ok

js = r"""
function sendlog(s) {
    send(s);
}
function setup() {
    var mod = Process.getModuleByName("Weixin.dll");
    if (!mod) { sendlog("setup: Weixin.dll NOT loaded"); return false; }
    var base = mod.base;
    Interceptor.attach(base.add(OFFSET), {
        onEnter: function(args) {
            var c = this.context;
            sendlog("=== CODEC_CFG_FUNC triggered ===");
            sendlog("rcx=" + c.rcx + " rdx=" + c.rdx);
            try {
                // Frida17: Memory.readByteArray 静态方法已移除, 改用 NativePointer 实例方法
                var buf = c.rcx.readByteArray(64);
                var u8 = new Uint8Array(buf);
                var hex = "";
                for (var i = 0; i < u8.length; i++) hex += ("0" + u8[i].toString(16)).slice(-2);
                sendlog("rcx[64]=" + hex);
                sendlog("PASSWORD_CANDIDATE[32]=" + hex.slice(0, 64));
            } catch(e) { sendlog("read fail: " + e); }
        }
    });
    sendlog("CODEC_CFG hooked at " + base.add(OFFSET));
    return true;
}
var hooked = false;
function trySetup() {
    if (hooked) return;
    try { if (setup()) { hooked = true; return; } } catch(e) { sendlog("err: " + e); }
}
// 轮询 200ms，最多 600 次(120s)。Weixin.dll 加载完成后第一个周期即 attach，
// 之后登录/开库等动作给出数秒窗口，足够在 codec 配置函数调用前 hook 上。
// 注: 不再用 ModuleMap 'change' 事件(Frida17 已无 .on(), 会抛 TypeError)。
var tries = 0;
function pollSetup() {
    if (hooked) { sendlog("already hooked, stop polling"); return; }
    trySetup();
    tries++;
    if (tries <= 600) setTimeout(pollSetup, 200);
    else sendlog("GIVEUP: Weixin.dll 未加载或 hook 失败");
}
sendlog("JS boot OK");
pollSetup();
"""

log("spawning: %s" % WEIXIN_PATH)
device = frida.get_local_device()
if os.path.exists(LOG_FILE):
    os.remove(LOG_FILE)
pid = device.spawn([WEIXIN_PATH])
log("spawned pid=%d, 等待扫码登录..." % pid)
session = device.attach(pid)
js = js.replace("base.add(OFFSET)", "base.add(%s)" % hex(CODEC_CFG_OFF))
script = session.create_script(js)

def on_message(msg, data):
    """JS send() 消息统一落盘 hook.log，便于排查注入/捕获进度"""
    if msg.get("type") == "send":
        log(msg.get("payload", ""))
    elif msg.get("type") == "error":
        src = msg.get("source", "")
        line = msg.get("lineNumber", "")
        stack = msg.get("stack", "")
        log("JSErr: %s | %s:%s\n%s" % (msg.get("description", str(msg)), src, line, stack))

script.on("message", on_message)
script.load()
device.resume(pid)
log("resumed - 微信已启动, 请扫码登录 (密钥在启动早期自动捕获)")
# 保持运行等待捕获 (若捕获到且通过 HMAC 验证则提前结束, 最长 300s)
# 触发可能极密集: 逐秒验证"每个新出现的唯一候选", 而非只看最后一条, 保证不漏真密钥
valid_key = None
verified = set()
for _ in range(300):
    time.sleep(1)
    for hexkey in parse_hook_log_all():
        if hexkey in verified:
            continue
        verified.add(hexkey)
        if verify_password_hex(hexkey):
            valid_key = hexkey
            log("CAPTURED: 密钥通过 HMAC 验证, 提前结束")
            break
    if valid_key:
        break
session.detach()
if valid_key:
    hexkey = valid_key
    save_key(hexkey)
    print("密钥: %s (offset=%s)" % (hexkey, hex(CODEC_CFG_OFF)))
    print("可通过 python decrypt_all.py 读取 key.txt 继续解密")
else:
    print("[WARN] 未捕获到密钥, 请检查 %s" % LOG_FILE)
    print("偏移与版本不匹配时, 用法: python find_key.py [Weixin.exe路径] [offset_hex] (offset 须为 weixin.dll 的 codec 配置函数入口 RVA)")

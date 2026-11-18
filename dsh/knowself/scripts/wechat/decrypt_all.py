# -*- coding: utf-8 -*-
"""
微信 4.x (Windows) 数据库批量解密脚本
用法: python decrypt_all.py <password_hex> <db_dir> <out_dir>
示例: python decrypt_all.py <password_hex> D:\\xwechat_files\\xxx\\db_storage decrypted
依赖: pip install pycryptodome
"""
import os, sys, hashlib, struct, hmac as hmac_mod, time, json
from Crypto.Cipher import AES

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 个人数据目录放不入库的 local_config.py; 缺失则为 None, 由 main 提示用户指定
try:
    from local_config import DB_DIR as LOCAL_DB_DIR
except Exception:
    LOCAL_DB_DIR = None

PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80
SQLITE_HDR = b'SQLite format 3\x00'

def derive_enc_key(password, salt):
    return hashlib.pbkdf2_hmac("sha512", password, salt, 256000, dklen=KEY_SZ)

def derive_mac_key(enc_key, salt):
    mac_salt = bytes(b ^ 0x3a for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)

def verify_page1(enc_key, salt, page1):
    mac_key = derive_mac_key(enc_key, salt)
    hmac_data = page1[SALT_SZ : PAGE_SZ - RESERVE_SZ + 16]
    stored_hmac = page1[PAGE_SZ - HMAC_SZ : PAGE_SZ]
    hh = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hh.update(struct.pack('<I', 1))
    return hh.digest() == stored_hmac

def decrypt_page(enc_key, page_data, pgno):
    iv = page_data[PAGE_SZ - RESERVE_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    if pgno == 1:
        encrypted = page_data[SALT_SZ : PAGE_SZ - RESERVE_SZ]
        page = SQLITE_HDR + AES.new(enc_key, AES.MODE_CBC, iv).decrypt(encrypted) + b'\x00' * RESERVE_SZ
    else:
        encrypted = page_data[:PAGE_SZ - RESERVE_SZ]
        page = AES.new(enc_key, AES.MODE_CBC, iv).decrypt(encrypted) + b'\x00' * RESERVE_SZ
    return page

def decrypt_db(db_path, out_path, enc_key):
    file_size = os.path.getsize(db_path)
    total_pages = (file_size + PAGE_SZ - 1) // PAGE_SZ
    with open(db_path, 'rb') as fin, open(out_path, 'wb') as fout:
        for pgno in range(1, total_pages + 1):
            page_data = fin.read(PAGE_SZ)
            if len(page_data) < PAGE_SZ:
                page_data += b'\x00' * (PAGE_SZ - len(page_data))
            fout.write(decrypt_page(enc_key, page_data, pgno))
    return total_pages

def main():
    meta = None
    meta_path = os.path.join(BASE_DIR, "key_meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = None
    if len(sys.argv) < 4:
        if meta and meta.get("password_hex"):
            if not LOCAL_DB_DIR:
                print("未找到本地数据目录: 请创建 local_config.py(含 DB_DIR), 或用完整参数调用")
                return
            print("已从 key_meta.json 自动读取密钥, 数据目录取 local_config.DB_DIR")
            sys.argv = [sys.argv[0], meta["password_hex"], LOCAL_DB_DIR, os.path.join(BASE_DIR, "decrypted")]
        else:
            print("用法: python decrypt_all.py <password_hex> <db_dir> <out_dir>")
            print("     (无参自动模式需存在 key_meta.json 和 local_config.py)")
            return
    password = bytes.fromhex(sys.argv[1])
    db_dir, out_dir = sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)

    ok = fail = 0
    t0 = time.time()
    for root, dirs, files in os.walk(db_dir):
        for f in files:
            if not f.endswith('.db') or f.endswith('-wal') or f.endswith('-shm'):
                continue
            path = os.path.join(root, f)
            if os.path.getsize(path) < PAGE_SZ:
                continue
            with open(path, 'rb') as fh:
                page1 = fh.read(PAGE_SZ)
            salt = page1[:SALT_SZ]
            enc_key = derive_enc_key(password, salt)
            if verify_page1(enc_key, salt, page1):
                rel = os.path.relpath(path, db_dir).replace('\\', '_')
                decrypt_db(path, os.path.join(out_dir, rel), enc_key)
                print("[OK] %s" % rel, flush=True)
                ok += 1
            else:
                print("[FAIL] %s (HMAC 验证失败)" % os.path.relpath(path, db_dir), flush=True)
                fail += 1
    print("\n结果: %d OK, %d FAIL, %.0fs" % (ok, fail, time.time() - t0))
    print("输出: %s" % out_dir)

if __name__ == '__main__':
    main()

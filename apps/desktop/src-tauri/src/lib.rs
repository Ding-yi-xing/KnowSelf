use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

fn log_file(data_dir: &std::path::Path) -> PathBuf {
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    log_dir.join("desktop.log")
}

fn append_log(log_path: &PathBuf, msg: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(f, "{}", msg);
    }
    // also try stderr (may show in console if run from terminal on some systems)
    let _ = eprintln!("{}", msg);
}

fn wait_for_server(timeout_secs: u64, log_path: PathBuf) -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    let url = "http://127.0.0.1:9527/api/system/status";
    for i in 0..timeout_secs {
        if let Ok(resp) = client.get(url).send() {
            if resp.status().is_success() {
                return true;
            }
        }
        append_log(&log_path, &format!("[tauri] health check attempt {}/{}", i + 1, timeout_secs));
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    false
}

fn has_contents(dir: &std::path::Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    dir.read_dir().ok().map_or(false, |mut it| it.next().is_some())
}

fn ensure_default_settings(data_dir: &std::path::Path, log_path: &PathBuf) {
    let settings_path = data_dir.join("settings.json");
    if settings_path.exists() {
        return;
    }
    let default_settings = serde_json::json!({
        "schema_version": 1,
        "app": {
            "locale": "zh-CN",
            "theme": "system",
            "open_browser_on_start": false,
            "server_port": 9527,
            "feature_flags": {
                "auto_writeback": true,
                "system_status_page": true,
                "debug_panel": false
            }
        },
        "conversation": {
            "default_provider_id": "",
            "default_tools_enabled": true,
            "default_write_back": true,
            "max_tool_iterations": 8,
            "history_retention_days": 0,
            "history_messages_per_conversation": 500,
            "writeback_provider_id": ""
        },
        "providers": [],
        "mcp_servers": [],
        "builtin_tools": [],
        "tool_defaults": {
            "enabled_globally": true,
            "per_template": {},
            "system_prompt_addendum": ""
        },
        "retrieval": {
            "enabled": false,
            "embedding_model_id": "Xenova/bge-small-zh-v1.5",
            "embedding_cache_dir": "data/models",
            "chunk_target_tokens": 256,
            "chunk_overlap_tokens": 32,
            "parent_max_tokens": 2000,
            "rrf_k": 60,
            "rerank_provider_id": "",
            "rerank_model": "",
            "rerank_top_k": 30,
            "rerank_timeout_ms": 15000,
            "classifier_provider_id": "",
            "classifier_max_cards": 3,
            "token_budget": 20000,
            "token_budget_l1": 1500,
            "token_budget_l2": 2500,
            "token_budget_l3": 4000,
            "token_budget_history": 6000,
            "freshness_boost": 0.1,
            "memory_load_threshold": 5000,
            "fallback_when_no_embed": true,
            "fallback_when_no_rerank": true,
            "fallback_when_no_classify": "last_used"
        },
        "storage": {
            "data_dir": "data",
            "backup_enabled": false,
            "backup_keep_days": 30
        }
    });
    if let Ok(json) = serde_json::to_string_pretty(&default_settings) {
        std::fs::write(&settings_path, &json).ok();
        append_log(log_path, &format!("[tauri] created default settings.json at {}", settings_path.display()));
    }
}

fn kill_stale_sidecar_on_port(port: u16, log_path: &PathBuf) {
    use std::process::Command as StdCommand;

    let out = StdCommand::new("cmd")
        .args(["/C", &format!("netstat -ano -p tcp | findstr :{}", port)])
        .output();

    let stdout = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return,
    };

    let mut pids: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if !line.contains("LISTENING") { continue; }
        if let Some(pid) = line.split_whitespace().last() {
            if pid.chars().all(|c| c.is_ascii_digit()) && pid != "0" {
                pids.push(pid.to_string());
            }
        }
    }

    for pid in pids {
        let q = StdCommand::new("cmd")
            .args(["/C", &format!("tasklist /FI \"PID eq {}\" /NH /FO CSV", pid)])
            .output();
        let qout = q.ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        if !qout.to_lowercase().contains("node-win64.exe") {
            append_log(log_path, &format!("[tauri] port {} held by PID {} but not node-win64.exe; skip kill", port, pid));
            continue;
        }
        let _ = StdCommand::new("cmd")
            .args(["/C", &format!("taskkill /F /PID {}", pid)])
            .output();
        append_log(log_path, &format!("[tauri] killed stale sidecar PID {} on port {}", pid, port));
    }

    std::thread::sleep(std::time::Duration::from_millis(500));
}

fn spawn_sidecar(
    server_exe: &std::path::Path,
    server_script: &std::path::Path,
    binaries_dir: &std::path::Path,
    node_modules: &std::path::Path,
    data_dir: &std::path::Path,
    log_path: &PathBuf,
) -> Option<Child> {
    match Command::new(server_exe)
        .arg(server_script)
        .current_dir(binaries_dir)
        .env("KNOWSELF_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("NODE_PATH", node_modules.to_string_lossy().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => Some(c),
        Err(e) => {
            append_log(log_path, &format!("[tauri] failed to spawn sidecar: {}", e));
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();

            let log_path = log_file(&data_dir);
            append_log(&log_path, &format!("--- knowSelf desktop started ---"));
            append_log(&log_path, &format!("[tauri] resource_dir: {}", resource_dir.display()));
            append_log(&log_path, &format!("[tauri] data_dir: {}", data_dir.display()));

            ensure_default_settings(&data_dir, &log_path);

            let binaries_dir = resource_dir.join("binaries");
            let server_exe = binaries_dir.join("node-win64.exe");
            let server_script = binaries_dir.join("server-bundled.cjs");
            let node_modules = binaries_dir.join("node_modules");

            for (label, p) in [
                ("binaries", &binaries_dir as &std::path::Path),
                ("node-win64.exe", &server_exe),
                ("server-bundled.cjs", &server_script),
                ("node_modules", &node_modules),
            ] {
                append_log(&log_path, &format!(
                    "[tauri] {}: exists={} has_content={} path={}",
                    label,
                    p.exists(),
                    if p.is_dir() { has_contents(p) } else { p.exists() },
                    p.display()
                ));
            }

            if !server_exe.exists() || !server_script.exists() {
                append_log(&log_path, &format!("[tauri] server bundle not found at {}", binaries_dir.display()));
                return Ok(());
            }

            kill_stale_sidecar_on_port(9527, &log_path);

            let mut child = match spawn_sidecar(&server_exe, &server_script, &binaries_dir,
                                                 &node_modules, &data_dir, &log_path) {
                Some(c) => c,
                None => {
                    kill_stale_sidecar_on_port(9527, &log_path);
                    match spawn_sidecar(&server_exe, &server_script, &binaries_dir,
                                        &node_modules, &data_dir, &log_path) {
                        Some(c) => c,
                        None => {
                            append_log(&log_path, "[tauri] sidecar spawn failed twice; giving up");
                            return Ok(());
                        }
                    }
                }
            };

            let log_for_stderr = log_path.clone();
            let mut child_stderr = child.stderr.take().expect("child stderr should be piped");
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = child_stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    append_log(&log_for_stderr, &format!("[server:err] {}", String::from_utf8_lossy(&buf[..n]).trim_end()));
                }
            });

            let log_for_stdout = log_path.clone();
            let mut child_stdout = child.stdout.take().expect("child stdout should be piped");
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = child_stdout.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    append_log(&log_for_stdout, &format!("[server:out] {}", String::from_utf8_lossy(&buf[..n]).trim_end()));
                }
            });

            app.manage(ServerProcess(Mutex::new(Some(child))));

            // 临时:启动后自动打开 devtools(用于排查 UI 不显示问题)
            // 修完后移除此段 + 撤掉 Cargo.toml 的 devtools feature
            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
                append_log(&log_path, "[tauri] devtools opened (debug mode)");
            }

            let log_for_health = log_path.clone();
            std::thread::spawn(move || {
                let ready = wait_for_server(30, log_for_health);
                if ready {
                    append_log(&log_path, "[tauri] server ready on http://127.0.0.1:9527");
                } else {
                    append_log(&log_path, "[tauri] server failed to start within 30s");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

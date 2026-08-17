#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};

struct LauncherState {
    child: Mutex<Option<Child>>,
    data_dir: PathBuf,
    log_file: PathBuf,
}

fn append_log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", chrono_like_timestamp(), message);
    }
}

fn chrono_like_timestamp() -> String {
    format!("[{}]", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or_default())
}

fn stop_child(child: &mut Child, log_file: &Path) {
    let pid = child.id() as i32;
    #[cfg(target_os = "macos")]
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
    append_log(log_file, "launcher child stopped");
}

fn start_launcher(app: &AppHandle, state: &LauncherState) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "launcher state lock poisoned")?;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) | Err(_) => *guard = None,
        }
    }
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let node = resource_dir
        .parent()
        .unwrap_or(&resource_dir)
        .join("MacOS/node");
    let launcher = resource_dir.join("app/scripts/launcher.mjs");
    let game_root = resource_dir.join("app/game/web-desktop");
    let profile = state.data_dir.join("codex-profile");
    fs::create_dir_all(&profile).map_err(|error| error.to_string())?;
    let log = File::create(&state.log_file).map_err(|error| error.to_string())?;
    let stderr = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(node);
    command
        .arg(launcher)
        .arg("--open")
        .env("CODEX_DOUDIZHU_GAME_ROOT", game_root)
        .env("CODEX_DOUDIZHU_PROFILE", profile)
        .env_remove("CODEX_API_KEY")
        .current_dir(&resource_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "macos")]
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let child = command.spawn().map_err(|error| error.to_string())?;
    append_log(&state.log_file, &format!("launcher started pid={}", child.id()));
    *guard = Some(child);
    Ok(())
}

fn open_panel(state: &LauncherState) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "launcher state lock poisoned")?;
    let Some(child) = guard.as_mut() else { return Err("launcher is not running".into()); };
    if child.try_wait().map_err(|error| error.to_string())?.is_some() {
        *guard = None;
        return Err("launcher has exited".into());
    }
    #[cfg(target_os = "macos")]
    unsafe {
        if libc::kill(child.id() as i32, libc::SIGUSR1) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

fn stop_launcher(state: &LauncherState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() { stop_child(child, &state.log_file); }
        *guard = None;
    }
}

fn main() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let home = app.path().home_dir()?;
            let data_dir = home.join("Library/Application Support/Codex 斗地主");
            let log_dir = home.join("Library/Logs/Codex 斗地主");
            fs::create_dir_all(&data_dir)?;
            fs::create_dir_all(&log_dir)?;
            let state = LauncherState { child: Mutex::new(None), data_dir, log_file: log_dir.join("launcher.log") };
            app.manage(state);

            let info = MenuItem::with_id(app, "info", "Codex 斗地主 1.0.0", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "打开斗地主", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重新打开 Codex", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&info, &open, &restart, &quit])?;
            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/icon.png"))
                .icon_as_template(false)
                .tooltip("Codex 斗地主")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let Some(state) = app.try_state::<LauncherState>() else { return; };
                    match event.id().as_ref() {
                        "open" => {
                            if open_panel(&state).is_err() { let _ = start_launcher(app, &state); }
                        }
                        "restart" => {
                            stop_launcher(&state);
                            let _ = start_launcher(app, &state);
                        }
                        "quit" => {
                            stop_launcher(&state);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            let state = app.state::<LauncherState>();
            start_launcher(app.handle(), &state)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Codex 斗地主");
    app.run(|app_handle, event| {
        if let RunEvent::Reopen { .. } = event {
            if let Some(state) = app_handle.try_state::<LauncherState>() {
                if open_panel(&state).is_err() { let _ = start_launcher(app_handle, &state); }
            }
        }
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<LauncherState>() { stop_launcher(&state); }
        }
    });
}

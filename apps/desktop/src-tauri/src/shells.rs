use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
};

use portable_pty::CommandBuilder;
use uuid::Uuid;

use crate::{models::ShellProfile, path_utils::strip_windows_verbatim_prefix};

const POWERSHELL_CWD_HOOK: &str = "$global:__AgentTerminalOriginalPrompt=$function:prompt; function global:prompt { $loc=$executionContext.SessionState.Path.CurrentLocation; $path=$loc.ProviderPath; if (-not $path) { $path=[string]$loc }; $prefix=[string]([char]27)+']9;9;'+$path+[char]27+'\\'; if ($global:__AgentTerminalOriginalPrompt) { $prefix+(& $global:__AgentTerminalOriginalPrompt) } else { $prefix+'PS '+$path+'> ' } }";

pub fn detect_shells() -> Vec<ShellProfile> {
    let mut shells = Vec::new();
    let system_root = env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let powershell =
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if powershell.exists() {
        shells.push(profile(
            "powershell",
            "Windows PowerShell",
            powershell.to_string_lossy(),
            &["-NoLogo"],
        ));
    }
    if command_exists("pwsh.exe") {
        shells.push(profile("pwsh", "PowerShell 7", "pwsh.exe", &["-NoLogo"]));
    }
    shells.push(profile(
        "cmd",
        "Command Prompt",
        env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()),
        &[],
    ));
    if command_exists("wsl.exe") {
        shells.push(profile("wsl", "WSL", "wsl.exe", &[]));
    }

    let git_candidates = [
        env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|path| path.join("Git/bin/bash.exe")),
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Programs/Git/bin/bash.exe")),
    ];
    if let Some(git_bash) = git_candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
    {
        shells.push(profile(
            "git-bash",
            "Git Bash",
            git_bash.to_string_lossy(),
            &["--login", "-i"],
        ));
    }
    shells
}

pub fn command_for(shell: &ShellProfile, cwd: &str) -> CommandBuilder {
    let mut args = shell.args.clone();
    let mut extra_environment = HashMap::new();
    extra_environment.insert("WT_SESSION".to_string(), Uuid::new_v4().to_string());
    extra_environment.insert("TERM_PROGRAM".to_string(), "AgentTerminal".to_string());

    match shell.id.as_str() {
        "powershell" | "pwsh" => {
            args.extend([
                "-NoExit".into(),
                "-Command".into(),
                POWERSHELL_CWD_HOOK.into(),
            ]);
        }
        "cmd" => {
            let original = env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
            extra_environment.insert("PROMPT".into(), format!("$e]9;9;$P$e\\{original}"));
        }
        "git-bash" => {
            let report = r#"printf "\033]9;9;%s\007" "$(cygpath -w "$PWD" -C ANSI)""#;
            let prompt = env::var("PROMPT_COMMAND")
                .map(|value| format!("{value};{report}"))
                .unwrap_or_else(|_| report.into());
            extra_environment.insert("PROMPT_COMMAND".into(), prompt);
        }
        "wsl" => {
            let report = r#"printf "\033]9;9;%s\007" "$(wslpath -w "$PWD")""#;
            let prompt = env::var("PROMPT_COMMAND")
                .map(|value| format!("{value};{report}"))
                .unwrap_or_else(|_| report.into());
            let mut wslenv: HashSet<String> = env::var("WSLENV")
                .unwrap_or_default()
                .split(':')
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect();
            wslenv.insert("PROMPT_COMMAND/w".into());
            extra_environment.insert("PROMPT_COMMAND".into(), prompt);
            extra_environment.insert(
                "WSLENV".into(),
                wslenv.into_iter().collect::<Vec<_>>().join(":"),
            );
        }
        _ => {}
    }

    let mut command = CommandBuilder::new(&shell.executable);
    command.args(args);
    command.cwd(strip_windows_verbatim_prefix(cwd));
    for (key, value) in extra_environment {
        command.env(key, value);
    }
    command
}

fn command_exists(command: &str) -> bool {
    executable_on_path(command, env::var_os("PATH").as_deref())
}

fn executable_on_path(command: &str, path: Option<&OsStr>) -> bool {
    // `where.exe` is a console-subsystem binary: launching it from the
    // GUI-subsystem host allocates a visible console window per lookup, so
    // every shell probe flashed a cmd window on startup. A PATH scan finds
    // the same executables without spawning a process at all.
    let names = if cfg!(windows) && Path::new(command).extension().is_none() {
        vec![command.to_string(), format!("{command}.exe")]
    } else {
        vec![command.to_string()]
    };
    path.map(std::env::split_paths)
        .map(|mut dirs| {
            dirs.any(|dir| {
                names
                    .iter()
                    .any(|name| dir.join(name).is_file())
            })
        })
        .unwrap_or(false)
}

fn profile(id: &str, name: &str, executable: impl ToString, args: &[&str]) -> ShellProfile {
    ShellProfile {
        id: id.into(),
        name: name.into(),
        executable: executable.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::executable_on_path;
    use std::{
        env,
        ffi::{OsStr, OsString},
        fs,
        path::PathBuf,
    };
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state")
            .join(format!("shells-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create shell test directory");
        dir
    }

    fn joined_path(dirs: impl IntoIterator<Item = PathBuf>) -> OsString {
        env::join_paths(dirs).expect("join test path")
    }

    #[test]
    fn finds_an_executable_in_a_path_directory() {
        let dir = temp_dir();
        fs::write(dir.join("sample-tool.exe"), b"").expect("write executable");
        let path = joined_path([dir.clone()]);
        assert!(executable_on_path("sample-tool.exe", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn misses_a_missing_executable() {
        let dir = temp_dir();
        let path = joined_path([dir.clone()]);
        assert!(!executable_on_path("missing-tool.exe", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn no_path_environment_means_not_found() {
        assert!(!executable_on_path("sample-tool.exe", None));
    }

    #[test]
    fn empty_path_means_not_found() {
        assert!(!executable_on_path("sample-tool.exe", Some(OsStr::new(""))));
    }

    #[test]
    fn later_path_directories_are_searched() {
        let first = temp_dir();
        let second = temp_dir();
        fs::write(second.join("later-tool.exe"), b"").expect("write executable");
        let path = joined_path([first.clone(), second.clone()]);
        assert!(executable_on_path("later-tool.exe", Some(&path)));
        fs::remove_dir_all(&first).expect("clean up");
        fs::remove_dir_all(&second).expect("clean up");
    }

    #[test]
    fn a_directory_does_not_count_as_an_executable() {
        let dir = temp_dir();
        fs::create_dir(dir.join("sample-tool.exe")).expect("create directory");
        let path = joined_path([dir.clone()]);
        assert!(!executable_on_path("sample-tool.exe", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn an_explicit_extension_matches_only_that_name() {
        let dir = temp_dir();
        fs::write(dir.join("sample-tool"), b"").expect("write file");
        let path = joined_path([dir.clone()]);
        assert!(!executable_on_path("sample-tool.exe", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn a_name_with_an_extension_never_appends_exe() {
        let dir = temp_dir();
        fs::write(dir.join("tool.cmd"), b"").expect("write file");
        let path = joined_path([dir.clone()]);
        assert!(executable_on_path("tool.cmd", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn an_extensionless_name_matches_a_same_named_file() {
        let dir = temp_dir();
        fs::write(dir.join("sample-tool"), b"").expect("write file");
        let path = joined_path([dir.clone()]);
        assert!(executable_on_path("sample-tool", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }

    #[cfg(windows)]
    #[test]
    fn an_extensionless_name_matches_its_exe_sibling() {
        let dir = temp_dir();
        fs::write(dir.join("sample-tool.exe"), b"").expect("write executable");
        let path = joined_path([dir.clone()]);
        assert!(executable_on_path("sample-tool", Some(&path)));
        fs::remove_dir_all(&dir).expect("clean up");
    }
}

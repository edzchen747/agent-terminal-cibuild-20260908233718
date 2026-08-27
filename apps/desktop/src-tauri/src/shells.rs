use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    process::{Command, Stdio},
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
    Command::new("where.exe")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn profile(id: &str, name: &str, executable: impl ToString, args: &[&str]) -> ShellProfile {
    ShellProfile {
        id: id.into(),
        name: name.into(),
        executable: executable.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
    }
}

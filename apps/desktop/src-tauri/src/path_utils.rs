use std::path::{Path, PathBuf};

pub fn user_visible_path(path: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(strip_windows_verbatim_prefix(
        path.as_ref().to_string_lossy().as_ref(),
    ))
}

pub fn strip_windows_verbatim_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::strip_windows_verbatim_prefix;

    #[test]
    fn removes_windows_verbatim_drive_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\person\Project"),
            r"C:\Users\person\Project"
        );
    }

    #[test]
    fn converts_windows_verbatim_unc_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\Project"),
            r"\\server\share\Project"
        );
    }
}

use std::path::Path;

pub fn git_state_metadata_repository_root(path: &Path) -> Option<&Path> {
    let git_dir = path
        .ancestors()
        .find(|ancestor| ancestor.file_name().is_some_and(|name| name == ".git"))?;
    let relative_path = path.strip_prefix(git_dir).ok()?;
    let affects_git_state = relative_path == Path::new("HEAD")
        || relative_path == Path::new("index")
        || relative_path == Path::new("packed-refs")
        || relative_path.starts_with("refs");
    affects_git_state.then(|| git_dir.parent()).flatten()
}

pub fn is_git_metadata_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".git")
}

#[cfg(test)]
mod tests {
    use super::{git_state_metadata_repository_root, is_git_metadata_path};
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_git_state_metadata_to_repository_root() {
        let repo_root = Path::new("/Users/demo/.skilldock/plugins/browser");

        assert_eq!(
            git_state_metadata_repository_root(&repo_root.join(".git/refs/heads/main")),
            Some(repo_root)
        );
        assert_eq!(
            git_state_metadata_repository_root(&repo_root.join(".git/packed-refs")),
            Some(repo_root)
        );
        assert_eq!(
            git_state_metadata_repository_root(&repo_root.join(".git/objects/ab/cd")),
            None
        );
    }

    #[test]
    fn detects_git_metadata_paths() {
        assert!(is_git_metadata_path(&PathBuf::from(
            "/Users/demo/plugin/.git/index"
        )));
        assert!(!is_git_metadata_path(&PathBuf::from(
            "/Users/demo/plugin/SKILL.md"
        )));
    }
}

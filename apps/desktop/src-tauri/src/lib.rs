//! Native file access for the WeiSQL desktop client.
//!
//! The webview never touches the filesystem directly: every byte comes through
//! one of these commands. `read_range` is the hot path — the SDK's resource
//! readers ask for exact byte ranges, so a query only pays for the pages it
//! actually reads.
//!
//! Paths are absolute and chosen by the user through the native dialog. The
//! commands are deliberately strict about bounds (a range must fit inside the
//! file) so a corrupt manifest fails loudly instead of returning short reads.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Upper bound for a single range read. A resource larger than this should be
/// streamed in chunks rather than materialised in the webview in one call.
const MAX_READ_BYTES: u64 = 512 * 1024 * 1024;

/// Directory listing limits keep a stray "open C:\" from freezing the UI.
const MAX_LISTED_FILES: usize = 20_000;
const MAX_LISTED_DEPTH: usize = 24;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub is_directory: bool,
    pub last_modified: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let resolved = PathBuf::from(path);
    if !resolved.is_absolute() {
        return Err(format!("path must be absolute: {path}"));
    }
    Ok(resolved)
}

fn read_bytes(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, String> {
    if end < start {
        return Err(format!("range end {end} is before start {start}"));
    }
    let length = end - start;
    if length > MAX_READ_BYTES {
        return Err(format!(
            "range of {length} bytes exceeds the {MAX_READ_BYTES} byte limit"
        ));
    }
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let file_length = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?
        .len();
    if end > file_length {
        return Err(format!(
            "range {start}-{end} exceeds file length {file_length}"
        ));
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(buffer)
}

fn stat_path(path: &Path) -> Result<FileStat, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    Ok(FileStat {
        size: metadata.len(),
        is_directory: metadata.is_dir(),
        last_modified,
    })
}

fn collect_files(
    directory: &Path,
    base: &Path,
    depth: usize,
    out: &mut Vec<FileEntry>,
) -> Result<(), String> {
    if depth > MAX_LISTED_DEPTH || out.len() >= MAX_LISTED_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|error| format!("{}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
        // Symlinks are skipped rather than followed: a package directory must
        // not be able to point the listing outside itself.
        let file_type = entry
            .file_type()
            .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(&path, base, depth + 1, out)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            out.push(FileEntry {
                path: relative,
                size,
            });
            if out.len() >= MAX_LISTED_FILES {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    stat_path(&absolute(&path)?)
}

/// Returns the requested bytes as a raw `ArrayBuffer` (not JSON/base64).
#[tauri::command]
pub fn read_range(path: String, start: u64, end: u64) -> Result<tauri::ipc::Response, String> {
    let bytes = read_bytes(&absolute(&path)?, start, end)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    let resolved = absolute(&path)?;
    let length = fs::metadata(&resolved)
        .map_err(|error| format!("{}: {error}", resolved.display()))?
        .len();
    let bytes = read_bytes(&resolved, 0, length)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<FileEntry>, String> {
    let root = absolute(&path)?;
    let metadata = fs::metadata(&root).map_err(|error| format!("{}: {error}", root.display()))?;
    if !metadata.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let mut files = Vec::new();
    collect_files(&root, &root, 0, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            stat_file,
            read_range,
            read_file,
            list_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running WeiSQL Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let id = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "weisql-desktop-test-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(dir: &Path) -> PathBuf {
        let path = dir.join("data.bin");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"0123456789").unwrap();
        path
    }

    #[test]
    fn reads_an_exact_range() {
        let dir = TempDir::new();
        let path = sample(&dir.0);
        assert_eq!(read_bytes(&path, 2, 5).unwrap(), b"234".to_vec());
        assert_eq!(read_bytes(&path, 0, 10).unwrap(), b"0123456789".to_vec());
        assert_eq!(read_bytes(&path, 10, 10).unwrap().len(), 0);
    }

    #[test]
    fn rejects_inverted_and_out_of_bounds_ranges() {
        let dir = TempDir::new();
        let path = sample(&dir.0);
        assert!(read_bytes(&path, 5, 4).is_err());
        assert!(read_bytes(&path, 0, 11).is_err());
        assert!(read_bytes(&path, 11, 12).is_err());
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(absolute("data/manifest.json").is_err());
    }

    #[test]
    fn stats_files_and_directories() {
        let dir = TempDir::new();
        let path = sample(&dir.0);
        let stat = stat_path(&path).unwrap();
        assert_eq!(stat.size, 10);
        assert!(!stat.is_directory);
        assert!(stat.last_modified.is_some());
        assert!(stat_path(&dir.0).unwrap().is_directory);
    }

    #[test]
    fn lists_files_recursively_with_relative_paths() {
        let dir = TempDir::new();
        sample(&dir.0);
        fs::create_dir_all(dir.0.join("nested")).unwrap();
        fs::write(dir.0.join("nested").join("manifest.json"), b"{}").unwrap();

        let mut files = Vec::new();
        collect_files(&dir.0, &dir.0, 0, &mut files).unwrap();
        files.sort_by(|left, right| left.path.cmp(&right.path));

        let paths: Vec<&str> = files.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["data.bin", "nested/manifest.json"]);
        assert_eq!(files[0].size, 10);
        assert_eq!(files[1].size, 2);
    }
}

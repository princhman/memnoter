use crate::*;
use std::io::Write;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportImage {
    pub id: String,
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

// Hold the database lock across filesystem work as well as the transaction:
// backups and other writers must never observe half of an import.
pub fn import_module(
    data_dir: &Path,
    db: &Db,
    name: String,
    bytes: Vec<u8>,
    images: Vec<ImportImage>,
) -> CommandResult<String> {
    let mut conn = db.lock()?;
    let id = Uuid::new_v4().to_string();
    let mut written = Vec::new();
    let result = (|| {
        for image in &images {
            if Uuid::parse_str(&image.id).is_err() {
                return Err("Invalid import image ID".into());
            }
            let path = data_dir.join("files").join(&image.id);
            // Never overwrite another note's asset, including on a duplicate id.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(db_err)?;
            written.push(path);
            file.write_all(&image.bytes).map_err(db_err)?;
            file.sync_all().map_err(db_err)?;
        }
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute(
            "insert into modules (id, name) values (?1, ?2)",
            params![id, name],
        )
        .map_err(db_err)?;
        tx.execute(
            "insert into contents (module_id, state) values (?1, ?2)",
            params![id, bytes],
        )
        .map_err(db_err)?;
        tx.execute(
            "insert into search_index (module_id, title, body, math) values (?1, ?2, '', '')",
            params![id, name],
        )
        .map_err(db_err)?;
        sync::record_module(&tx, &id, sync::VaultChange::Name(&name))?;
        for (image, path) in images.iter().zip(&written) {
            tx.execute(
                "insert into files (id, module_id, path, file_type) values (?1, ?2, ?3, ?4)",
                params![
                    image.id,
                    id,
                    path.to_str().ok_or("Invalid image path")?,
                    image.mime_type
                ],
            )
            .map_err(db_err)?;
            sync::record_file(&tx, &image.id, &id, &image.mime_type)?;
        }
        asset_refs::retain_module(&tx, &id)?;
        sync::record_update(&tx, &id, &bytes)?;
        tx.commit().map_err(db_err)?;
        Ok(id)
    })();
    if result.is_err() {
        for path in written {
            if let Err(error) = std::fs::remove_file(&path) {
                return Err(format!(
                    "Import failed: {}. Image cleanup failed: {error}",
                    result.unwrap_err()
                ));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Temp, Core) {
        let dir = Temp(std::env::temp_dir().join(format!("memnoter-import-{}", Uuid::new_v4())));
        let core = Core::open(&dir.0).unwrap();
        sync::sync_enable(&core.db, "test".into()).unwrap();
        core.db
            .lock()
            .unwrap()
            .execute("delete from sync_outbox", [])
            .unwrap();
        (dir, core)
    }
    fn image() -> ImportImage {
        ImportImage {
            id: Uuid::new_v4().to_string(),
            bytes: vec![1, 2],
            mime_type: "image/png".into(),
        }
    }
    #[test]
    fn import_commits_complete_content_assets_and_sync_together() {
        let (dir, core) = fixture();
        let image = image();
        let file_id = image.id.clone();
        let id = import_module(&dir.0, &core.db, "Course".into(), vec![0, 0], vec![image]).unwrap();
        let content = get_content(&core.db, id.clone()).unwrap();
        assert_eq!(content.state, [0, 0]);
        assert!(content.updates.is_empty());
        assert_eq!(content.files.len(), 1);
        assert_eq!(std::fs::read(&content.files[0].path).unwrap(), [1, 2]);
        let conn = core.db.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "select count(*) from sync_outbox where doc = ?1 and bytes = X'0000'",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "select count(*) from sync_file_uploads where file_id = ?1",
                [&file_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "select title from search_index where module_id = ?1",
                [&id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Course"
        );
        drop(conn);
        drop(core);
        let reopened = Core::open(&dir.0).unwrap();
        assert_eq!(get_content(&reopened.db, id).unwrap().files.len(), 1);
        assert!(dir.0.join("files").join(file_id).exists());
    }
    #[test]
    fn failures_at_each_persistence_stage_roll_back_database_sync_and_files() {
        for table in [
            "modules",
            "contents",
            "search_index",
            "files",
            "sync_file_uploads",
            "sync_outbox",
        ] {
            let (dir, core) = fixture();
            if table == "search_index" {
                core.db
                    .lock()
                    .unwrap()
                    .execute_batch("drop table search_index")
                    .unwrap();
            } else {
                let condition = if table == "sync_outbox" {
                    "when new.doc <> 'vault'"
                } else {
                    ""
                };
                core.db.lock().unwrap().execute_batch(&format!("create trigger fail_import before insert on {table} {condition} begin select raise(abort, 'injected failure'); end;")).unwrap();
            }
            assert!(
                import_module(
                    &dir.0,
                    &core.db,
                    "Course".into(),
                    vec![0, 0],
                    vec![image(), image()]
                )
                .is_err(),
                "{table}"
            );
            assert!(modules(&core.db).unwrap().is_empty(), "{table}");
            assert_eq!(
                std::fs::read_dir(dir.0.join("files")).unwrap().count(),
                0,
                "{table}"
            );
            let failed_stage = table;
            for table in [
                "contents",
                "files",
                "search_index",
                "sync_outbox",
                "sync_file_uploads",
            ] {
                if table == "search_index" && failed_stage == "search_index" {
                    continue;
                }
                assert_eq!(
                    core.db
                        .lock()
                        .unwrap()
                        .query_row(&format!("select count(*) from {table}"), [], |r| r
                            .get::<_, i64>(0))
                        .unwrap(),
                    0,
                    "{table}"
                );
            }
        }
    }
    #[test]
    fn image_write_and_validation_failures_remove_earlier_files_without_overwriting_assets() {
        let (dir, core) = fixture();
        let existing = image();
        let path = dir.0.join("files").join(&existing.id);
        std::fs::write(&path, b"existing").unwrap();
        for images in [
            vec![image(), existing],
            vec![
                image(),
                ImportImage {
                    id: "../escape".into(),
                    ..image()
                },
            ],
        ] {
            assert!(import_module(&dir.0, &core.db, "Course".into(), vec![0, 0], images).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"existing");
            assert_eq!(std::fs::read_dir(dir.0.join("files")).unwrap().count(), 1);
            assert!(modules(&core.db).unwrap().is_empty());
        }
        assert!(import_module(
            &dir.0,
            &core.db,
            "Invalid Yjs".into(),
            vec![255],
            vec![image()]
        )
        .is_err());
        assert!(modules(&core.db).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(dir.0.join("files")).unwrap().count(), 1);
    }
    #[test]
    fn killed_import_never_publishes_partial_module_and_restart_cleans_images() {
        use std::time::{Duration, Instant};
        fn wait_for(path: &Path) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !path.exists() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for {}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if let Some(dir) = std::env::var_os("MEMNOTER_CRASH_IMPORT_TEST") {
            let dir = PathBuf::from(dir);
            let core = Core::open(&dir).unwrap();
            std::fs::write(dir.join("ready"), []).unwrap();
            wait_for(&dir.join("go"));
            let image = ImportImage {
                id: std::fs::read_to_string(dir.join("image-id")).unwrap(),
                ..image()
            };
            import_module(
                &dir,
                &core.db,
                "Interrupted".into(),
                vec![0, 0],
                vec![image],
            )
            .unwrap();
            panic!("Parent must kill the importer before it can commit");
        }
        let (dir, core) = fixture();
        let saved = create_module(&core.db, "Saved".into()).unwrap();
        let imported_image = Uuid::new_v4().to_string();
        std::fs::write(dir.0.join("image-id"), &imported_image).unwrap();
        let mut worker = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "import::tests::killed_import_never_publishes_partial_module_and_restart_cleans_images"])
            .env("MEMNOTER_CRASH_IMPORT_TEST", &dir.0)
            .stdout(std::process::Stdio::null())
            .spawn().unwrap();
        wait_for(&dir.0.join("ready"));
        // Block the child's database writes after it has opened the core. Its
        // real import writes images first, then waits at the SQLite transaction.
        let conn = core.db.lock().unwrap();
        conn.execute_batch("begin immediate").unwrap();
        std::fs::write(dir.0.join("go"), []).unwrap();
        let orphan = dir.0.join("files").join(imported_image);
        wait_for(&orphan);
        worker.kill().unwrap();
        assert!(!worker.wait().unwrap().success());
        conn.execute_batch("rollback").unwrap();
        drop(conn);
        drop(core);
        let reopened = Core::open(&dir.0).unwrap();
        let modules = modules(&reopened.db).unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].id, saved);
        assert!(!orphan.exists());
        assert_eq!(std::fs::read_dir(dir.0.join("files")).unwrap().count(), 0);
    }

    #[test]
    fn restart_cleans_precommit_crash_files_and_preserves_saved_leased_assets() {
        let (dir, core) = fixture();
        let id = create_module(&core.db, "Saved".into()).unwrap();
        let saved = save_file(&dir.0, &core.db, id, vec![7], "image/png".into()).unwrap();
        let orphan = dir.0.join("files").join(Uuid::new_v4().to_string());
        std::fs::write(&orphan, b"crashed import").unwrap();
        let unmanaged = dir.0.join("files/keep.txt");
        std::fs::write(&unmanaged, b"keep").unwrap();
        drop(core);
        let core = Core::open(&dir.0).unwrap();
        assert_eq!(modules(&core.db).unwrap().len(), 1);
        assert!(!orphan.exists());
        assert!(Path::new(&saved.path).exists());
        assert!(unmanaged.exists());
    }
}

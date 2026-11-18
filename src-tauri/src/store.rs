use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub timestamp: String,
    pub markdown: String,
    pub prompt: String,
    pub tags: Vec<String>,
    pub images: Vec<String>,
    pub provider: String,
    pub model: String,
    pub elapsed_ms: u64,
    pub image_count: u32,
}

pub struct Store {
    conn: Connection,
    images_dir: PathBuf,
}

fn parse_list(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let images_dir = data_dir.join("images");
        std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(data_dir.join("jieyi.db")).map_err(|e| e.to_string())?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                image_file TEXT NOT NULL,
                image_files_json TEXT NOT NULL DEFAULT '[]',
                prompt TEXT,
                markdown TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);",
        )
        .map_err(|e| e.to_string())?;

        // Columns added by this rewrite; ignored when the schema already has them.
        for ddl in [
            "ALTER TABLE entries ADD COLUMN provider TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE entries ADD COLUMN model TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE entries ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = conn.execute(ddl, []);
        }

        Ok(Self { conn, images_dir })
    }

    pub fn images_dir(&self) -> &Path {
        &self.images_dir
    }

    pub fn list(&self) -> Result<Vec<Entry>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, timestamp, image_file, image_files_json, prompt, markdown, tags_json,
                        provider, model, elapsed_ms
                 FROM entries ORDER BY timestamp DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let image_file: String = row.get(2).unwrap_or_default();
                let images: Vec<String> = parse_list(row.get::<_, Option<String>>(3).ok().flatten());
                let images = if images.is_empty() && !image_file.is_empty() {
                    vec![image_file]
                } else {
                    images
                };
                Ok(Entry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    markdown: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    prompt: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    tags: parse_list(row.get::<_, Option<String>>(6).ok().flatten()),
                    image_count: images.len() as u32,
                    images,
                    provider: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    model: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                    elapsed_ms: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Result<Option<Entry>, String> {
        Ok(self.list()?.into_iter().find(|e| e.id == id))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &self,
        id: &str,
        timestamp: &str,
        prompt: &str,
        markdown: &str,
        provider: &str,
        model: &str,
        elapsed_ms: u64,
        png: &[u8],
    ) -> Result<(), String> {
        let rel = format!("images/{id}.png");
        std::fs::write(self.images_dir.join(format!("{id}.png")), png).map_err(|e| e.to_string())?;
        let files_json = serde_json::to_string(&vec![rel.clone()]).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO entries
                 (id, timestamp, image_file, image_files_json, prompt, markdown, tags_json, provider, model, elapsed_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7, ?8, ?9)",
                params![id, timestamp, rel, files_json, prompt, markdown, provider, model, elapsed_ms as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_markdown(&self, id: &str, markdown: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE entries SET markdown = ?1 WHERE id = ?2", params![markdown, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_tags(&self, id: &str, tags: &[String]) -> Result<(), String> {
        let json = serde_json::to_string(tags).map_err(|e| e.to_string())?;
        self.conn
            .execute("UPDATE entries SET tags_json = ?1 WHERE id = ?2", params![json, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let images: Option<String> = self
            .conn
            .query_row("SELECT image_files_json FROM entries WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        for rel in parse_list(images) {
            let _ = std::fs::remove_file(self.images_dir.join(rel.trim_start_matches("images/")));
        }
        self.conn
            .execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

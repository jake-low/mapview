use anyhow::Context;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};

pub type MBTilesPool = Pool<SqliteConnectionManager>;

pub struct MBTilesMetadata {
    pub name: Option<String>,
    pub format: String,
    pub bounds: Option<[f64; 4]>,
    pub minzoom: Option<u8>,
    pub maxzoom: Option<u8>,
    pub attribution: Option<String>,
    pub vector_layers: Option<Vec<VectorLayer>>,
}

#[derive(Serialize, Deserialize)]
pub struct VectorLayer {
    pub id: String,
    #[serde(flatten)]
    pub other: serde_json::Value,
}

/// Build a small read-only connection pool for an MBTiles file.
pub fn open_pool(path: &str) -> anyhow::Result<MBTilesPool> {
    let manager =
        SqliteConnectionManager::file(path).with_flags(rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
    Pool::builder()
        .max_size(8)
        .build(manager)
        .with_context(|| format!("Failed to open MBTiles pool: {}", path))
}

/// Read metadata from an MBTiles file.
pub fn get_metadata(pool: &MBTilesPool) -> anyhow::Result<MBTilesMetadata> {
    let conn = pool.get()?;

    let mut stmt = conn.prepare("SELECT name, value FROM metadata")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let mut name = None;
    let mut format = String::from("png");
    let mut bounds = None;
    let mut minzoom = None;
    let mut maxzoom = None;
    let mut attribution = None;
    let mut vector_layers = None;

    for (key, value) in &rows {
        match key.as_str() {
            "name" => name = Some(value.clone()),
            "format" => format = value.clone(),
            "bounds" => {
                let parts: Result<Vec<f64>, _> =
                    value.split(',').map(|s| s.trim().parse()).collect();
                if let Ok(b) = parts
                    && b.len() == 4
                {
                    bounds = Some([b[0], b[1], b[2], b[3]]);
                }
            }
            "minzoom" => minzoom = value.parse().ok(),
            "maxzoom" => maxzoom = value.parse().ok(),
            "attribution" => attribution = Some(value.clone()),
            "json" => {
                // The "json" metadata field contains vector_layers for pbf tiles
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value)
                    && let Some(layers) = parsed.get("vector_layers")
                    && let Ok(vl) = serde_json::from_value(layers.clone())
                {
                    vector_layers = vl;
                }
            }
            _ => {}
        }
    }

    Ok(MBTilesMetadata {
        name,
        format,
        bounds,
        minzoom,
        maxzoom,
        attribution,
        vector_layers,
    })
}

/// Read a tile from an MBTiles file. Returns None for missing tiles.
pub fn get_tile(pool: &MBTilesPool, z: u8, x: u32, y: u32) -> anyhow::Result<Option<Vec<u8>>> {
    let conn = pool.get()?;

    // MBTiles uses TMS y-axis (flipped relative to XYZ/slippy map)
    let tms_y = (1u32 << z) - 1 - y;

    let result = conn.query_row(
        "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
        (z, x, tms_y),
        |row| row.get::<_, Vec<u8>>(0),
    );

    match result {
        Ok(data) => Ok(Some(data)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

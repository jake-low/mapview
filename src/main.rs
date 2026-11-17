use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{self, Context, bail};
use clap::Parser;

use rocket::State;
use rocket::http::ContentType;
use rocket::response::content::{RawCss, RawHtml, RawJavaScript};
use rocket::tokio::sync::broadcast::{Sender, channel};
use rocket_seek_stream::SeekStream;
use rocket_ws::{Stream, WebSocket};

#[macro_use]
extern crate rocket;

mod mbtiles;

#[cfg(feature = "gdal")]
mod tiler;

struct Config {
    /// contents of files read from stdin, keyed by synthetic filename
    files: HashMap<String, Arc<[u8]>>,
    file_args: Vec<String>,
    /// local file paths that may be served, verbatim as passed on the command line
    local_files: HashSet<String>,
    mbtiles_files: HashMap<String, mbtiles::MBTilesPool>,
    port: u16,
    #[cfg(feature = "gdal")]
    geotiff_files: HashSet<String>,
}

#[get("/")]
fn index() -> RawHtml<&'static str> {
    let html = include_str!("../frontend/index.html");
    RawHtml(html)
}

#[get("/style.css")]
fn css() -> RawCss<&'static str> {
    let css = include_str!("../frontend/dist/style.css");
    RawCss(css)
}

#[get("/bundle.js")]
fn bundle() -> RawJavaScript<&'static str> {
    let js = include_str!("../frontend/dist/bundle.js");
    RawJavaScript(js)
}

#[get("/bundle.js.map")]
fn bundle_map() -> RawJavaScript<&'static str> {
    let js = include_str!("../frontend/dist/bundle.js.map");
    RawJavaScript(js)
}

#[get("/maplibre-gl-worker.js")]
fn maplibre_worker() -> RawJavaScript<&'static str> {
    let js = include_str!("../frontend/dist/maplibre-gl-worker.js");
    RawJavaScript(js)
}

#[derive(Responder)]
#[response(status = 404)]
struct NotFound(String);

#[derive(Responder)]
struct TileResponse {
    data: Vec<u8>,
    content_type: ContentType,
}

impl TileResponse {
    fn with_encoding(self, encoding: &'static str) -> TileResponseEncoded {
        TileResponseEncoded {
            inner: self,
            encoding,
        }
    }
}

struct TileResponseEncoded {
    inner: TileResponse,
    encoding: &'static str,
}

impl<'r> rocket::response::Responder<'r, 'static> for TileResponseEncoded {
    fn respond_to(self, req: &'r rocket::Request<'_>) -> rocket::response::Result<'static> {
        use rocket::http::Header;
        let mut response = self.inner.respond_to(req)?;
        response.set_header(Header::new("Content-Encoding", self.encoding));
        Ok(response)
    }
}

/// Parse "123.png" or "123.pbf" etc into (y, extension)
fn parse_y_and_ext(y_with_ext: &Path) -> Result<(u32, &str), NotFound> {
    let y_str = y_with_ext
        .to_str()
        .ok_or_else(|| NotFound("Invalid path".to_string()))?;

    let (y_part, ext) = y_str
        .rsplit_once('.')
        .ok_or_else(|| NotFound("Tile URL must have an extension".to_string()))?;

    let y = y_part
        .parse::<u32>()
        .map_err(|_| NotFound("Invalid tile coordinate".to_string()))?;

    Ok((y, ext))
}

fn content_type_for_ext(ext: &str) -> Result<ContentType, NotFound> {
    match ext {
        "png" => Ok(ContentType::PNG),
        "jpg" | "jpeg" => Ok(ContentType::JPEG),
        "webp" => Ok(ContentType::WEBP),
        "pbf" => Ok(ContentType::new("application", "x-protobuf")),
        _ => Err(NotFound(format!("Unsupported tile extension: {}", ext))),
    }
}

fn tile_url_template(port: u16, name: &str, ext: &str) -> String {
    // percent-encode the filename into a URL safe "key". this matches
    // how the server endpoints work, and avoids path-like arguments
    // being interpreted literally and causing tile requests to 404.
    let key = urlencoding::encode(name);

    format!("http://localhost:{port}/tiles/{key}/{{z}}/{{x}}/{{y}}.{ext}")
}

async fn serve_mbtiles_tile(
    pool: &mbtiles::MBTilesPool,
    z: u8,
    x: u32,
    y: u32,
    content_type: ContentType,
) -> Result<TileResponseEncoded, NotFound> {
    let pool = pool.clone();
    let result = rocket::tokio::task::spawn_blocking(move || mbtiles::get_tile(&pool, z, x, y))
        .await
        .map_err(|e| NotFound(format!("Tile task panicked: {}", e)))?;
    match result {
        Ok(Some(data)) => {
            // pbf tiles in MBTiles are usually gzip-compressed (per spec), but
            // not always in practice, so sniff for the gzip magic bytes
            let encoding = if data.starts_with(&[0x1f, 0x8b]) {
                "gzip"
            } else {
                "identity"
            };
            Ok(TileResponse { data, content_type }.with_encoding(encoding))
        }
        Ok(None) => Err(NotFound("Tile not found".to_string())),
        Err(e) => Err(NotFound(format!("Tile read failed: {}", e))),
    }
}

async fn serve_mbtiles_metadata(
    filename: &str,
    pool: &mbtiles::MBTilesPool,
    port: u16,
) -> Result<rocket::serde::json::Json<serde_json::Value>, NotFound> {
    let pool_cloned = pool.clone();
    let metadata = rocket::tokio::task::spawn_blocking(move || mbtiles::get_metadata(&pool_cloned))
        .await
        .map_err(|e| NotFound(format!("Metadata task panicked: {}", e)))?
        .map_err(|e| NotFound(format!("MBTiles metadata failed: {}", e)))?;

    let tile_ext = match metadata.format.as_str() {
        "pbf" => "pbf",
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    };
    let tile_url = tile_url_template(port, filename, tile_ext);

    let mut tj = serde_json::json!({
        "tilejson": "3.0.0",
        "tiles": [tile_url],
    });

    if let Some(name) = &metadata.name {
        tj["name"] = serde_json::json!(name);
    }
    if let Some(bounds) = &metadata.bounds {
        tj["bounds"] = serde_json::json!(bounds);
    }
    if let Some(minzoom) = metadata.minzoom {
        tj["minzoom"] = serde_json::json!(minzoom);
    }
    if let Some(maxzoom) = metadata.maxzoom {
        tj["maxzoom"] = serde_json::json!(maxzoom);
    }
    if let Some(attribution) = &metadata.attribution {
        tj["attribution"] = serde_json::json!(attribution);
    }
    if let Some(vector_layers) = &metadata.vector_layers {
        tj["vector_layers"] = serde_json::json!(vector_layers);
    }

    Ok(rocket::serde::json::Json(tj))
}

#[cfg(feature = "gdal")]
#[get("/tiles/<filename>/<z>/<x>/<y_with_ext..>")]
async fn tiles(
    filename: String,
    z: u8,
    x: u32,
    y_with_ext: PathBuf,
    config: &State<Config>,
    tiler: &State<tiler::Tiler>,
) -> Result<TileResponseEncoded, NotFound> {
    let (y, ext) = parse_y_and_ext(&y_with_ext)?;
    let content_type = content_type_for_ext(ext)?;

    if let Some(path) = config.mbtiles_files.get(&filename) {
        return serve_mbtiles_tile(path, z, x, y, content_type).await;
    }

    if config.geotiff_files.contains(&filename) {
        match tiler.generate_tile(&filename, z, x, y).await {
            Ok(data) => {
                return Ok(TileResponse {
                    data,
                    content_type: ContentType::PNG,
                }
                .with_encoding("identity"));
            }
            Err(e) => return Err(NotFound(format!("Tile generation failed: {}", e))),
        }
    }

    Err(NotFound("Tile source not found".to_string()))
}

#[cfg(not(feature = "gdal"))]
#[get("/tiles/<filename>/<z>/<x>/<y_with_ext..>")]
async fn tiles(
    filename: String,
    z: u8,
    x: u32,
    y_with_ext: PathBuf,
    config: &State<Config>,
) -> Result<TileResponseEncoded, NotFound> {
    let (y, ext) = parse_y_and_ext(&y_with_ext)?;
    let content_type = content_type_for_ext(ext)?;

    if let Some(path) = config.mbtiles_files.get(&filename) {
        return serve_mbtiles_tile(path, z, x, y, content_type).await;
    }

    Err(NotFound("Tile source not found".to_string()))
}

#[cfg(feature = "gdal")]
#[get("/files/<filename>/metadata.json")]
async fn tilejson(
    filename: String,
    config: &State<Config>,
    tiler: &State<tiler::Tiler>,
) -> Result<rocket::serde::json::Json<serde_json::Value>, NotFound> {
    if let Some(path) = config.mbtiles_files.get(&filename) {
        return serve_mbtiles_metadata(&filename, path, config.port).await;
    }

    if config.geotiff_files.contains(&filename) {
        match tiler.get_metadata(&filename).await {
            Ok(metadata) => {
                let tile_url = tile_url_template(config.port, &filename, "png");
                let tj = serde_json::json!({
                    "tilejson": "3.0.0",
                    "tiles": [tile_url],
                    "name": metadata.name,
                    "bounds": metadata.bounds,
                    "minzoom": metadata.minzoom,
                    "maxzoom": metadata.maxzoom,
                    "tileSize": tiler::TILE_SIZE,
                });
                return Ok(rocket::serde::json::Json(tj));
            }
            Err(e) => return Err(NotFound(format!("Metadata fetch failed: {}", e))),
        }
    }

    Err(NotFound("Tile source not found".to_string()))
}

#[cfg(not(feature = "gdal"))]
#[get("/files/<filename>/metadata.json")]
async fn tilejson(
    filename: String,
    config: &State<Config>,
) -> Result<rocket::serde::json::Json<serde_json::Value>, NotFound> {
    if let Some(path) = config.mbtiles_files.get(&filename) {
        return serve_mbtiles_metadata(&filename, path, config.port).await;
    }

    Err(NotFound("Tile source not found".to_string()))
}

#[get("/files/<filename>")]
async fn files(filename: &str, config: &State<Config>) -> Result<SeekStream<'static>, NotFound> {
    if let Some(content) = config.files.get(filename) {
        let content = Arc::clone(content);
        let len = content.len() as u64;

        Ok(SeekStream::with_opts(
            std::io::Cursor::new(content),
            len,
            "application/octet-stream",
        ))
    } else if config.local_files.contains(filename) {
        SeekStream::from_path(filename).map_err(|e| NotFound(format!("Failed to read file: {}", e)))
    } else {
        Err(NotFound("File not found".to_string()))
    }
}

#[derive(Parser)]
#[command(version, about, author, styles = clap::builder::Styles::plain())]
#[command(
    after_help = "Supported formats: GeoJSON, TileJSON, StyleJSON, PMTiles, MBTiles, GeoTIFF, GPX, KML, Shapefile (.shp or .zip)"
)]
#[command(help_template = "{about}\n\n{all-args}{after-help}\n\nAuthor: {author}")]
pub struct CliArgs {
    /// Files to view (if none provided, reads from stdin)
    files: Vec<PathBuf>,

    /// Watch files for changes and reload browser automatically
    #[arg(long)]
    watch: bool,
}

fn is_url(input: &str) -> bool {
    input.starts_with("http://") || input.starts_with("https://")
}

impl TryFrom<CliArgs> for Config {
    type Error = anyhow::Error;

    fn try_from(args: CliArgs) -> anyhow::Result<Config> {
        let mut file_data = HashMap::new();
        let mut file_args = Vec::new();
        let mut local_files = HashSet::new();
        let mut mbtiles_files = HashMap::new();
        #[cfg(feature = "gdal")]
        let mut geotiff_files = HashSet::new();

        if args.files.is_empty() {
            let mut stdin_content = String::new();
            io::stdin().read_to_string(&mut stdin_content).context(
                "Failed to read from stdin (only JSON based formats can be piped; \
                 other file formats must be passed as file paths)",
            )?;

            let filename = "stdin.json".to_string();
            file_data.insert(filename.clone(), stdin_content.into_bytes().into());
            file_args.push(filename);
        } else {
            for file_path in &args.files {
                let path_str = file_path.to_string_lossy();

                if is_url(&path_str) {
                    // These formats are tiled server-side, which requires a local file
                    let lower = path_str.to_lowercase();
                    if lower.ends_with(".mbtiles") {
                        bail!("MBTiles files can only be viewed from local paths, not URLs");
                    }
                    if lower.ends_with(".tif") || lower.ends_with(".tiff") {
                        bail!("GeoTIFF files can only be viewed from local paths, not URLs");
                    }
                    file_args.push(path_str.to_string());
                } else {
                    let metadata = fs::metadata(file_path)
                        .with_context(|| format!("File not found: {}", path_str))?;

                    if !metadata.file_type().is_file() {
                        bail!("Expected {} to be a file, but found a directory", path_str);
                    }

                    // Local files are identified by their path exactly as passed on
                    // the command line, which is necessarily unique
                    let path = path_str.to_string();
                    let lower = path.to_lowercase();

                    local_files.insert(path.clone());
                    file_args.push(path.clone());

                    let is_geotiff = lower.ends_with(".tif") || lower.ends_with(".tiff");

                    // Track GeoTIFF files separately for tiling
                    #[cfg(feature = "gdal")]
                    if is_geotiff {
                        geotiff_files.insert(path.clone());
                    }

                    #[cfg(not(feature = "gdal"))]
                    if is_geotiff {
                        bail!(
                            "{}: this build of mapview does not support GeoTIFF \
                             (it was compiled without the 'gdal' feature)",
                            path
                        );
                    }

                    if lower.ends_with(".mbtiles") {
                        let pool = mbtiles::open_pool(&path)?;
                        mbtiles_files.insert(path.clone(), pool);
                    }

                    // Shapefiles keep attributes, projection, and encoding in sidecar files
                    if lower.ends_with(".shp") {
                        for ext in ["dbf", "prj", "cpg"] {
                            let sidecar = file_path.with_extension(ext);
                            if sidecar.exists() {
                                local_files.insert(sidecar.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }

        Ok(Config {
            files: file_data,
            file_args,
            local_files,
            mbtiles_files,
            port: 0, // set in main() after port selection
            #[cfg(feature = "gdal")]
            geotiff_files,
        })
    }
}

#[get("/ws")]
fn ws(
    ws: WebSocket,
    queue: &State<Sender<()>>,
    mut shutdown: rocket::Shutdown,
) -> Stream!['static] {
    let mut rx = queue.subscribe();
    Stream! { ws =>
        // The client never sends messages; just forward reload signals
        let _ = ws;
        loop {
            rocket::tokio::select! {
                result = rx.recv() => {
                    if result.is_err() {
                        break;
                    }
                    yield "reload".into();
                }
                _ = &mut shutdown => break,
            }
        }
    }
}

fn find_available_port(start_port: u16) -> anyhow::Result<u16> {
    for port in start_port..=65535 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    bail!("No available ports found between {} and 65535", start_port)
}

#[rocket::main]
async fn main() -> anyhow::Result<()> {
    let args = CliArgs::parse();
    let watch_mode = args.watch;
    let mut config = Config::try_from(args)?;

    let port = find_available_port(3857)?;
    config.port = port;

    let file_list = config.file_args.join(",");
    let watch_param = if watch_mode { "&watch=true" } else { "" };
    let url = format!(
        "http://localhost:{}/?args={}{}",
        port,
        urlencoding::encode(&file_list),
        watch_param
    );

    let figment = rocket::Config::figment()
        .merge(("port", port))
        .merge(("log_level", "off"))
        // Don't wait for active connections to drain before shutting down
        // (this makes Ctrl-C immediate instead of stalling for a couple seconds)
        .merge(("shutdown.grace", 0))
        .merge(("shutdown.mercy", 0));

    let (tx, _rx) = channel::<()>(16);

    #[cfg(feature = "gdal")]
    let tiler = tiler::Tiler::new(4);

    // Set up the file watcher if watch mode is enabled. notify runs the watch on its
    // own background thread, and keeps watching until the returned handle is dropped.
    let _watcher = if watch_mode {
        use notify::{RecursiveMode, Result, Watcher};

        let tx = tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event>| {
            if let Ok(event) = res
                && (event.kind.is_modify() || event.kind.is_create())
            {
                let _ = tx.send(());
            }
        })?;

        for path in &config.local_files {
            let _ = watcher.watch(Path::new(path), RecursiveMode::NonRecursive);
        }

        Some(watcher)
    } else {
        None
    };

    let rocket = rocket::build().configure(figment).manage(config).manage(tx);

    #[cfg(feature = "gdal")]
    let rocket = rocket.manage(tiler);

    let rocket = rocket.mount(
        "/",
        routes![
            index,
            files,
            css,
            bundle,
            bundle_map,
            maplibre_worker,
            tiles,
            tilejson,
            ws // the websocket route is always mounted; without --watch it just never sends anything
        ],
    );

    let rocket = rocket.ignite().await?;

    println!("Listening on {}", url);

    // Open browser only after server is ready to launch; if this fails the
    // printed URL still lets the user open it manually, so keep serving
    if let Err(e) = open::that(&url) {
        eprintln!("Failed to open browser: {}", e);
    }

    rocket.launch().await?;

    Ok(())
}

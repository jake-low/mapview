use gdal::spatial_ref::{CoordTransform, SpatialRef};
use gdal::{Dataset, DatasetOptions, DriverManager};
use image::{ImageBuffer, Rgba, RgbaImage};
use std::f64::consts::PI;
use std::ffi::CString;
use std::ptr::null_mut;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub const TILE_SIZE: u32 = 512;
const WEB_MERCATOR_MAX: f64 = 20037508.342789244;

pub struct GeoTIFFMetadata {
    pub name: String,
    pub bounds: [f64; 4],
    pub minzoom: u8,
    pub maxzoom: u8,
}

pub struct Tiler {
    semaphore: Arc<Semaphore>,
}

impl Tiler {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
        }
    }

    pub async fn generate_tile(
        &self,
        path: &str,
        z: u8,
        x: u32,
        y: u32,
    ) -> anyhow::Result<Vec<u8>> {
        let _permit = self.semaphore.acquire().await?;

        let path_owned = path.to_string();

        tokio::task::spawn_blocking(move || {
            let source_dataset = Dataset::open_ex(
                &path_owned,
                DatasetOptions {
                    open_flags: gdal::GdalOpenFlags::GDAL_OF_READONLY,
                    ..Default::default()
                },
            )?;

            let (tile_min_x, tile_max_x, tile_min_y, tile_max_y) =
                tile_bounds_to_web_mercator(z, x, y);

            // Create a destination dataset in EPSG:3857 with the tile's bounds
            let driver = DriverManager::get_driver_by_name("MEM")?;
            let mut warped_dataset = driver.create_with_band_type::<u8, _>(
                "",
                TILE_SIZE as usize,
                TILE_SIZE as usize,
                source_dataset.raster_count(),
            )?;

            let web_mercator = SpatialRef::from_epsg(3857)?;
            warped_dataset.set_spatial_ref(&web_mercator)?;

            // meters per pixel for this tile
            let pixel_width = (tile_max_x - tile_min_x) / TILE_SIZE as f64;
            let pixel_height = (tile_max_y - tile_min_y) / TILE_SIZE as f64;

            let geo_transform: gdal::GeoTransform = [
                tile_min_x,    // upper left x
                pixel_width,   // pixel width
                0.0,           // row rotation
                tile_max_y,    // upper left y
                0.0,           // column rotation
                -pixel_height, // pixel height (negative because y decreases)
            ];

            warped_dataset.set_geo_transform(&geo_transform)?;

            // Use GDAL's warp to reproject source into destination
            unsafe {
                let k1 = CString::new("-r").unwrap();
                let v1 = CString::new("bilinear").unwrap();
                let k2 = CString::new("-t_srs").unwrap();
                let v2 = CString::new("EPSG:3857").unwrap();
                let mut warp_args = [
                    k1.as_ptr() as *mut i8,
                    v1.as_ptr() as *mut i8,
                    k2.as_ptr() as *mut i8,
                    v2.as_ptr() as *mut i8,
                    null_mut(),
                ];
                let warp_options =
                    gdal_sys::GDALWarpAppOptionsNew(warp_args.as_mut_ptr(), null_mut());
                let result = gdal_sys::GDALWarp(
                    null_mut(),
                    warped_dataset.c_dataset(),
                    1,
                    &mut source_dataset.c_dataset() as *mut _,
                    warp_options,
                    null_mut(),
                );

                if result.is_null() {
                    return Ok(create_transparent_tile());
                }
            }

            // Read bands from warped dataset
            let band_count = warped_dataset.raster_count();
            let mut img: RgbaImage =
                ImageBuffer::from_pixel(TILE_SIZE, TILE_SIZE, Rgba([0, 0, 0, 255]));

            // Get nodata value from first band (assuming all bands have same nodata)
            let nodata_value = warped_dataset
                .rasterband(1)
                .ok()
                .and_then(|b| b.no_data_value());

            // Read all bands into separate buffers first
            let mut band_data: Vec<Vec<u8>> = Vec::new();
            for band_idx in 1..=band_count.min(4) {
                let band = warped_dataset.rasterband(band_idx)?;
                let buffer = band.read_as::<u8>(
                    (0, 0),
                    (TILE_SIZE as usize, TILE_SIZE as usize),
                    (TILE_SIZE as usize, TILE_SIZE as usize),
                    None,
                )?;
                band_data.push(buffer.data().to_vec());
            }

            // Process pixels
            for y_coord in 0..TILE_SIZE {
                for x_coord in 0..TILE_SIZE {
                    let idx = (y_coord * TILE_SIZE + x_coord) as usize;
                    let pixel = img.get_pixel_mut(x_coord, y_coord);

                    // Check if this pixel is nodata across all bands
                    let is_nodata = if let Some(nodata) = nodata_value {
                        // If nodata value is set, check if all bands match it
                        band_data
                            .iter()
                            .all(|data| (data[idx] as f64 - nodata).abs() < 0.01)
                    } else {
                        // If no nodata value, consider all-zero pixels as nodata
                        band_data.iter().all(|data| data[idx] == 0)
                    };

                    if band_count == 1 {
                        let val = band_data[0][idx];
                        *pixel = Rgba([val, val, val, if is_nodata { 0 } else { 255 }]);
                    } else {
                        pixel[0] = band_data[0][idx];
                        if band_count >= 2 {
                            pixel[1] = band_data[1][idx];
                        }
                        if band_count >= 3 {
                            pixel[2] = band_data[2][idx];
                        }
                        if band_count >= 4 {
                            pixel[3] = band_data[3][idx];
                        } else {
                            pixel[3] = if is_nodata { 0 } else { 255 };
                        }
                    }
                }
            }

            let mut png_data = Vec::new();
            img.write_to(
                &mut std::io::Cursor::new(&mut png_data),
                image::ImageFormat::Png,
            )?;

            Ok(png_data)
        })
        .await?
    }

    pub async fn get_metadata(&self, path: &str) -> anyhow::Result<GeoTIFFMetadata> {
        let path_owned = path.to_string();

        tokio::task::spawn_blocking(move || {
            let dataset = Dataset::open_ex(
                &path_owned,
                DatasetOptions {
                    open_flags: gdal::GdalOpenFlags::GDAL_OF_READONLY,
                    ..Default::default()
                },
            )?;

            let geo_transform = dataset.geo_transform()?;
            let size_x = dataset.raster_size().0 as f64;
            let size_y = dataset.raster_size().1 as f64;

            let min_x = geo_transform[0];
            let max_x = geo_transform[0] + geo_transform[1] * size_x;
            let max_y = geo_transform[3];
            let min_y = geo_transform[3] + geo_transform[5] * size_y;

            let source_srs_wkt = dataset.projection();
            let source_srs = SpatialRef::from_wkt(&source_srs_wkt)?;
            let wgs84 = SpatialRef::from_epsg(4326)?;

            let transform = CoordTransform::new(&source_srs, &wgs84)?;

            // Transform all four corners to get accurate bounds
            let mut x_coords = vec![min_x, max_x, min_x, max_x];
            let mut y_coords = vec![min_y, min_y, max_y, max_y];
            let mut z_coords = vec![0.0, 0.0, 0.0, 0.0];

            transform.transform_coords(&mut x_coords, &mut y_coords, &mut z_coords)?;

            // Some projections have axis order (lat, lon) instead of (lon, lat)
            // Check by seeing which values fall in latitude range (-90 to 90)
            let x_is_lat = x_coords.iter().all(|&v| (-90.0..=90.0).contains(&v));

            let (west, east, south, north) = if x_is_lat {
                // x contains latitude, y contains longitude - swap them
                let west = y_coords.iter().cloned().fold(f64::INFINITY, f64::min);
                let east = y_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let south = x_coords.iter().cloned().fold(f64::INFINITY, f64::min);
                let north = x_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                (west, east, south, north)
            } else {
                // x contains longitude, y contains latitude - normal order
                let west = x_coords.iter().cloned().fold(f64::INFINITY, f64::min);
                let east = x_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let south = y_coords.iter().cloned().fold(f64::INFINITY, f64::min);
                let north = y_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                (west, east, south, north)
            };

            let (minzoom, maxzoom) = compute_zoom_levels(&dataset)?;

            let name = std::path::Path::new(&path_owned)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("geotiff")
                .to_string();

            Ok(GeoTIFFMetadata {
                name,
                bounds: [west, south, east, north],
                minzoom,
                maxzoom,
            })
        })
        .await?
    }
}

fn tile_bounds_to_web_mercator(z: u8, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let n = 2_f64.powi(z as i32);
    let min_x = (x as f64 / n) * 2.0 * WEB_MERCATOR_MAX - WEB_MERCATOR_MAX;
    let max_x = ((x + 1) as f64 / n) * 2.0 * WEB_MERCATOR_MAX - WEB_MERCATOR_MAX;
    let max_y = WEB_MERCATOR_MAX - (y as f64 / n) * 2.0 * WEB_MERCATOR_MAX;
    let min_y = WEB_MERCATOR_MAX - ((y + 1) as f64 / n) * 2.0 * WEB_MERCATOR_MAX;

    (min_x, max_x, min_y, max_y)
}

fn compute_zoom_levels(dataset: &Dataset) -> anyhow::Result<(u8, u8)> {
    let geo_transform = dataset.geo_transform()?;
    let pixel_size = geo_transform[1].abs();

    let earth_circumference = 2.0 * PI * 6378137.0;

    let zoom_at_pixel_size =
        ((earth_circumference / (pixel_size * TILE_SIZE as f64)).log2()).floor() as u8;

    // Allow viewing from any zoom level, but suggest native resolution
    let minzoom = 0;
    let maxzoom = (zoom_at_pixel_size + 5).min(22);

    Ok((minzoom, maxzoom))
}

fn create_transparent_tile() -> Vec<u8> {
    let img: RgbaImage = ImageBuffer::from_pixel(TILE_SIZE, TILE_SIZE, Rgba([0, 0, 0, 0]));
    let mut png_data = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_data),
        image::ImageFormat::Png,
    )
    .unwrap();
    png_data
}

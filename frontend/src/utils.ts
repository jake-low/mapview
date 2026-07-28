import { gpx, kml } from "@tmcw/togeojson";
import * as turf from "@turf/turf";
import type { GeoJSON } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { PMTiles } from "pmtiles";
import * as shapefile from "shapefile";
import {
  type Bounds,
  type DataLayer,
  type FileInfo,
  type FileKind,
  type InitialView,
  type MapCamera,
  type PMTilesInfo,
  type StyleJSON,
  type TileJSON,
  VALID_GEOJSON_TYPES,
} from "./types.ts";

/*
 * How many decimal places should be shown for longitude and latitude values in the UI?
 * Based on the current zoom level and latitude of the map center (the further in you
 * zoom, the more significant figures are shown)
 */
export function getCoordinatePrecision(zoom: number, lat: number): number {
  // Meters per pixel at given zoom and latitude
  // Formula: (Earth circumference / 256) * cos(lat) / 2^zoom
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

  // Calculate the appropriate number of decimal places to represent
  // the above precision. 1 degree = ~111km at equator. We want precision
  // to be about one pixel worth of distance on screen.
  const degreesPerPixel = metersPerPixel / 111320;
  const decimalPlaces = Math.max(0, Math.ceil(-Math.log10(degreesPerPixel)));

  return Math.min(decimalPlaces, 8); // Cap at 8 decimal places
}

export async function copyFeaturesAsGeoJSON(features: MapGeoJSONFeature[]): Promise<void> {
  const featureCollection = {
    type: "FeatureCollection" as const,
    features: features.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: f.properties,
    })),
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(featureCollection, null, 2));
  } catch (err) {
    console.error("Failed to copy to clipboard:", err);
  }
}

export function detectJSONType(data: unknown): FileKind {
  const obj = data as Record<string, unknown>;
  if (obj.tilejson) {
    return "tilejson";
  }

  if (obj.type && typeof obj.type === "string" && VALID_GEOJSON_TYPES.includes(obj.type)) {
    return "geojson";
  }

  if (obj.version && obj.sources && obj.layers) {
    return "stylejson";
  }

  throw new Error("JSON did not match any known kind (GeoJSON, TileJSON, StyleJSON, etc)");
}

export function isUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

/**
 * Shorten file paths for display: use basenames if they're all unique,
 * otherwise fall back to the full paths (or URLs).
 */
export function shortenPaths(paths: string[]): string[] {
  if (paths.length === 0) return [];

  const basenames = paths.map((p) => {
    if (isUrl(p)) return getFilenameFromUrl(p);
    return p.split("/").filter(Boolean).pop() ?? p;
  });

  const counts = new Map<string, number>();
  for (const b of basenames) {
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  return paths.map((p, i) => ((counts.get(basenames[i]) ?? 0) > 1 ? p : basenames[i]));
}

export function getFilenameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
  } catch {
    return url;
  }
}

function getExtension(filename: string): string {
  const path = isUrl(filename) ? new URL(filename).pathname : filename;
  return path.toLowerCase().split(".").pop() ?? "";
}

export async function detectFileInfo(filename: string): Promise<FileInfo> {
  const extension = getExtension(filename);
  const title = isUrl(filename) ? getFilenameFromUrl(filename) : filename;
  // local paths may contain slashes, so they're encoded to form a single URL segment
  const url = isUrl(filename)
    ? filename
    : `${window.location.origin}/files/${encodeURIComponent(filename)}`;
  let data: unknown = null;
  let kind: FileKind;

  switch (extension) {
    case "json":
    case "geojson": {
      const res = await fetch(url);
      data = await res.json();
      kind = extension === "geojson" ? "geojson" : detectJSONType(data);
      break;
    }
    case "shp": {
      const base = filename.slice(0, -4);
      const baseUrl = isUrl(filename) ? base : `/files/${encodeURIComponent(base)}`;

      const shpRes = await fetch(`${baseUrl}.shp`);
      const shpBuffer = await shpRes.arrayBuffer();

      // Try to fetch .dbf file, but it's optional
      let dbfBuffer: ArrayBuffer | undefined;
      try {
        const dbfRes = await fetch(`${baseUrl}.dbf`);
        if (dbfRes.ok) {
          dbfBuffer = await dbfRes.arrayBuffer();
        }
      } catch {
        // .dbf file is optional, continue without it
      }

      data = await shapefile.read(shpBuffer, dbfBuffer);
      kind = "shapefile";
      break;
    }
    case "gpx":
    case "kml": {
      const res = await fetch(url);
      const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
      data = extension === "gpx" ? gpx(doc) : kml(doc);
      kind = "geojson";
      break;
    }
    case "pmtiles": {
      const pmtiles = new PMTiles(url);
      const [header, metadata] = await Promise.all([pmtiles.getHeader(), pmtiles.getMetadata()]);
      data = { header, metadata } as PMTilesInfo;
      kind = "pmtiles";
      break;
    }
    case "mbtiles":
      data = await fetchTileJSON(url);
      kind = "mbtiles";
      break;
    case "tif":
    case "tiff":
      data = await fetchTileJSON(url);
      kind = "geotiff";
      break;
    default: {
      // URLs don't always have a file extension (e.g. TileJSON API endpoints),
      // so fall back to fetching the content and sniffing it
      if (!isUrl(filename)) {
        throw new Error(`Unsupported file type: ${extension}`);
      }
      try {
        const res = await fetch(url);
        data = await res.json();
      } catch {
        throw new Error(`Could not determine file type of ${url}`);
      }
      kind = detectJSONType(data);
    }
  }

  return {
    kind,
    title,
    data,
    url,
    view: getFileView(kind, data),
    layers: getFileLayers(kind, data),
  };
}

/** MBTiles and GeoTIFF files are tiled server-side; the server exposes their TileJSON */
async function fetchTileJSON(url: string): Promise<TileJSON> {
  const response = await fetch(`${url}/metadata.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch tile metadata: ${response.status}`);
  }
  return response.json();
}

function isValidBounds(bounds: Bounds): boolean {
  const [west, south, east, north] = bounds;
  return (
    Number.isFinite(west) &&
    Number.isFinite(south) &&
    Number.isFinite(east) &&
    Number.isFinite(north) &&
    west <= east &&
    south <= north
  );
}

const LAYER_COLORS = [
  "#f4b8e4",
  "#babbf1",
  "#a6d189",
  "#85c1dc",
  "#81c8be",
  "#a6e3a1",
  "#cfc9c2",
  "#f38ba8",
  "#bb9af7",
  "#f2d5cf",
  "#9ece6a",
  "#f9e2af",
];

export function isRasterTiles(kind: FileKind, data: unknown): boolean {
  switch (kind) {
    case "pmtiles":
      return (data as PMTilesInfo).header.tileType !== 1; // 1 = MVT
    case "tilejson":
    case "mbtiles":
    case "geotiff": {
      const tileUrl = (data as TileJSON).tiles?.[0]?.toLowerCase() ?? "";
      return /\.(png|jpe?g|webp)(\?|$)/.test(tileUrl);
    }
    default:
      return false;
  }
}

function getFileLayers(kind: FileKind, data: unknown): DataLayer[] | undefined {
  if (isRasterTiles(kind, data)) return undefined;

  let names: string[] | undefined;
  switch (kind) {
    case "tilejson":
    case "mbtiles":
    case "geotiff":
      names = (data as TileJSON).vector_layers?.map((layer) => layer.id);
      break;
    case "pmtiles": {
      const { metadata } = data as PMTilesInfo;
      names =
        metadata.vector_layers?.map((layer) => layer.id) ??
        metadata.tilestats?.layers.map((layer) => layer.layer);
      break;
    }
  }

  if (!names?.length) return undefined;
  return names.map((name, i) => ({ name, color: LAYER_COLORS[i % LAYER_COLORS.length] }));
}

function getFileView(kind: FileKind, data: unknown): InitialView | undefined {
  switch (kind) {
    case "geojson":
    case "shapefile": {
      const bounds = turf.bbox(data as GeoJSON) as Bounds;
      return isValidBounds(bounds) ? bounds : undefined;
    }
    case "tilejson":
    case "mbtiles":
    case "geotiff": {
      const { bounds } = data as TileJSON;
      return bounds?.length === 4 && isValidBounds(bounds) ? bounds : undefined;
    }
    case "pmtiles": {
      const { header } = data as PMTilesInfo;
      const bounds: Bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
      return isValidBounds(bounds) ? bounds : undefined;
    }
    case "stylejson": {
      const { center, zoom, bearing, pitch } = data as StyleJSON;
      if (center === undefined && zoom === undefined) return undefined;
      return { center: center ?? [0, 0], zoom: zoom ?? 0, bearing, pitch };
    }
  }
}

/** The camera encoded in the URL hash (as written by maplibre's Hash control), if any */
export function parseHash(): MapCamera | null {
  const hash = window.location.hash.replace("#", "");
  if (!hash) return null;

  const [zoom, lat, lon, bearing, pitch] = hash.split("/").map(Number);
  if (Number.isNaN(zoom) || Number.isNaN(lon) || Number.isNaN(lat)) return null;

  return { center: [lon, lat], zoom, bearing: bearing ?? 0, pitch: pitch ?? 0 };
}

/**
 * The view that every map should start at: the union of the bounds suggested by the
 * files being viewed, or if none of them suggest bounds, the first camera suggested.
 */
export function getInitialView(fileInfos: FileInfo[]): InitialView | undefined {
  let union: Bounds | undefined;
  for (const { view } of fileInfos) {
    if (view && Array.isArray(view)) {
      const [west, south, east, north] = view;
      union = union
        ? [
            Math.min(union[0], west),
            Math.min(union[1], south),
            Math.max(union[2], east),
            Math.max(union[3], north),
          ]
        : [west, south, east, north];
    }
  }

  return union ?? fileInfos.find((info) => info.view)?.view;
}

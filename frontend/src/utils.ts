import { gpx, kml } from "@tmcw/togeojson";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, GeoJSON } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { PMTiles } from "pmtiles";
import proj4 from "proj4";
import shp from "shpjs";
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

export const INDEX_KEY = "__mapview_idx";
const ORIGINAL_ID_KEY = "__mapview_id";

/**
 * Return a copy of `geojson` as a FeatureCollection in which every feature has a unique
 * numeric key property (named $INDEX_KEY). This is so we can use it as the `promoteId`
 * in MapLibre. This ensures that the features in a GeoJSON file can be hovered/clicked
 * on even if the original file had no feature IDs.
 *
 * If the features already had IDs, we store them in $ORIGINAL_INDEX_KEY so they can
 * be recovered later (see unindexFeature() below)
 */
export function indexGeoJSON(geojson: GeoJSON): FeatureCollection {
  const features: Feature[] =
    geojson.type === "FeatureCollection"
      ? geojson.features
      : geojson.type === "Feature"
        ? [geojson]
        : [{ type: "Feature", geometry: geojson, properties: {} }];

  return {
    type: "FeatureCollection",
    features: features.map(({ id, ...f }, i) => ({
      ...f,
      properties: {
        ...f.properties,
        [INDEX_KEY]: i,
        ...(id !== undefined && { [ORIGINAL_ID_KEY]: id }),
      },
    })),
  };
}

/**
 * Get a rendered feature's original ID and properties, undoing indexGeoJSON().
 * Features from sources that weren't indexed are returned unchanged.
 */
export function unindexFeature(feature: MapGeoJSONFeature): {
  id: string | number | undefined;
  properties: Record<string, unknown>;
} {
  const props = feature.properties ?? {};
  if (!(INDEX_KEY in props)) return { id: feature.id, properties: props };
  const { [INDEX_KEY]: _, [ORIGINAL_ID_KEY]: id, ...properties } = props;
  return { id: id as string | number | undefined, properties };
}

export async function copyFeaturesAsGeoJSON(features: MapGeoJSONFeature[]): Promise<void> {
  const featureCollection = {
    type: "FeatureCollection" as const,
    features: features.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: unindexFeature(f).properties,
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
      const base = url.slice(0, -4);
      const [shpBuffer, dbf, prj, cpg] = await Promise.all([
        fetch(url).then((res) => res.arrayBuffer()),
        fetchSidecar(`${base}.dbf`).then((res) => res?.arrayBuffer()),
        fetchSidecar(`${base}.prj`).then((res) => res?.text()),
        fetchSidecar(`${base}.cpg`).then((res) => res?.text()),
      ]);

      if (prj) {
        // shpjs suppresses errors from proj4, so it silently ignores an unknown
        // projection and leaves coordinates unprojected (which usually results
        // in a broken map). to avoid confusing the user, we'll call proj4 on
        // the prj ourselves and throw a user-facing error if it throws.
        try {
          proj4(prj);
        } catch {
          throw new Error(`Unsupported projection in ${base}.prj: ${prj}`);
        }
      }

      data = await shp({ shp: shpBuffer, dbf, prj, cpg });
      kind = "shapefile";
      break;
    }
    case "zip": {
      const res = await fetch(url);
      const result = await shp(await res.arrayBuffer());
      // zips holding several shapefiles return an array of FeatureCollections
      // (one per file); we stitch them into one for display.
      data = Array.isArray(result)
        ? { type: "FeatureCollection", features: result.flatMap((fc) => fc.features) }
        : result;
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

/**
 * Fetch an optional shapefile sidecar file (.dbf, .prj, etc), returning undefined
 * if it's missing.
 */
async function fetchSidecar(url: string): Promise<Response | undefined> {
  try {
    const res = await fetch(url);
    return res.ok ? res : undefined;
  } catch {
    return undefined;
  }
}

/** MBTiles and GeoTIFF files are tiled server-side; the server exposes their TileJSON */
async function fetchTileJSON(url: string): Promise<TileJSON> {
  const res = await fetch(`${url}/metadata.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tile metadata: ${res.status}`);
  }
  return res.json();
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

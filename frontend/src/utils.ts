import { type FileInfo, type FileKind, VALID_GEOJSON_TYPES } from "./types.ts";

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
    case "pmtiles":
      kind = "pmtiles";
      break;
    case "mbtiles":
      kind = "mbtiles";
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

  return { kind, title, data, url };
}

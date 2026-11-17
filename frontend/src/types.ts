export const VALID_GEOJSON_TYPES: string[] = [
  "Feature",
  "FeatureCollection",
  "Point",
  "LineString",
  "Polygon",
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "GeometryCollection",
];

export type FileKind =
  | "geojson"
  | "tilejson"
  | "stylejson"
  | "pmtiles"
  | "mbtiles"
  | "geotiff"
  | "shapefile";

export type Bounds = [number, number, number, number];

export type FileInfo = {
  kind: FileKind;
  title: string;
  data: unknown;
  url: string;
  view?: InitialView;
  layers?: DataLayer[];
};

export type FileError = {
  title: string;
  error: string;
};

export type FileEntry = FileInfo | FileError;

export type TileJSON = {
  tilejson: string;
  tiles: Array<string>;
  attribution?: string;
  vector_layers?: Array<{ id: string }>;
  bounds?: Bounds;
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number; // not part of TileJSON spec but added by several implementations
};

export type PMTilesMetadata = {
  format?: string;
  attribution?: string;
  vector_layers?: Array<{ id: string }>;
  tilestats?: {
    layers: Array<{ layer: string }>;
  };
  tileSize?: number;
};

export type PMTilesInfo = {
  header: import("pmtiles").Header;
  metadata: PMTilesMetadata;
};

export type StyleJSON = {
  version: number;
  sources: Record<string, unknown>;
  layers: Array<unknown>;
  glyphs?: string;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
};

export type ViewMode = "single" | "swipe" | "tile";

export type URLState = {
  mode: ViewMode;
  selectedIndices: number[];
  showTileBoundaries: boolean;
  showCollisionBoxes: boolean;
  enableRotation: boolean;
  enablePitch: boolean;
  enableGlobe: boolean;
  fullscreen: boolean;
};

export type MapCamera = {
  zoom: number;
  center: [number, number];
  bearing?: number;
  pitch?: number;
};

export type MapState = {
  camera?: MapCamera;
  bounds?: Bounds;
};

export type InitialView = MapCamera | Bounds;

export type AppState = URLState & MapState;

export type DataLayer = {
  name: string;
  color: string;
};

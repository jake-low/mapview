import * as turf from "@turf/turf";
import type { GeoJSON } from "geojson";
import maplibre, { type ExpressionSpecification, type Map as MaplibreMap } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { setupFeatureHighlighting, setupHoverPopup } from "./popups.tsx";
import type {
  FileInfo,
  LayerGroup,
  MapInitResult,
  PMTilesMetadata,
  StyleJSON,
  TileJSON,
} from "./types.ts";

const TEXT_FONT = ["Noto Sans"];
const TEXT_HALO_COLOR = "#000b16";
const TEXT_HALO_WIDTH = 1;
const TEXT_HALO_BLUR = 0;
const TEXT_SIZE_POINT = 9;
const TEXT_SIZE_LINE = 8;
const TEXT_SIZE_POLYGON = 10;

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

type MapSettings = {
  enableRotation?: boolean;
  enablePitch?: boolean;
};

function hoverable(hovered: number, normal: number): ExpressionSpecification {
  return ["case", ["boolean", ["feature-state", "hover"], false], hovered, normal];
}

function labelPaint(color: string) {
  return {
    "text-color": color,
    "text-halo-color": TEXT_HALO_COLOR,
    "text-halo-width": TEXT_HALO_WIDTH,
    "text-halo-blur": TEXT_HALO_BLUR,
  };
}

export function parseHash(): {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
} | null {
  const hash = window.location.hash.replace("#", "");
  if (!hash) return null;

  const [zoom, lat, lon, bearing, pitch] = hash.split("/").map(Number);
  if (Number.isNaN(zoom) || Number.isNaN(lon) || Number.isNaN(lat)) return null;

  return { center: [lon, lat], zoom, bearing: bearing ?? 0, pitch: pitch ?? 0 };
}

export function hasHashInUrl(): boolean {
  return window.location.hash?.length > 1;
}

export function initializeMap(
  container: HTMLElement,
  options: Record<string, unknown>,
  settings?: MapSettings,
): MaplibreMap {
  const hashPos = parseHash();
  const mapOptions: Record<string, unknown> = { container, ...options };
  if (hashPos) {
    mapOptions.center = hashPos.center;
    mapOptions.zoom = hashPos.zoom;
    mapOptions.bearing = hashPos.bearing;
    mapOptions.pitch = hashPos.pitch;
  }

  const map = new maplibre.Map(mapOptions as any);

  if (!settings?.enablePitch) {
    map.setMaxPitch(0);
  }

  if (!settings?.enableRotation) {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
  }

  return map;
}

function setupMapInteractions(
  map: MaplibreMap,
  options?: {
    showLayers?: boolean;
    layers?: string[];
    layerColors?: Map<string, string>;
    enableHighlighting?: boolean;
  },
): void {
  setupHoverPopup(map, options || {});
  if (options?.enableHighlighting && options.layers) {
    setupFeatureHighlighting(map, { layers: options.layers });
  }
}

const VECTOR_LAYER_SUFFIXES = [
  "polygons",
  "lines",
  "points",
  "point_labels",
  "line_labels",
  "polygon_labels",
];

export function createVectorLayers(
  map: MaplibreMap,
  sourceName: string,
  layerNames: string[],
): { layerIds: string[]; layerColors: Map<string, string>; legend: LayerGroup[] } {
  const layerColors = new Map<string, string>(
    layerNames.map((name, i) => [name, LAYER_COLORS[i % LAYER_COLORS.length]]),
  );

  // Layers are added in passes (all polygons, then all lines, etc) so that
  // lines draw above polygons, points above lines, and labels above everything.
  for (const layerName of layerNames) {
    const color = layerColors.get(layerName)!;
    map.addLayer({
      id: `${layerName}_polygons`,
      type: "fill",
      source: sourceName,
      "source-layer": layerName,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": color,
        "fill-opacity": hoverable(0.3, 0.15),
        "fill-outline-color": color,
      },
    });
  }

  for (const layerName of layerNames) {
    const color = layerColors.get(layerName)!;
    map.addLayer({
      id: `${layerName}_lines`,
      type: "line",
      source: sourceName,
      "source-layer": layerName,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": color,
        "line-width": hoverable(2, 0.5),
      },
    });
  }

  for (const layerName of layerNames) {
    const color = layerColors.get(layerName)!;
    map.addLayer({
      id: `${layerName}_points`,
      type: "circle",
      source: sourceName,
      "source-layer": layerName,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 2,
        "circle-opacity": 0.8,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": hoverable(2, 0),
      },
    });
  }

  for (const layerName of layerNames) {
    const color = layerColors.get(layerName)!;
    map.addLayer({
      id: `${layerName}_point_labels`,
      type: "symbol",
      source: sourceName,
      "source-layer": layerName,
      filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "name"]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT_FONT,
        "text-size": TEXT_SIZE_POINT,
        "text-offset": [0, -0.5],
        "text-anchor": "bottom",
      },
      paint: labelPaint(color),
    });

    map.addLayer({
      id: `${layerName}_line_labels`,
      type: "symbol",
      source: sourceName,
      "source-layer": layerName,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["has", "name"]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT_FONT,
        "text-size": TEXT_SIZE_LINE,
        "symbol-placement": "line",
        "text-rotation-alignment": "map",
      },
      paint: labelPaint(color),
    });

    map.addLayer({
      id: `${layerName}_polygon_labels`,
      type: "symbol",
      source: sourceName,
      "source-layer": layerName,
      filter: ["all", ["==", ["geometry-type"], "Polygon"], ["has", "name"]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT_FONT,
        "text-size": TEXT_SIZE_POLYGON,
        "text-max-angle": 85,
        "text-offset": [0, 1],
        "text-rotation-alignment": "map",
        "text-keep-upright": true,
        "symbol-placement": "line",
        "symbol-spacing": 250,
      },
      paint: labelPaint(color),
    });
  }

  const legend = layerNames.map((name) => ({
    name,
    layerIds: VECTOR_LAYER_SUFFIXES.map((suffix) => `${name}_${suffix}`),
    color: layerColors.get(name)!,
  }));

  return {
    layerIds: legend.flatMap((group) => group.layerIds),
    layerColors,
    legend,
  };
}

export async function initializeStyleMap(
  container: HTMLElement,
  stylejson: StyleJSON,
  settings?: MapSettings,
): Promise<MapInitResult> {
  const map = initializeMap(
    container,
    {
      style: stylejson,
      maxZoom: 20,
    },
    settings,
  );

  return new Promise((resolve) => {
    map.on("load", () => {
      setupMapInteractions(map, { showLayers: true });
      resolve({ map });
    });
  });
}

export async function initializeGeoJSONMap(
  container: HTMLElement,
  geojson: GeoJSON,
  settings?: MapSettings,
): Promise<MapInitResult> {
  const map = initializeMap(
    container,
    {
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
          },
        ],
      },
    },
    settings,
  );

  if (!hasHashInUrl()) {
    const [west, south, east, north] = turf.bbox(geojson);
    // TODO: make sure that bbox is valid (between -180 and 180, -90 and 90)
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: 20,
        animate: false,
      },
    );
  }

  return new Promise((resolve) => {
    map.on("load", () => {
      map.addSource("geojson-data", {
        type: "geojson",
        data: geojson,
        // assign ids to features that lack them; hover highlighting tracks
        // features through feature-state, which requires ids
        generateId: true,
      });

      map.addLayer({
        id: "geojson-fill",
        type: "fill",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": "#088",
          "fill-opacity": hoverable(0.6, 0.4),
        },
      });

      map.addLayer({
        id: "geojson-line",
        type: "line",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#088",
          "line-width": hoverable(4, 2),
        },
      });

      map.addLayer({
        id: "geojson-point",
        type: "circle",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": "#088",
          "circle-radius": 6,
          "circle-opacity": 1,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": hoverable(3, 2),
        },
      });

      const layers = ["geojson-fill", "geojson-line", "geojson-point"];
      setupMapInteractions(map, { layers, enableHighlighting: true });
      resolve({ map });
    });
  });
}

type TileMapConfig = {
  isRaster: boolean;
  source: Record<string, unknown>;
  layerNames: string[];
  bounds?: [number, number, number, number];
};

function initializeTileMap(
  container: HTMLElement,
  config: TileMapConfig,
  settings?: MapSettings,
): Promise<MapInitResult> {
  const style: Record<string, unknown> = {
    version: 8,
    sources: {
      tiles: config.source,
    },
    layers: config.isRaster
      ? [
          {
            id: "raster",
            type: "raster",
            source: "tiles",
          },
        ]
      : [
          {
            id: "background",
            type: "background",
            paint: {
              "background-color": "#000b16",
            },
          },
        ],
  };

  if (!config.isRaster) {
    style.glyphs = "/fonts/{fontstack}/{range}.pbf";
  }

  const map = initializeMap(container, { style }, settings);

  return new Promise((resolve) => {
    map.on("load", () => {
      let legendData: LayerGroup[] | undefined;

      if (config.isRaster) {
        setupMapInteractions(map);
      } else {
        const { layerIds, layerColors, legend } = createVectorLayers(
          map,
          "tiles",
          config.layerNames,
        );
        setupMapInteractions(map, { layers: layerIds, layerColors, enableHighlighting: true });
        legendData = legend;
      }

      if (!hasHashInUrl() && config.bounds) {
        const [west, south, east, north] = config.bounds;
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          {
            padding: 20,
            animate: false,
          },
        );
      }

      resolve({ map, legendData });
    });
  });
}

export async function initializeTileJSONMap(
  container: HTMLElement,
  tilejson: TileJSON,
  settings?: MapSettings,
): Promise<MapInitResult> {
  // Detect raster TileJSON by checking tile URL extensions
  const tileUrl = tilejson.tiles?.[0]?.toLowerCase() ?? "";
  const isRaster = /\.(png|jpe?g|webp)(\?|$)/.test(tileUrl);

  const source: Record<string, unknown> = {
    type: isRaster ? "raster" : "vector",
    tiles: tilejson.tiles,
    minzoom: tilejson.minzoom,
    maxzoom: tilejson.maxzoom,
  };
  if (tilejson.attribution) {
    source.attribution = tilejson.attribution;
  }
  if (isRaster) {
    source.tileSize = tilejson.tileSize ?? 512;
  }

  return initializeTileMap(
    container,
    {
      isRaster,
      source,
      layerNames: tilejson.vector_layers?.map((layer) => layer.id) ?? [],
      bounds: tilejson.bounds?.length === 4 ? tilejson.bounds : undefined,
    },
    settings,
  );
}

export async function initializePMTilesMap(
  container: HTMLElement,
  url: string,
  settings?: MapSettings,
): Promise<MapInitResult> {
  const protocol = new Protocol();
  maplibre.addProtocol("pmtiles", protocol.tile);

  const pmtiles = new PMTiles(url);
  const header = await pmtiles.getHeader();
  const metadata = (await pmtiles.getMetadata()) as PMTilesMetadata;
  const isRaster = header.tileType !== 1; // 1 = MVT

  let layerNames: string[] = [];
  if (!isRaster) {
    if (metadata.vector_layers) {
      layerNames = metadata.vector_layers.map((layer) => layer.id);
    } else if (metadata.tilestats?.layers) {
      layerNames = metadata.tilestats.layers.map((layer) => layer.layer);
    }
  }

  const source: Record<string, unknown> = {
    type: isRaster ? "raster" : "vector",
    url: `pmtiles://${url}`,
  };
  if (metadata.attribution) {
    source.attribution = metadata.attribution;
  }
  if (isRaster) {
    source.tileSize = metadata.tileSize ?? 512;
  }

  return initializeTileMap(
    container,
    {
      isRaster,
      source,
      layerNames,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    },
    settings,
  );
}

/** MBTiles files are tiled server-side; the server exposes their TileJSON */
async function fetchTileJSON(url: string): Promise<TileJSON> {
  const response = await fetch(`${url}/metadata.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch tile metadata: ${response.status}`);
  }
  return response.json();
}

export async function initializeMBTilesMap(
  container: HTMLElement,
  url: string,
  settings?: MapSettings,
): Promise<MapInitResult> {
  return initializeTileJSONMap(container, await fetchTileJSON(url), settings);
}

export async function initializeMapFromFileInfo(
  container: HTMLElement,
  fileInfo: FileInfo,
  settings?: MapSettings,
): Promise<MapInitResult> {
  switch (fileInfo.kind) {
    case "stylejson":
      return initializeStyleMap(container, fileInfo.data as StyleJSON, settings);
    case "geojson":
      return initializeGeoJSONMap(container, fileInfo.data as GeoJSON, settings);
    case "tilejson":
      return initializeTileJSONMap(container, fileInfo.data as TileJSON, settings);
    case "pmtiles":
      return initializePMTilesMap(container, fileInfo.url, settings);
    case "mbtiles":
      return initializeMBTilesMap(container, fileInfo.url, settings);
  }
}

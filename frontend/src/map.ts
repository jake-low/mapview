import type { GeoJSON } from "geojson";
import maplibre, { type ExpressionSpecification, type Map as MaplibreMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { basemaps, setupBasemapSwitcher } from "./basemap.ts";
import { setupContextMenu } from "./contextmenu.ts";
import { setupMeasurementTool } from "./measurement.ts";
import { setupFeatureHighlighting, setupHoverPopup } from "./popups.tsx";
import { registerSearchableMap } from "./search.ts";
import { setupStatsWidget } from "./stats.ts";
import type {
  FileInfo,
  LayerGroup,
  MapInitResult,
  PMTilesInfo,
  StyleJSON,
  TileJSON,
} from "./types.ts";
import { copyFeaturesAsGeoJSON } from "./utils.ts";

// load RTL text support for Arabic, Hebrew, etc.
maplibre.setRTLTextPlugin("/mapbox-gl-rtl-text.js", true);

// register the pmtiles:// protocol once for all PMTiles sources
maplibre.addProtocol("pmtiles", new Protocol().tile);

const TEXT_FONT = ["Noto Sans"];
const TEXT_HALO_COLOR = "#000b16";
const TEXT_HALO_WIDTH = 1;
const TEXT_HALO_BLUR = 0;
const TEXT_SIZE_POINT = 9;
const TEXT_SIZE_LINE = 8;
const TEXT_SIZE_POLYGON = 10;

const DIMMED_FILL_COLOR = "#323b44";
const DIMMED_LINE_COLOR = "#19232d";
const DIMMED_CIRCLE_COLOR = "#19232d";
const DIMMED_TEXT_COLOR = "#323b44";

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

function dimmable(color: string, dimmedColor: string): ExpressionSpecification {
  return [
    "case",
    ["all", ["global-state", "searchActive"], ["!=", ["feature-state", "match"], true]],
    dimmedColor,
    color,
  ];
}

function hoverable(hovered: number, normal: number): ExpressionSpecification {
  return [
    "case",
    [
      "all",
      ["boolean", ["feature-state", "hover"], false],
      ["any", ["!", ["global-state", "searchActive"]], ["==", ["feature-state", "match"], true]],
    ],
    hovered,
    normal,
  ];
}

function labelPaint(color: string) {
  return {
    "text-color": dimmable(color, DIMMED_TEXT_COLOR),
    "text-halo-color": TEXT_HALO_COLOR,
    "text-halo-width": TEXT_HALO_WIDTH,
    "text-halo-blur": TEXT_HALO_BLUR,
  };
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
  const { setEnabled: setPopupEnabled } = setupHoverPopup(map, options || {});
  const highlightingControl =
    options?.enableHighlighting && options.layers
      ? setupFeatureHighlighting(map, { layers: options.layers })
      : null;

  const measurementTool = setupMeasurementTool(map, {
    setPopupEnabled,
    setHighlightEnabled: highlightingControl?.setEnabled,
  });
  setupContextMenu(map, {
    setPopupEnabled,
    onMeasureDistance: () => measurementTool.toggle(),
    onCopyGeoJSON: copyFeaturesAsGeoJSON,
  });
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
        "fill-color": dimmable(color, DIMMED_FILL_COLOR),
        "fill-opacity": hoverable(0.3, 0.15),
        "fill-outline-color": dimmable(color, DIMMED_FILL_COLOR),
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
        "line-color": dimmable(color, DIMMED_LINE_COLOR),
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
        "circle-color": dimmable(color, DIMMED_CIRCLE_COLOR),
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
): Promise<MapInitResult> {
  const map = new maplibre.Map({ container, style: stylejson as any, maxZoom: 20 });

  return new Promise((resolve) => {
    map.on("load", () => {
      map.setGlobalStateProperty("searchActive", false);
      setupMapInteractions(map, { showLayers: true });
      resolve({ map });
    });
  });
}

export async function initializeGeoJSONMap(
  container: HTMLElement,
  geojson: GeoJSON,
): Promise<MapInitResult> {
  const sources: Record<string, any> = {};
  const layers: any[] = [];

  for (const basemap of basemaps) {
    sources[basemap.id] = {
      type: "raster",
      tiles: basemap.tiles,
      tileSize: 256,
      attribution: basemap.attribution,
    };
    layers.push({
      id: basemap.id,
      type: "raster",
      source: basemap.id,
      layout: {
        visibility: basemap.id === "osm-carto" ? "visible" : "none",
      },
    });
  }

  const map = new maplibre.Map({
    container,
    style: {
      version: 8,
      sources,
      layers,
    },
  });

  return new Promise((resolve) => {
    map.on("load", () => {
      map.setGlobalStateProperty("searchActive", false);
      map.addSource("geojson-data", {
        type: "geojson",
        data: geojson,
      });

      map.addLayer({
        id: "geojson-fill",
        type: "fill",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": dimmable("#088", DIMMED_FILL_COLOR),
          "fill-opacity": hoverable(0.6, 0.4),
        },
      });

      map.addLayer({
        id: "geojson-line",
        type: "line",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": dimmable("#088", DIMMED_LINE_COLOR),
          "line-width": hoverable(4, 2),
        },
      });

      map.addLayer({
        id: "geojson-point",
        type: "circle",
        source: "geojson-data",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": dimmable("#088", DIMMED_CIRCLE_COLOR),
          "circle-radius": 6,
          "circle-opacity": 1,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": hoverable(3, 2),
        },
      });

      const layers = ["geojson-fill", "geojson-line", "geojson-point"];
      setupMapInteractions(map, { layers, enableHighlighting: true });
      registerSearchableMap(map, layers);
      setupBasemapSwitcher(map, container);
      setupStatsWidget(container, geojson);
      resolve({ map });
    });
  });
}

type TileMapConfig = {
  isRaster: boolean;
  source: Record<string, unknown>;
  layerNames: string[];
};

function initializeTileMap(container: HTMLElement, config: TileMapConfig): Promise<MapInitResult> {
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

  const map = new maplibre.Map({ container, style: style as any });

  return new Promise((resolve) => {
    map.on("load", () => {
      map.setGlobalStateProperty("searchActive", false);
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
        registerSearchableMap(map, layerIds);
        legendData = legend;
      }

      resolve({ map, legendData });
    });
  });
}

export async function initializeTileJSONMap(
  container: HTMLElement,
  tilejson: TileJSON,
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

  return initializeTileMap(container, {
    isRaster,
    source,
    layerNames: tilejson.vector_layers?.map((layer) => layer.id) ?? [],
  });
}

export async function initializePMTilesMap(
  container: HTMLElement,
  url: string,
  info: PMTilesInfo,
): Promise<MapInitResult> {
  const { header, metadata } = info;
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

  return initializeTileMap(container, { isRaster, source, layerNames });
}

export async function initializeMapFromFileInfo(
  container: HTMLElement,
  fileInfo: FileInfo,
): Promise<MapInitResult> {
  switch (fileInfo.kind) {
    case "stylejson":
      return initializeStyleMap(container, fileInfo.data as StyleJSON);
    case "geojson":
    case "shapefile":
      return initializeGeoJSONMap(container, fileInfo.data as GeoJSON);
    // MBTiles and GeoTIFF files are tiled server-side, which exposes their TileJSON
    case "tilejson":
    case "mbtiles":
    case "geotiff":
      return initializeTileJSONMap(container, fileInfo.data as TileJSON);
    case "pmtiles":
      return initializePMTilesMap(container, fileInfo.url, fileInfo.data as PMTilesInfo);
  }
}

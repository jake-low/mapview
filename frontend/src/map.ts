import type { GeoJSON } from "geojson";
import * as maplibre from "maplibre-gl";
import type { ExpressionSpecification, Map as MaplibreMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { basemaps, setupBasemapSwitcher } from "./basemap.ts";
import { setupContextMenu } from "./contextmenu.ts";
import { setupMeasurementTool } from "./measurement.ts";
import { setupFeatureHighlighting, setupHoverPopup } from "./popups.tsx";
import { registerSearchableMap } from "./search.ts";
import { setupStatsWidget } from "./stats.ts";
import type { DataLayer, FileInfo, PMTilesInfo, StyleJSON, TileJSON } from "./types.ts";
import { copyFeaturesAsGeoJSON, INDEX_KEY, indexGeoJSON, isRasterTiles } from "./utils.ts";

// set maplibre's worker URL explicitly because the way we're invoking esbuild
// seems to prevent the correct URL from being discovered automatically.
maplibre.setWorkerUrl("/maplibre-gl-worker.js");

// register the pmtiles:// protocol once for all PMTiles sources
maplibre.addProtocol("pmtiles", new Protocol().tile);

// we're not using a glyphs URL in wireframe stylesheets, so maplibre treats
// the font list below as a CSS font-family list.
const TEXT_FONT = ["sans-serif"];
const TEXT_SIZE = 10;
const TEXT_HALO_COLOR = "#000b16";
const TEXT_HALO_WIDTH = 1;
const TEXT_HALO_BLUR = 0;

const DIMMED_FILL_COLOR = "#323b44";
const DIMMED_LINE_COLOR = "#19232d";
const DIMMED_CIRCLE_COLOR = "#19232d";
const DIMMED_TEXT_COLOR = "#323b44";

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

/** The ids of the map layers drawn for one of a file's data layers */
function mapLayerIds(name: string): string[] {
  return VECTOR_LAYER_SUFFIXES.map((suffix) => `${name}_${suffix}`);
}

/** Show or hide every map layer drawn for one of a file's data layers */
export function setDataLayerVisibility(map: MaplibreMap, name: string, visible: boolean): void {
  for (const layerId of mapLayerIds(name)) {
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  }
}

function addVectorLayers(map: MaplibreMap, sourceName: string, layers: DataLayer[]): void {
  // Layers are added in passes (all polygons, then all lines, etc) so that
  // lines draw above polygons, points above lines, and labels above everything.
  for (const { name: layerName, color } of layers) {
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

  for (const { name: layerName, color } of layers) {
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

  for (const { name: layerName, color } of layers) {
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

  for (const { name: layerName, color } of layers) {
    map.addLayer({
      id: `${layerName}_point_labels`,
      type: "symbol",
      source: sourceName,
      "source-layer": layerName,
      filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "name"]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT_FONT,
        "text-size": TEXT_SIZE,
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
        "text-size": TEXT_SIZE,
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
        "text-size": TEXT_SIZE,
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
}

export function initializeStyleMap(container: HTMLElement, stylejson: StyleJSON): MaplibreMap {
  const map = new maplibre.Map({ container, style: stylejson as any, maxZoom: 20 });

  map.on("load", () => {
    map.setGlobalStateProperty("searchActive", false);
    setupMapInteractions(map, { showLayers: true });
  });

  return map;
}

export function initializeGeoJSONMap(container: HTMLElement, geojson: GeoJSON): MaplibreMap {
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
    maxZoom: 20,
  });

  map.on("load", () => {
    map.setGlobalStateProperty("searchActive", false);
    map.addSource("geojson-data", {
      type: "geojson",
      data: indexGeoJSON(geojson),
      promoteId: INDEX_KEY,
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
  });

  return map;
}

type TileMapConfig = {
  isRaster: boolean;
  source: Record<string, unknown>;
  layers?: DataLayer[];
};

function initializeTileMap(container: HTMLElement, config: TileMapConfig): MaplibreMap {
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

  const map = new maplibre.Map({ container, style: style as any, maxZoom: 20 });

  map.on("load", () => {
    map.setGlobalStateProperty("searchActive", false);

    const { layers } = config;
    if (!layers) {
      setupMapInteractions(map);
      return;
    }

    addVectorLayers(map, "tiles", layers);

    const layerIds = layers.flatMap(({ name }) => mapLayerIds(name));
    const layerColors = new Map(layers.map(({ name, color }) => [name, color]));
    setupMapInteractions(map, { layers: layerIds, layerColors, enableHighlighting: true });
    registerSearchableMap(map, layerIds);
  });

  return map;
}

function initializeTileJSONMap(container: HTMLElement, fileInfo: FileInfo): MaplibreMap {
  const tilejson = fileInfo.data as TileJSON;
  const isRaster = isRasterTiles(fileInfo.kind, tilejson);

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

  return initializeTileMap(container, { isRaster, source, layers: fileInfo.layers });
}

function initializePMTilesMap(container: HTMLElement, fileInfo: FileInfo): MaplibreMap {
  const { metadata } = fileInfo.data as PMTilesInfo;
  const isRaster = isRasterTiles(fileInfo.kind, fileInfo.data);

  const source: Record<string, unknown> = {
    type: isRaster ? "raster" : "vector",
    url: `pmtiles://${fileInfo.url}`,
  };
  if (metadata.attribution) {
    source.attribution = metadata.attribution;
  }
  if (isRaster) {
    source.tileSize = metadata.tileSize ?? 512;
  }

  return initializeTileMap(container, { isRaster, source, layers: fileInfo.layers });
}

export function initializeMapFromFileInfo(container: HTMLElement, fileInfo: FileInfo): MaplibreMap {
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
      return initializeTileJSONMap(container, fileInfo);
    case "pmtiles":
      return initializePMTilesMap(container, fileInfo);
  }
}

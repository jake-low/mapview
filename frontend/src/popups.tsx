import { type Element, Fragment } from "@b9g/crank";
import { renderer } from "@b9g/crank/html";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { type Map as MaplibreMap, type MapMouseEvent, Popup } from "maplibre-gl";

export async function renderToString(element: Element): Promise<string> {
  return await renderer.render(element);
}

function decodeOsmId(rawId: number): { type: string; id: number } | null {
  const typeCode = rawId % 10;
  const osmId = Math.floor(rawId / 10);
  if (typeCode === 1) return { type: "node", id: osmId };
  if (typeCode === 2) return { type: "way", id: osmId };
  if (typeCode === 3) return { type: "relation", id: osmId };
  return null;
}

function FeatureHeader({
  feature,
  isOSM,
}: {
  feature: MapGeoJSONFeature;
  isOSM: boolean;
}): Element {
  let idElement: Element;
  if (feature.id === undefined) {
    idElement = <span>No ID</span>;
  } else if (isOSM && typeof feature.id === "number") {
    const osm = decodeOsmId(feature.id);
    if (osm) {
      idElement = (
        <a
          href={`https://www.openstreetmap.org/${osm.type}/${osm.id}`}
          target="_blank"
          rel="noreferrer"
        >
          {osm.type}/{osm.id}
        </a>
      );
    } else {
      idElement = <span>ID: {String(feature.id)}</span>;
    }
  } else {
    idElement = <span>ID: {String(feature.id)}</span>;
  }

  return (
    <div class="feature-header">
      {idElement}
      {" • "}
      <span>{feature.geometry.type}</span>
    </div>
  );
}

function PropertiesTable({ properties }: { properties: Record<string, unknown> }): Element | null {
  if (!properties || Object.keys(properties).length === 0) {
    return null;
  }

  return (
    <table>
      {Object.entries(properties)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => (
          <tr>
            <td>{key}</td>
            <td>=</td>
            <td>{JSON.stringify(value)}</td>
          </tr>
        ))}
    </table>
  );
}

function LayerHeader({ layerName, color }: { layerName: string; color?: string }): Element {
  return (
    <div class="layer-header">
      {color && <div class="layer-swatch" style={`background-color: ${color}`} />}
      <strong>{layerName}</strong>
    </div>
  );
}

export function groupFeaturesBySource(features: MapGeoJSONFeature[]): Array<{
  feature: MapGeoJSONFeature;
  layers: Array<{ id: string; type: string }>;
}> {
  const grouped = new Map<
    string,
    {
      feature: MapGeoJSONFeature;
      layers: Map<string, { id: string; type: string }>;
    }
  >();

  for (const feature of features) {
    const vectorTile = (feature as any)._vectorTileFeature;
    const key = vectorTile
      ? [
          feature.source,
          feature.sourceLayer,
          vectorTile._z,
          vectorTile._x,
          vectorTile._y,
          feature.id,
          feature.geometry.type,
        ].join("-")
      : [feature.source, feature.sourceLayer, feature.id, feature.geometry.type].join("-");

    if (!grouped.has(key)) {
      const layer = feature.layer ? { id: feature.layer.id, type: feature.layer.type } : null;
      const layers = new Map<string, { id: string; type: string }>();
      if (layer) {
        layers.set(layer.id, layer);
      }

      grouped.set(key, {
        feature,
        layers,
      });
    } else {
      const existing = grouped.get(key)!;
      if (feature.layer) {
        const layer = { id: feature.layer.id, type: feature.layer.type };
        existing.layers.set(layer.id, layer);
      }
    }
  }

  return Array.from(grouped.values()).map(({ feature, layers }) => ({
    feature,
    layers: Array.from(layers.values()),
  }));
}

export function FeatureInfo({
  features,
  showLayers = false,
  layerColors,
  osmSources,
}: {
  features: MapGeoJSONFeature[];
  showLayers?: boolean;
  layerColors?: Map<string, string>;
  osmSources?: Set<string>;
}): Element {
  const grouped = groupFeaturesBySource(features);

  return (
    <div class="feature-info">
      {grouped.map(({ feature, layers }, index) => {
        const color =
          layerColors && feature.sourceLayer ? layerColors.get(feature.sourceLayer) : undefined;

        return (
          <Fragment>
            {index > 0 && <hr />}
            <div class="feature-item">
              {showLayers && feature.source && feature.sourceLayer && (
                <div class="source-info">
                  <strong>
                    {feature.source}.{feature.sourceLayer}
                  </strong>
                </div>
              )}
              {!showLayers && feature.sourceLayer && (
                <LayerHeader layerName={feature.sourceLayer} color={color} />
              )}
              <FeatureHeader feature={feature} isOSM={osmSources?.has(feature.source) ?? false} />
              <PropertiesTable properties={feature.properties || {}} />
              {showLayers && layers.length > 0 && (
                <Fragment>
                  <h4>Rendered by:</h4>
                  <table>
                    {layers.map((layer) => (
                      <tr>
                        <td>{layer.id}</td>
                        <td>({layer.type})</td>
                      </tr>
                    ))}
                  </table>
                </Fragment>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export function setupHoverPopup(
  map: MaplibreMap,
  options: {
    showLayers?: boolean;
    layers?: string[];
    layerColors?: Map<string, string>;
  } = {},
): { hidePopup: () => void; setEnabled: (enabled: boolean) => void } {
  const popup = new Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: "400px",
    className: "feature-popup",
  });

  let isPinned = false;
  let isEnabled = true;

  const hidePopup = () => {
    isPinned = false;
    popup.remove();
  };

  const setEnabled = (enabled: boolean) => {
    isEnabled = enabled;
    if (!enabled) {
      hidePopup();
    }
  };

  const queryFeatures = (e: MapMouseEvent) => {
    const tolerance = 5;
    const bbox: [[number, number], [number, number]] = [
      [e.point.x - tolerance, e.point.y - tolerance],
      [e.point.x + tolerance, e.point.y + tolerance],
    ];

    const queryOptions = options.layers ? { layers: options.layers } : undefined;
    const allFeatures = map.queryRenderedFeatures(bbox, queryOptions);

    // Filter out features that don't match the search filter
    return allFeatures.filter((feature) => {
      if (feature.id === undefined || !feature.source) {
        return true;
      }
      const featureState = map.getFeatureState({
        source: feature.source,
        sourceLayer: feature.sourceLayer,
        id: feature.id,
      });
      return featureState.match !== false;
    });
  };

  map.on("mousemove", (e: MapMouseEvent) => {
    if (!isEnabled || isPinned) return;

    const features = queryFeatures(e);
    map.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";
  });

  map.on("click", async (e: MapMouseEvent) => {
    if (!isEnabled) return;

    const features = queryFeatures(e);

    if (features.length > 0) {
      isPinned = true;

      const osmSources = new Set<string>();
      for (const [id, source] of Object.entries(map.getStyle().sources ?? {})) {
        if ((source as any).attribution?.includes("OpenStreetMap")) {
          osmSources.add(id);
        }
      }

      const html = await renderToString(
        <Fragment>
          <button class="popup-close">×</button>
          <FeatureInfo
            features={features}
            showLayers={options.showLayers}
            layerColors={options.layerColors}
            osmSources={osmSources}
          />
        </Fragment>,
      );

      popup.setLngLat(e.lngLat).setHTML(html).addTo(map);

      const popupElement = popup.getElement();
      if (popupElement) {
        const contentElement = popupElement.querySelector(".maplibregl-popup-content");
        if (contentElement) {
          (contentElement as HTMLElement).style.pointerEvents = "auto";
        }

        const closeButton = popupElement.querySelector(".popup-close");
        if (closeButton) {
          closeButton.addEventListener("click", () => {
            isPinned = false;
            popup.remove();
          });
        }
      }
    } else {
      isPinned = false;
      popup.remove();
    }
  });

  map.on("mouseout", () => {
    if (!isEnabled || isPinned) return;
    map.getCanvas().style.cursor = "";
  });

  return { hidePopup, setEnabled };
}

export function setupFeatureHighlighting(
  map: MaplibreMap,
  options: {
    layers?: string[];
  } = {},
): { setEnabled: (enabled: boolean) => void } {
  let hoveredFeatures: Array<{ source: string; sourceLayer?: string; id: string | number }> = [];
  let isEnabled = true;

  const clearHoverStates = () => {
    for (const feature of hoveredFeatures) {
      map.removeFeatureState(
        { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id },
        "hover",
      );
    }
    hoveredFeatures = [];
  };

  const setEnabled = (enabled: boolean) => {
    isEnabled = enabled;
    if (!enabled) {
      clearHoverStates();
    }
  };

  map.on("mousemove", (e: MapMouseEvent) => {
    if (!isEnabled) return;

    const tolerance = 5;
    const bbox: [[number, number], [number, number]] = [
      [e.point.x - tolerance, e.point.y - tolerance],
      [e.point.x + tolerance, e.point.y + tolerance],
    ];

    const queryOptions = options.layers ? { layers: options.layers } : undefined;
    const features = map.queryRenderedFeatures(bbox, queryOptions);

    clearHoverStates();

    for (const feature of features) {
      if (feature.id !== undefined && feature.source) {
        // Skip features that don't match the search filter
        const featureState = map.getFeatureState({
          source: feature.source,
          sourceLayer: feature.sourceLayer,
          id: feature.id,
        });
        if (featureState.match === false) {
          continue;
        }

        map.setFeatureState(
          { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id },
          { hover: true },
        );
        hoveredFeatures.push({
          source: feature.source,
          sourceLayer: feature.sourceLayer,
          id: feature.id,
        });
      }
    }
  });

  map.on("mouseout", () => {
    if (!isEnabled) return;
    clearHoverStates();
  });

  return { setEnabled };
}

import * as turf from "@turf/turf";
import { type LngLat, type Map as MaplibreMap, Marker } from "maplibre-gl";

const LINE_SOURCE_ID = "measurement-line";

type MeasurementState = {
  point1: LngLat | null;
  point2: LngLat | null;
  marker1: Marker | null;
  marker2: Marker | null;
};

export function setupMeasurementTool(
  map: MaplibreMap,
  options?: {
    setPopupEnabled?: (enabled: boolean) => void;
    setHighlightEnabled?: (enabled: boolean) => void;
  },
): {
  activate: () => void;
  deactivate: () => void;
  toggle: () => void;
  isActive: () => boolean;
} {
  let isActive = false;
  let state: MeasurementState = {
    point1: null,
    point2: null,
    marker1: null,
    marker2: null,
  };
  let panelElement: HTMLElement | null = null;

  const createMarker = (lngLat: LngLat): Marker => {
    const el = document.createElement("div");
    el.className = "measurement-marker";
    return new Marker({ element: el, draggable: true }).setLngLat(lngLat).addTo(map);
  };

  const updateLine = () => {
    if (!state.point1 || !state.point2) return;

    const line = turf.greatCircle(
      [state.point1.lng, state.point1.lat],
      [state.point2.lng, state.point2.lat],
      { npoints: 100 },
    );

    if (map.getSource(LINE_SOURCE_ID)) {
      (map.getSource(LINE_SOURCE_ID) as any).setData(line);
    } else {
      map.addSource(LINE_SOURCE_ID, {
        type: "geojson",
        data: line,
      });

      map.addLayer({
        id: `${LINE_SOURCE_ID}-line`,
        type: "line",
        source: LINE_SOURCE_ID,
        paint: {
          "line-color": "#088",
          "line-width": 2,
        },
      });
    }

    updatePanelContent();
  };

  const createPanel = () => {
    if (panelElement) return;

    panelElement = document.createElement("div");
    panelElement.className = "measurement-panel";
    document.body.appendChild(panelElement);

    updatePanelContent();
  };

  const updatePanelContent = () => {
    if (!panelElement) return;

    let content: string;
    if (!state.point1) {
      content = "<span>Click on the map to place the first point</span>";
    } else if (!state.point2) {
      content = "<span>Click on the map to place the second point</span>";
    } else {
      const from = turf.point([state.point1.lng, state.point1.lat]);
      const to = turf.point([state.point2.lng, state.point2.lat]);
      const distanceKm = turf.distance(from, to, { units: "kilometers" });
      const distanceMiles = turf.distance(from, to, { units: "miles" });
      content = `<span><strong>${distanceKm.toFixed(2)} km</strong> / ${distanceMiles.toFixed(2)} mi</span>`;
    }

    panelElement.innerHTML = `
      ${content}
      <button class="close">×</button>
    `;

    const closeButton = panelElement.querySelector(".close");
    if (closeButton) {
      closeButton.addEventListener("click", deactivate);
    }
  };

  const onMapClick = (e: any) => {
    if (!isActive) return;

    const lngLat = e.lngLat;

    if (!state.point1) {
      state.point1 = lngLat;
      state.marker1 = createMarker(lngLat);

      state.marker1.on("drag", () => {
        if (state.marker1) {
          state.point1 = state.marker1.getLngLat();
          updateLine();
        }
      });

      updatePanelContent();
    } else if (!state.point2) {
      state.point2 = lngLat;
      state.marker2 = createMarker(lngLat);

      state.marker2.on("drag", () => {
        if (state.marker2) {
          state.point2 = state.marker2.getLngLat();
          updateLine();
        }
      });

      updateLine();
      updatePanelContent();
    }

    if (state.point1 && state.point2) {
      map.getCanvas().style.cursor = "";
    }
  };

  const activate = () => {
    if (isActive) return;

    isActive = true;
    map.getCanvas().style.cursor = "crosshair";

    if (options?.setPopupEnabled) {
      options.setPopupEnabled(false);
    }
    if (options?.setHighlightEnabled) {
      options.setHighlightEnabled(false);
    }

    createPanel();
    map.on("click", onMapClick);
  };

  const deactivate = () => {
    if (!isActive) return;

    isActive = false;
    map.getCanvas().style.cursor = "";

    if (options?.setPopupEnabled) {
      options.setPopupEnabled(true);
    }
    if (options?.setHighlightEnabled) {
      options.setHighlightEnabled(true);
    }

    map.off("click", onMapClick);

    if (state.marker1) {
      state.marker1.remove();
      state.marker1 = null;
    }
    if (state.marker2) {
      state.marker2.remove();
      state.marker2 = null;
    }

    if (map.getLayer(`${LINE_SOURCE_ID}-line`)) {
      map.removeLayer(`${LINE_SOURCE_ID}-line`);
    }
    if (map.getSource(LINE_SOURCE_ID)) {
      map.removeSource(LINE_SOURCE_ID);
    }

    if (panelElement) {
      panelElement.remove();
      panelElement = null;
    }

    state = {
      point1: null,
      point2: null,
      marker1: null,
      marker2: null,
    };
  };

  const toggle = () => {
    if (isActive) {
      deactivate(); // reset if already active
      activate();
    } else {
      activate();
    }
  };

  return {
    activate,
    deactivate,
    toggle,
    isActive: () => isActive,
  };
}

import type { Context, Element } from "@b9g/crank";
import type { Map as MaplibreMap } from "maplibre-gl";
import { Hash } from "maplibre-gl";
import { Legend } from "./legend.tsx";
import { initializeMapFromFileInfo } from "./map.ts";
import type { FileEntry, FileInfo, MapState, ViewMode } from "./types.ts";
import { getInitialView, parseHash } from "./utils.ts";

const FIT_PADDING = 50;

export function getDefaultViewMode(fileCount: number): ViewMode {
  if (fileCount === 1) return "single";
  if (fileCount === 2) return "swipe";
  return "tile";
}

type MapSettings = {
  showTileBoundaries: boolean;
  showCollisionBoxes: boolean;
  enableRotation: boolean;
  enablePitch: boolean;
  enableGlobe: boolean;
};

type MapViewProps = {
  mode: ViewMode;
  allFileInfos: FileEntry[];
  selectedIndices: number[];
  onIndexChange: (position: number, index: number) => void;
  onMapMove?: (state: MapState) => void;
  showTileBoundaries: boolean;
  showCollisionBoxes: boolean;
  enableRotation: boolean;
  enablePitch: boolean;
  enableGlobe: boolean;
};

function applySettings(map: MaplibreMap, settings: MapSettings) {
  map.showTileBoundaries = settings.showTileBoundaries;
  map.showCollisionBoxes = settings.showCollisionBoxes;
  map.setProjection({ type: settings.enableGlobe ? "globe" : "mercator" });

  if (settings.enableRotation) {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enableRotation();
  } else {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.setBearing(0);
  }

  if (settings.enablePitch) {
    map.setMaxPitch(85);
  } else {
    map.setMaxPitch(0);
    map.setPitch(0);
  }
}

function updateSwipeClip(position: number, selectedIndices: number[]) {
  if (selectedIndices.length !== 2) return;

  const leftContainer = document.getElementById(`map-${selectedIndices[0]}`);
  const rightContainer = document.getElementById(`map-${selectedIndices[1]}`);
  const slider = document.querySelector(".swipe-slider") as HTMLElement;

  if (leftContainer && rightContainer) {
    leftContainer.style.clipPath = `inset(0 ${100 - position}% 0 0)`;
    rightContainer.style.clipPath = `inset(0 0 0 ${position}%)`;
  }

  if (slider) {
    slider.style.left = `${position}%`;
  }
}

function setupSwipeControl(selectedIndices: number[]) {
  const mainEl = document.querySelector("main");
  if (!mainEl) return null;

  const slider = mainEl.querySelector(".swipe-slider") as HTMLElement;
  if (!slider) return null;

  let isDragging = false;
  let currentPosition = 50;

  const updatePosition = (clientX: number) => {
    const rect = mainEl.getBoundingClientRect();
    const position = ((clientX - rect.left) / rect.width) * 100;
    currentPosition = Math.max(0, Math.min(100, position));
    updateSwipeClip(currentPosition, selectedIndices);
  };

  const onResize = () => {
    updateSwipeClip(currentPosition, selectedIndices);
  };

  const onMouseDown = () => {
    isDragging = true;
  };
  const onMouseUp = () => {
    isDragging = false;
  };
  const onMouseMove = (e: MouseEvent) => {
    if (isDragging) updatePosition(e.clientX);
  };

  slider.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousemove", onMouseMove);

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(mainEl);

  updateSwipeClip(50, selectedIndices);

  return () => {
    slider.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("mousemove", onMouseMove);
    resizeObserver.disconnect();
  };
}

function isLoaded(fileInfo: FileEntry): fileInfo is FileInfo {
  return !("error" in fileInfo);
}

function renderContainer(fileInfo: FileEntry, i: number): Element {
  if (isLoaded(fileInfo)) {
    return <div class="map-container" id={`map-${i}`} />;
  }

  return (
    <div class="map-container map-error" id={`map-${i}`}>
      <strong>Failed to load {fileInfo.title}</strong>
      <p>{fileInfo.error}</p>
    </div>
  );
}

export async function* MapView(this: Context, props: MapViewProps): AsyncGenerator<Element> {
  const {
    allFileInfos,
    onMapMove,
    showTileBoundaries,
    showCollisionBoxes,
    enableRotation,
    enablePitch,
    enableGlobe,
  } = props;

  this.schedule(() => this.refresh());

  // First render to create DOM containers
  let viewElement: HTMLElement = yield (
    <div class="map-view">
      {allFileInfos.map((fileInfo: FileEntry, i: number) => (
        <div class="map-wrapper">{renderContainer(fileInfo, i)}</div>
      ))}
    </div>
  );

  // keyed by index into allFileInfos; files that failed to load have no map
  const maps = new Map<number, MaplibreMap>();
  const previous = {
    mode: null as ViewMode | null,
    indices: [] as number[],
    settings: {
      showTileBoundaries,
      showCollisionBoxes,
      enableRotation,
      enablePitch,
      enableGlobe,
    },
  };
  let swipeCleanup = null as (() => void) | null;
  let mapsLoaded = false;

  // Initialize maps after DOM is mounted
  requestAnimationFrame(() => {
    const view = parseHash() ?? getInitialView(allFileInfos.filter(isLoaded));

    for (const [i, fileInfo] of allFileInfos.entries()) {
      if (!isLoaded(fileInfo)) continue;

      const container = viewElement.querySelector(`#map-${i}`) as HTMLElement;
      if (!container) {
        throw new Error(`Map container map-${i} not found`);
      }

      maps.set(i, initializeMapFromFileInfo(container, fileInfo));
    }

    const [primaryMap] = maps.values();
    if (!primaryMap) return; // every file failed to load

    if (view) {
      // resolve bounds to camera just once, to be sure camera is identical for all maps
      const firstMap = maps.get(props.selectedIndices[0]) ?? primaryMap;
      const camera = Array.isArray(view)
        ? firstMap.cameraForBounds(view, { padding: FIT_PADDING })
        : // MapLibre doesn't like it if a MapCamera contains `bearing: undefined` or similar
          Object.fromEntries(Object.entries(view).filter(([_, v]) => v !== undefined));

      if (camera) {
        for (const map of maps.values()) {
          map.jumpTo(camera);
        }
      }
    }

    // The URL hash and toolbar position info are bound to the state of the first
    // map, even if that map is not on screen. This works because all maps are always
    // kept in sync, even when they are not all visible.
    new Hash().addTo(primaryMap);
    if (onMapMove) {
      const updatePosition = () => {
        const center = primaryMap.getCenter();
        const bounds = primaryMap.getBounds();
        const zoom = primaryMap.getZoom();
        const bearing = primaryMap.getBearing();
        const pitch = primaryMap.getPitch();

        onMapMove({
          camera: {
            zoom,
            center: [center.lng, center.lat],
            bearing: bearing !== 0 ? bearing : undefined,
            pitch: pitch !== 0 ? pitch : undefined,
          },
          bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        });
      };
      primaryMap.on("move", updatePosition);
      primaryMap.on("zoom", updatePosition);
      updatePosition();
    }

    Promise.all([...maps.values()].map((map) => map.once("load"))).then(() => {
      mapsLoaded = true;

      for (const map of maps.values()) {
        applySettings(map, previous.settings);
      }

      this.refresh();
    });

    // Sync all maps
    let syncInProgress = false;
    for (const [index, map] of maps.entries()) {
      map.on("move", () => {
        if (syncInProgress) return;

        syncInProgress = true;
        const center = map.getCenter();
        const zoom = map.getZoom();
        const bearing = map.getBearing();
        const pitch = map.getPitch();

        for (const [otherIndex, otherMap] of maps.entries()) {
          if (otherIndex !== index) {
            otherMap.jumpTo({ center, zoom, bearing, pitch });
          }
        }

        syncInProgress = false;
      });
    }
  });

  try {
    for (const nextProps of this) {
      const {
        mode,
        selectedIndices,
        onIndexChange,
        showTileBoundaries,
        showCollisionBoxes,
        enableRotation,
        enablePitch,
        enableGlobe,
      } = nextProps;

      // Update swipe mode when mode or selection changes
      if (
        mode !== previous.mode ||
        selectedIndices.length !== previous.indices.length ||
        selectedIndices.some((idx: number, i: number) => idx !== previous.indices[i])
      ) {
        swipeCleanup?.();
        swipeCleanup = null;

        // Clear clip styles from all maps
        for (let i = 0; i < allFileInfos.length; i++) {
          const container = viewElement.querySelector(`#map-${i}`) as HTMLElement;
          if (container) {
            container.style.clipPath = "";
          }
        }

        if (mode === "swipe") {
          requestAnimationFrame(() => {
            swipeCleanup = setupSwipeControl(selectedIndices);
          });
        }

        previous.mode = mode;
        previous.indices = [...selectedIndices];
      }

      // Apply settings when they change
      if (
        showTileBoundaries !== previous.settings.showTileBoundaries ||
        showCollisionBoxes !== previous.settings.showCollisionBoxes ||
        enableRotation !== previous.settings.enableRotation ||
        enablePitch !== previous.settings.enablePitch ||
        enableGlobe !== previous.settings.enableGlobe
      ) {
        previous.settings = {
          showTileBoundaries,
          showCollisionBoxes,
          enableRotation,
          enablePitch,
          enableGlobe,
        };

        if (mapsLoaded) {
          for (const map of maps.values()) {
            applySettings(map, previous.settings);
          }
        }
      }

      // Yield the same JSX structure to keep map containers stable
      viewElement = yield (
        <div class={`map-view mode-${mode}`} data-active-count={selectedIndices.length}>
          {allFileInfos.map((fileInfo: FileEntry, i: number) => {
            const selectedPosition = selectedIndices.indexOf(i);
            const isActive = selectedPosition >= 0;
            const map = maps.get(i);
            const layers = isLoaded(fileInfo) ? fileInfo.layers : undefined;

            return (
              <div
                class={`map-wrapper ${isActive ? "active" : "inactive"}`}
                data-position={isActive ? selectedPosition : undefined}
              >
                {renderContainer(fileInfo, i)}
                {isActive && (
                  <div class="map-controls">
                    {allFileInfos.length > 1 && (
                      <select
                        onchange={(e: Event) =>
                          onIndexChange(
                            selectedPosition,
                            parseInt((e.target as HTMLSelectElement).value, 10),
                          )
                        }
                      >
                        {allFileInfos.map((info: FileEntry, j: number) => (
                          <option value={j} selected={j === i}>
                            {info.title}
                          </option>
                        ))}
                      </select>
                    )}
                    {mapsLoaded && map && layers && <Legend map={map} layers={layers} />}
                  </div>
                )}
              </div>
            );
          })}
          {mode === "swipe" && <div class="swipe-slider" />}
        </div>
      );
    }
  } finally {
    for (const map of maps.values()) {
      map.remove();
    }
    swipeCleanup?.();
  }
}

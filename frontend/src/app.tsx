import { type Context, type Element, Fragment } from "@b9g/crank";
import { renderer } from "@b9g/crank/dom";
import type { AppState, FileInfo, MapCamera, MapState, URLState, ViewMode } from "./types.ts";
import { detectFileInfo, getCoordinatePrecision } from "./utils.ts";
import { getDefaultViewMode, MapView } from "./views.tsx";

function Toolbar({
  state,
  fileInfos,
  onModeChange,
  onSettingChange,
  onSelectedIndexChange,
}: {
  state: AppState;
  fileInfos: FileInfo[];
  onModeChange: (mode: ViewMode) => void;
  onSettingChange: (
    key: keyof Pick<
      AppState,
      "showTileBoundaries" | "showCollisionBoxes" | "enableRotation" | "enablePitch" | "fullscreen"
    >,
    value: boolean,
  ) => void;
  onSelectedIndexChange: (position: number, index: number) => void;
}): Element {
  const showModePicker = fileInfos.length > 1;

  return (
    <div id="toolbar">
      <div class="toolbar-left">
        {showModePicker && (
          <label>
            Mode:
            <select
              onchange={(e: Event) =>
                onModeChange((e.target as HTMLSelectElement).value as ViewMode)
              }
            >
              <option value="single" selected={state.mode === "single"}>
                Single
              </option>
              <option value="swipe" selected={state.mode === "swipe"}>
                Swipe
              </option>
              <option value="tile" selected={state.mode === "tile"}>
                Tile
              </option>
            </select>
          </label>
        )}

        {showModePicker && state.mode === "single" && (
          <label>
            File:
            <select
              onchange={(e: Event) =>
                onSelectedIndexChange(0, parseInt((e.target as HTMLSelectElement).value, 10))
              }
            >
              {fileInfos.map((info, i) => (
                <option value={i} selected={i === state.selectedIndices[0]}>
                  {info.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div class="toolbar-center">
        {state.camera &&
          state.bounds &&
          (() => {
            const precision = getCoordinatePrecision(state.camera.zoom, state.camera.center[1]);
            return (
              <Fragment>
                <span class="map-position">
                  {state.camera.zoom.toFixed(2)}/{state.camera.center[1].toFixed(precision)}/
                  {state.camera.center[0].toFixed(precision)}
                </span>
                <span class="map-bbox">
                  [{state.bounds[0].toFixed(precision)}, {state.bounds[1].toFixed(precision)},{" "}
                  {state.bounds[2].toFixed(precision)}, {state.bounds[3].toFixed(precision)}]
                </span>
              </Fragment>
            );
          })()}
      </div>

      <div class="toolbar-right">
        <details>
          <summary>Settings</summary>
          <div>
            <label>
              <input
                type="checkbox"
                checked={state.showTileBoundaries}
                onchange={(e: Event) =>
                  onSettingChange("showTileBoundaries", (e.target as HTMLInputElement).checked)
                }
              />
              Tile boundaries
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.showCollisionBoxes}
                onchange={(e: Event) =>
                  onSettingChange("showCollisionBoxes", (e.target as HTMLInputElement).checked)
                }
              />
              Collision boxes
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.enableRotation}
                onchange={(e: Event) =>
                  onSettingChange("enableRotation", (e.target as HTMLInputElement).checked)
                }
              />
              Rotation
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.enablePitch}
                onchange={(e: Event) =>
                  onSettingChange("enablePitch", (e.target as HTMLInputElement).checked)
                }
              />
              Pitch
            </label>
          </div>
        </details>

        <button onclick={() => onSettingChange("fullscreen", !state.fullscreen)}>
          {state.fullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
      </div>
    </div>
  );
}

async function* App(this: Context): AsyncGenerator<Element> {
  const params = new URLSearchParams(window.location.search);
  const args = params.get("args");

  if (!args) {
    yield <div class="error">No file specified</div>;
    return;
  }

  const filenames = args.split(",").filter((f) => f.length > 0);
  if (filenames.length === 0) {
    yield <div class="error">No filename provided</div>;
    return;
  }

  let allFileInfos: FileInfo[] = [];
  try {
    allFileInfos = await Promise.all(filenames.map((f) => detectFileInfo(f)));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    yield <div class="error">Error: {message}</div>;
    return;
  }

  // State that doesn't persist across refreshes (not in URL)
  let camera: MapCamera | undefined;
  let bounds: [number, number, number, number] | undefined;

  const getStateFromURL = (): AppState => {
    const params = new URLSearchParams(window.location.search);
    const validModes: ViewMode[] = ["single", "swipe", "tile"];
    const modeParam = params.get("mode");
    const mode: ViewMode = validModes.includes(modeParam as ViewMode)
      ? (modeParam as ViewMode)
      : getDefaultViewMode(filenames.length);

    const indicesParam = params.get("indices");
    let selectedIndices = indicesParam
      ? indicesParam
          .split(",")
          .map((i) => parseInt(i, 10))
          .filter((i) => i >= 0 && i < allFileInfos.length)
      : [];
    if (selectedIndices.length === 0) {
      selectedIndices = Array.from({ length: Math.min(6, allFileInfos.length) }, (_, i) => i);
    }

    return {
      mode,
      selectedIndices,
      showTileBoundaries: params.get("tileBoundaries") === "true",
      showCollisionBoxes: params.get("collisionBoxes") === "true",
      enableRotation: params.get("rotation") === "true",
      enablePitch: params.get("pitch") === "true",
      fullscreen: params.get("fullscreen") === "true",
      camera,
      bounds,
    };
  };

  const updateURL = (updates: Partial<URLState>) => {
    const params = new URLSearchParams(window.location.search);

    if (updates.mode !== undefined) {
      params.set("mode", updates.mode);
    }

    if (updates.selectedIndices !== undefined) {
      params.set("indices", updates.selectedIndices.join(","));
    }

    if (updates.showTileBoundaries !== undefined) {
      updates.showTileBoundaries
        ? params.set("tileBoundaries", "true")
        : params.delete("tileBoundaries");
    }

    if (updates.showCollisionBoxes !== undefined) {
      updates.showCollisionBoxes
        ? params.set("collisionBoxes", "true")
        : params.delete("collisionBoxes");
    }

    if (updates.enableRotation !== undefined) {
      updates.enableRotation ? params.set("rotation", "true") : params.delete("rotation");
    }

    if (updates.enablePitch !== undefined) {
      updates.enablePitch ? params.set("pitch", "true") : params.delete("pitch");
    }

    if (updates.fullscreen !== undefined) {
      updates.fullscreen ? params.set("fullscreen", "true") : params.delete("fullscreen");
    }

    const newURL = `${window.location.pathname}?${params}${window.location.hash}`;
    window.history.replaceState({}, "", newURL);
  };

  const onModeChange = (mode: ViewMode) => {
    updateURL({ mode });
    this.refresh();
  };

  const onSettingChange = (
    key: keyof Pick<
      AppState,
      "showTileBoundaries" | "showCollisionBoxes" | "enableRotation" | "enablePitch" | "fullscreen"
    >,
    value: boolean,
  ) => {
    updateURL({ [key]: value });
    this.refresh();
  };

  const onSelectedIndexChange = (position: number, index: number) => {
    const state = getStateFromURL();
    const newIndices = [...state.selectedIndices];
    const existingPosition = newIndices.indexOf(index);

    if (existingPosition >= 0 && existingPosition !== position) {
      // Swap: the selected index is already in use at another position
      newIndices[existingPosition] = newIndices[position];
      newIndices[position] = index;
    } else {
      // Simple replacement
      newIndices[position] = index;
    }

    updateURL({ selectedIndices: newIndices });
    this.refresh();
  };

  const onMapMove = (mapState: MapState) => {
    camera = mapState.camera;
    bounds = mapState.bounds;
    this.refresh();
  };

  for (const _ of this) {
    const state = getStateFromURL();
    // fullscreen CSS keys off a body class, so it must be applied here (not in the
    // settings change handler) to take effect when loading a ?fullscreen=true URL
    document.body.classList.toggle("fullscreen", state.fullscreen);
    const numMaps =
      state.mode === "single" ? 1 : state.mode === "swipe" ? 2 : Math.min(6, allFileInfos.length);

    yield (
      <Fragment>
        <Toolbar
          state={state}
          fileInfos={allFileInfos}
          onModeChange={onModeChange}
          onSettingChange={onSettingChange}
          onSelectedIndexChange={onSelectedIndexChange}
        />
        <button class="unfullscreen-button" onclick={() => onSettingChange("fullscreen", false)}>
          Exit Fullscreen
        </button>
        <main class={state.mode}>
          <MapView
            mode={state.mode}
            allFileInfos={allFileInfos}
            selectedIndices={state.selectedIndices.slice(0, numMaps)}
            onIndexChange={onSelectedIndexChange}
            onMapMove={onMapMove}
            showTileBoundaries={state.showTileBoundaries}
            showCollisionBoxes={state.showCollisionBoxes}
            enableRotation={state.enableRotation}
            enablePitch={state.enablePitch}
          />
        </main>
      </Fragment>
    );
  }
}

renderer.render(<App />, document.body);

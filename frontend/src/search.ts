import type { Map as MaplibreMap } from "maplibre-gl";

type Target = {
  map: MaplibreMap;
  layerIds: string[];
  matched: Array<{ source: string; sourceLayer?: string; id: string | number }>;
};

const targets: Target[] = [];
let panelElement: HTMLElement | null = null;
let currentExpression = "";
let keyListenerInstalled = false;
let debounceTimer: number | undefined;

/**
 * Register a map for the shared Cmd/Ctrl-F search filter. A single search
 * panel applies the entered expression to every registered map, so filtering
 * stays consistent across comparison views.
 */
export function registerSearchableMap(map: MaplibreMap, layerIds: string[]): void {
  const target: Target = { map, layerIds, matched: [] };
  targets.push(target);

  map.on("remove", () => {
    const i = targets.indexOf(target);
    if (i >= 0) targets.splice(i, 1);
    if (targets.length === 0) deactivate();
  });

  if (!keyListenerInstalled) {
    keyListenerInstalled = true;
    document.addEventListener("keydown", onKeyDown);
  }
}

function compileExpression(expression: string): (properties: Record<string, unknown>) => boolean {
  return new Function(
    "properties",
    `
    with (properties) {
      try {
        return Boolean(${expression});
      } catch (e) {
        return false;
      }
    }
  `,
  ) as (properties: Record<string, unknown>) => boolean;
}

function clearMatches(target: Target) {
  for (const f of target.matched) {
    target.map.removeFeatureState(
      { source: f.source, sourceLayer: f.sourceLayer, id: f.id },
      "match",
    );
  }
  target.matched = [];
}

function applyFilter(expression: string, inputElement?: HTMLInputElement) {
  currentExpression = expression;
  for (const target of targets) {
    clearMatches(target);
  }

  if (!expression.trim()) {
    inputElement?.setCustomValidity("");
    return;
  }

  let filterFn: (properties: Record<string, unknown>) => boolean;
  try {
    filterFn = compileExpression(expression);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Invalid expression";
    inputElement?.setCustomValidity(errorMsg);
    inputElement?.reportValidity();
    return;
  }
  inputElement?.setCustomValidity("");

  for (const target of targets) {
    const features = target.map.queryRenderedFeatures(undefined, { layers: target.layerIds });
    for (const feature of features) {
      if (feature.id === undefined || !feature.source) continue;
      target.map.setFeatureState(
        { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id },
        { match: filterFn(feature.properties || {}) },
      );
      target.matched.push({
        source: feature.source,
        sourceLayer: feature.sourceLayer,
        id: feature.id,
      });
    }
  }
}

// Re-apply the filter after map movement to cover newly loaded features
const reapplyFilter = () => applyFilter(currentExpression);

function createPanel() {
  panelElement = document.createElement("div");
  panelElement.className = "search-panel";
  panelElement.innerHTML = `
    <input
      type="text"
      class="search-input"
      placeholder='e.g., type == "city" && population > 5000'
    />
    <button class="close">×</button>
  `;
  document.body.appendChild(panelElement);

  const input = panelElement.querySelector(".search-input") as HTMLInputElement;
  input.focus();
  // Debounced so that re-evaluating the filter doesn't add typing latency
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => applyFilter(input.value, input), 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") deactivate();
  });

  panelElement.querySelector(".close")!.addEventListener("click", deactivate);
}

function activate() {
  if (panelElement || targets.length === 0) return;

  for (const target of targets) {
    target.map.setGlobalStateProperty("searchActive", true);
    target.map.on("idle", reapplyFilter);
    target.map.on("moveend", reapplyFilter);
  }
  createPanel();
}

function deactivate() {
  if (!panelElement) return;

  clearTimeout(debounceTimer);
  currentExpression = "";
  for (const target of targets) {
    target.map.setGlobalStateProperty("searchActive", false);
    target.map.off("idle", reapplyFilter);
    target.map.off("moveend", reapplyFilter);
    clearMatches(target);
  }
  panelElement.remove();
  panelElement = null;
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    panelElement ? deactivate() : activate();
  } else if (e.key === "Escape" && panelElement) {
    deactivate();
  }
}

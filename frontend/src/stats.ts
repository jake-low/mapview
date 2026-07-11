import type { GeoJSON } from "geojson";

function countFeatures(geojson: GeoJSON): number {
  return geojson.type === "FeatureCollection" ? geojson.features.length : 1;
}

/**
 * Setup stats widget for data overlay viewers
 */
export function setupStatsWidget(container: HTMLElement, geojson: GeoJSON): void {
  const featureCount = countFeatures(geojson);

  const statsElement = document.createElement("div");
  statsElement.className = "stats-widget";
  statsElement.textContent = `${featureCount} feature${featureCount !== 1 ? "s" : ""}`;

  container.style.position = "relative";
  container.appendChild(statsElement);
}

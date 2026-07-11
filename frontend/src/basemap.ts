import type { Map as MaplibreMap } from "maplibre-gl";

type BasemapOption = {
  id: string;
  name: string;
  tiles: string[];
  attribution: string;
};

export const basemaps: BasemapOption[] = [
  {
    id: "osm-carto",
    name: "OSM Carto",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "osm-humanitarian",
    name: "Humanitarian",
    tiles: ["https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "carto-light",
    name: "Carto Light",
    tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors, © CARTO",
  },
  {
    id: "carto-dark",
    name: "Carto Dark",
    tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors, © CARTO",
  },
];

/**
 * Setup basemap switcher for data overlay viewers
 */
export function setupBasemapSwitcher(map: MaplibreMap, container: HTMLElement): void {
  const switcherElement = document.createElement("div");
  switcherElement.className = "basemap-switcher";

  const label = document.createElement("label");
  label.textContent = "Basemap: ";

  const select = document.createElement("select");

  for (const basemap of basemaps) {
    const option = document.createElement("option");
    option.value = basemap.id;
    option.textContent = basemap.name;
    if (basemap.id === "osm-carto") {
      option.selected = true;
    }
    select.appendChild(option);
  }

  select.addEventListener("change", (e) => {
    const basemapId = (e.target as HTMLSelectElement).value;

    // Hide all basemap layers
    for (const basemap of basemaps) {
      if (map.getLayer(basemap.id)) {
        map.setLayoutProperty(basemap.id, "visibility", "none");
      }
    }

    // Show selected basemap layer
    if (map.getLayer(basemapId)) {
      map.setLayoutProperty(basemapId, "visibility", "visible");
    }
  });

  switcherElement.appendChild(label);
  switcherElement.appendChild(select);

  container.style.position = "relative";
  container.appendChild(switcherElement);
}

import type { Context, Element } from "@b9g/crank";
import type { Map as MaplibreMap } from "maplibre-gl";
import type { LayerGroup } from "./types.ts";

type LegendProps = {
  map: MaplibreMap;
  layerGroups: LayerGroup[];
};

export function* Legend(this: Context, props: LegendProps): Generator<Element> {
  const { map, layerGroups } = props;

  const layerVisibility = new Map<string, boolean>(layerGroups.map((g) => [g.name, true]));
  let isOpen = true;

  const setLayerVisibility = (layerName: string, visible: boolean) => {
    layerVisibility.set(layerName, visible);
    const layerGroup = layerGroups.find((g) => g.name === layerName);
    if (layerGroup) {
      for (const layerId of layerGroup.layerIds) {
        map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    }
  };

  const toggleLayer = (layerName: string, visible: boolean) => {
    setLayerVisibility(layerName, visible);
    this.refresh();
  };

  const toggleAll = (visible: boolean) => {
    for (const group of layerGroups) {
      setLayerVisibility(group.name, visible);
    }
    this.refresh();
  };

  for (const _ of this) {
    const allChecked = Array.from(layerVisibility.values()).every((v) => v);

    yield (
      <details
        class="legend"
        open={isOpen}
        ontoggle={(e: Event) => {
          isOpen = (e.target as HTMLDetailsElement).open;
        }}
      >
        <summary>Legend</summary>
        <label>
          <input
            type="checkbox"
            checked={allChecked}
            onclick={(e: Event) => toggleAll((e.target as HTMLInputElement).checked)}
          />
          All
        </label>
        <hr />
        {layerGroups.map((group) => (
          <label>
            <input
              type="checkbox"
              checked={layerVisibility.get(group.name) || false}
              style={`accent-color: ${group.color}`}
              onclick={(e: Event) => {
                toggleLayer(group.name, (e.target as HTMLInputElement).checked);
              }}
            />
            {group.name}
          </label>
        ))}
      </details>
    );
  }
}

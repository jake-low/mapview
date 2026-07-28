import type { Context, Element } from "@b9g/crank";
import type { Map as MaplibreMap } from "maplibre-gl";
import { setDataLayerVisibility } from "./map.ts";
import type { DataLayer } from "./types.ts";

type LegendProps = {
  map: MaplibreMap;
  layers: DataLayer[];
};

export function* Legend(this: Context, props: LegendProps): Generator<Element> {
  const { map, layers } = props;

  const layerVisibility = new Map<string, boolean>(layers.map((layer) => [layer.name, true]));
  let isOpen = true;

  const setLayerVisibility = (layerName: string, visible: boolean) => {
    layerVisibility.set(layerName, visible);
    setDataLayerVisibility(map, layerName, visible);
  };

  const toggleLayer = (layerName: string, visible: boolean) => {
    setLayerVisibility(layerName, visible);
    this.refresh();
  };

  const toggleAll = (visible: boolean) => {
    for (const layer of layers) {
      setLayerVisibility(layer.name, visible);
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
        {layers.map((layer) => (
          <label>
            <input
              type="checkbox"
              checked={layerVisibility.get(layer.name) || false}
              style={`accent-color: ${layer.color}`}
              onclick={(e: Event) => {
                toggleLayer(layer.name, (e.target as HTMLInputElement).checked);
              }}
            />
            {layer.name}
          </label>
        ))}
      </details>
    );
  }
}

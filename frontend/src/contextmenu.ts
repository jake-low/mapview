import type { Map as MaplibreMap } from "maplibre-gl";
import { getCoordinatePrecision } from "./utils.ts";

export function setupContextMenu(
  map: MaplibreMap,
  options?: {
    setPopupEnabled?: (enabled: boolean) => void;
  },
): () => void {
  let menuElement: HTMLDivElement | null = null;

  const hideMenu = () => {
    if (menuElement) {
      menuElement.remove();
      menuElement = null;
      if (options?.setPopupEnabled) {
        options.setPopupEnabled(true);
      }
    }
  };

  const hideAllMenus = () => {
    document.querySelectorAll(".context-menu").forEach((menu) => {
      menu.remove();
    });
    hideMenu();
  };

  const showMenu = (e: MouseEvent) => {
    e.preventDefault();
    hideAllMenus();

    if (options?.setPopupEnabled) {
      options.setPopupEnabled(false);
    }

    const { lng, lat } = map.unproject([e.offsetX, e.offsetY]);
    const zoom = map.getZoom();
    const precision = getCoordinatePrecision(zoom, lat);

    const coordText = `${lng.toFixed(precision)}, ${lat.toFixed(precision)}`;

    menuElement = document.createElement("div");
    menuElement.className = "context-menu";
    menuElement.style.position = "fixed";
    menuElement.style.left = `${e.clientX}px`;
    menuElement.style.top = `${e.clientY}px`;

    const coordItem = document.createElement("div");
    coordItem.className = "context-menu-item";
    coordItem.textContent = coordText;
    coordItem.onclick = async () => {
      try {
        await navigator.clipboard.writeText(coordText);
        hideMenu();
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
      }
    };
    menuElement.appendChild(coordItem);

    document.body.appendChild(menuElement);
  };

  const onContextMenu = (e: MouseEvent) => {
    showMenu(e);
  };

  const onGlobalContextMenu = () => {
    hideAllMenus();
  };

  const onClick = () => {
    hideMenu();
  };

  const onMapMove = () => {
    hideMenu();
  };

  map.getCanvas().addEventListener("contextmenu", onContextMenu);
  document.addEventListener("contextmenu", onGlobalContextMenu, true);
  document.addEventListener("click", onClick);
  map.on("move", onMapMove);

  return () => {
    map.getCanvas().removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("contextmenu", onGlobalContextMenu, true);
    document.removeEventListener("click", onClick);
    map.off("move", onMapMove);
    hideMenu();
  };
}

/**
 * Setup watch mode websocket connection
 */
export function setupWatchMode(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  const connect = () => {
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      if (event.data === "reload") {
        console.log("File changed, reloading...");
        window.location.reload();
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("WebSocket closed, attempting to reconnect...");
      setTimeout(connect, 1000);
    };
  };

  connect();
}

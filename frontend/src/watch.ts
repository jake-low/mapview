const MAX_RETRIES = 10;

/**
 * Setup watch mode websocket connection
 */
export function setupWatchMode(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  let failures = 0;

  const connect = () => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      failures = 0;
    };

    ws.onmessage = (event) => {
      if (event.data === "reload") {
        console.log("File changed, reloading...");
        window.location.reload();
      }
    };

    ws.onclose = () => {
      failures++;
      if (failures > MAX_RETRIES) {
        console.log("Lost connection to mapview server, file watching is disabled");
        return;
      }
      setTimeout(connect, 1000);
    };
  };

  connect();
}

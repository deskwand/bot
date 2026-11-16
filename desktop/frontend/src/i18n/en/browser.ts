export const browser = {
  title: "Takeover",
  subtitle: "When a page asks for a human, click through it here",
  urlPlaceholder: "Address to take over",
  open: "Open",
  close: "Close",
  ended: "Takeover stopped",
  endedHint: "The stream to the sandbox dropped. The tab is still there; reconnect.",
  reconnect: "Reconnect",
  frameHint: "Frames pass through memory only and are never written to disk. Click the canvas to act.",
  unavailable: {
    "no-sandbox": "This deployment has no sandbox, so takeover cannot run.",
    "image-too-old": "The sandbox image is too old; upgrade it first.",
    "sandbox-unreachable": "The sandbox is unreachable; check that it is running.",
  },
};

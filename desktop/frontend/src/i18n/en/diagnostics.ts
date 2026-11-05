import type { Messages } from "../types";

export const diagnostics: Messages["diagnostics"] = {
  export: "Export diagnostics",
  reexport: "Export again",
  exportDone: "Export complete",
  exported: "Exported ({size} bytes); sensitive fields are redacted.",
  statusCheck: "Status checks",
  unknownHint: "Shows “Unknown” when there is no evidence.",
  probeTitle: "Model connection test",
  probeDescription: "Connects to the provider directly with the key you enter.",
  model: "Model",
  apiKey: "API key",
  apiKeyPlaceholder: "Stored keys cannot be read; enter it again",
  probeButton: "Test model connection",
  probing: "Testing…",
  probeResult: "Test result",
  selectModel: "Choose a model to test.",
  retest: "Test again",
  confirmTitle: "Run the model connection test?",
  confirmDescription:
    "This calls the model once and may incur charges; the key is not written to the cloud.",
  confirm: "Confirm and test",
};

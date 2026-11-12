import type { Messages } from "../types";

export const updates: Messages["updates"] = {
  verifySignature: "The package signature is verified before upgrading.",
  available: "New version available",
  upToDate: "Up to date",
  noUpgrade: "No upgrade needed",
  versionLine: "Current {current} → available {available}",
  modelKeysMissingTitle: "Refill model keys",
  modelKeysMissingDescription: "Refill these keys on Brain after upgrading: {keys}",
  listSeparator: ", ",
  readingVersions: "Reading version information.",
  upgrade: "Upgrade",
  upgrading: "Upgrading…",
  resultTitle: "Upgrade result",
  publishedHint: "Published; verify messaging next.",
  retryUpgrade: "Upgrade again",
  desktopClient: "Desktop app",
  clientDescription: "Checked every 6 hours; installed after confirmation.",
  checkClient: "Check for updates",
  clientWindowOpened: "Update window opened",
  confirmTitle: "Confirm upgrade",
  confirmDescription:
    "Upgrade from {current} to {available}; resources and data are kept.",
  compatTitle: "Compatibility",
  compatDescription:
    "Signature and migration history verified; a failure leaves the cloud unchanged.",
  confirmUpgrade: "Confirm upgrade",
};

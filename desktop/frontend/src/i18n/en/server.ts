import type { Messages } from "../types";

export const server: Messages["server"] = {
  statusUnknown: "Status unknown",
  statusUnreachable: "Cannot reach the server",
  statusStopped: "The container is not running",
  statusUnhealthy: "The container is not ready",
  statusHealthy: "Running normally",
  address: "Host address",
  user: "User",
  dir: "Remote directory",
  status: "Status",
  image: "Image",
  startedAt: "Started at",
  restore: "Restore the previous configuration",
  restoreTitle: "Restore the previous configuration?",
  restoreDescription:
    "This puts the previous configuration file back and restarts the container.",
  confirmRestore: "Restore",
  disconnect: "Disconnect",
  disconnectTitle: "Disconnect this server?",
  disconnectDescription:
    "This clears the sign-in information saved on this computer; the container and its data on the server are not affected. Do not run the same Telegram bot on Cloudflare and the server at the same time.",
  confirmDisconnect: "Disconnect",
  unsupportedTitle: "Not available for this way of running yet",
  unsupportedDescription:
    "This feature is currently available only for Cloudflare deployments.",
};

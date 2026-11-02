// Production adapter. This is the only production module that imports the
// generated MyGo client. Tests use src/testing/fixtures.ts instead.
import { Service, events } from "../mygo";
import type { ClientService } from "./types";

export function createProductionClient(): ClientService {
  return {
    name: () => Service.name(),
    cloudflareStatus: () => Service.cloudflareStatus(),
    connectCloudflare: (accountId, token) => Service.connectCloudflare(accountId, token),
    disconnectCloudflare: () => Service.disconnectCloudflare(),
    openTokenPage: () => Service.openTokenPage(),
    listWorkers: () => Service.listWorkers(),
    selectDeployment: (scriptName) => Service.selectDeployment(scriptName),
    inspectImport: () => Service.inspectImport(),
    confirmImport: (input) => Service.confirmImport(input),
    install: (input) => Service.install(input),
    upgradeAvailable: () => Service.upgradeAvailable(),
    upgrade: () => Service.upgrade(),
    getConfig: () => Service.getConfig(),
    previewConfig: (input) => Service.previewConfig(input),
    publishConfig: (input) => Service.publishConfig(input),
    resumeOperation: (id) => Service.resumeOperation(id),
    pendingOperations: () => Service.pendingOperations(),
    startWeChatLogin: () => Service.startWeChatLogin(),
    cancelWeChatLogin: (opId) => Service.cancelWeChatLogin(opId),
    connectTelegram: (token, rotate) => Service.connectTelegram(token, rotate),
    selectEntry: (channel) => Service.selectEntry(channel),
    status: () => Service.status(),
    exportDiagnostics: () => Service.exportDiagnostics(),
    probeModel: (provider, model, key) => Service.probeModel(provider, model, key),
    subscribeLoginStatus: (listener) => events.loginStatus.on(listener),
  };
}

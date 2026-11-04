// Production adapter. This is the only production module that imports the
// generated MyGo client. Tests use src/testing/fixtures.ts instead.
import { Service, events } from "../mygo";
import type { ClientService, ThemeSource } from "./types";

export function createProductionClient(): ClientService {
  return {
    name: () => Service.name(),
    // Go owns the value, so this cast is the trust boundary: SetTheme rejects
    // anything but the three sources before it can be stored.
    theme: async () => (await Service.theme()) as ThemeSource,
    setTheme: (source) => Service.setTheme(source),
    cloudflareStatus: () => Service.cloudflareStatus(),
    startCloudflareLogin: () => Service.startCloudflareLogin(),
    cancelCloudflareLogin: (opId) => Service.cancelCloudflareLogin(opId),
    confirmCloudflareAccount: (accountId) => Service.confirmCloudflareAccount(accountId),
    subscribeCloudflareLogin: (listener) => events.cloudflareLogin.on(listener),
    disconnectCloudflare: () => Service.disconnectCloudflare(),
    listWorkers: () => Service.listWorkers(),
    selectDeployment: (scriptName) => Service.selectDeployment(scriptName),
    inspectImport: () => Service.inspectImport(),
    confirmImport: (input) => Service.confirmImport(input),
    install: (input) => Service.install(input),
    upgradeAvailable: () => Service.upgradeAvailable(),
    upgrade: () => Service.upgrade(),
    checkClientUpdates: () => Service.checkClientUpdates(),
    getConfig: () => Service.getConfig(),
    modelCatalog: () => Service.modelCatalog(),
    mcpCatalog: () => Service.mcpCatalog(),
    addMcpServer: (input) => Service.addMcpServer(input),
    updateMcpServer: (name, server, secrets) =>
      Service.updateMcpServer(name, server, secrets),
    removeMcpServer: (name) => Service.removeMcpServer(name),
    probeMcp: (name) => Service.probeMcp(name),
    mcpStatus: () => Service.mcpStatus(),
    startMcpOAuth: (name) => Service.startMcpOAuth(name),
    previewConfig: (input) => Service.previewConfig(input),
    publishConfig: (input) => Service.publishConfig(input),
    resumeOperation: (id) => Service.resumeOperation(id),
    abandonOperation: (id) => Service.abandonOperation(id),
    pendingOperations: () => Service.pendingOperations(),
    startWeChatLogin: () => Service.startWeChatLogin(),
    cancelWeChatLogin: (opId) => Service.cancelWeChatLogin(opId),
    connectTelegram: (token, rotate) => Service.connectTelegram(token, rotate),
    selectEntry: (channel) => Service.selectEntry(channel),
    status: () => Service.status(),
    exportDiagnostics: () => Service.exportDiagnostics(),
    probeModel: (provider, model, key, api, baseUrl) =>
      Service.probeModel(provider, model, key, api, baseUrl),
    subscribeLoginStatus: (listener) => events.loginStatus.on(listener),
    exportData: () => Service.exportData(),
    chooseBackup: () => Service.chooseBackup(),
    restoreData: () => Service.restoreData(),
    pendingRestore: () => Service.pendingRestore(),
    retryRestore: (useSnapshot) => Service.retryRestore(useSnapshot),
    abandonPendingRestore: () => Service.abandonPendingRestore(),
    subscribeBackupProgress: (listener) => events.backupProgress.on(listener),
  };
}

// Production adapter. This is the only production module that imports the
// generated MyGo client. Tests use src/testing/fixtures.ts instead.
import { Service, events } from "../mygo";
import type {
  ClientService,
  Locale,
  LocaleDTO,
  LocaleSource,
  ThemeSource,
} from "./types";

export function createProductionClient(): ClientService {
  return {
    name: () => Service.name(),
    // Go owns the value, so this cast is the trust boundary: SetTheme rejects
    // anything but the three sources before it can be stored.
    theme: async () => (await Service.theme()) as ThemeSource,
    setTheme: (source) => Service.setTheme(source),
    // Same trust boundary as the theme: Go only ever returns these values.
    locale: async () => toLocaleDTO(await Service.locale()),
    setLocale: async (source) => toLocaleDTO(await Service.setLocale(source)),
    telemetryEnabled: () => Service.telemetryEnabled(),
    setTelemetryEnabled: (enabled) => Service.setTelemetryEnabled(enabled),
    bootState: () => Service.bootState(),
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
    probeSSHHost: (input) => Service.probeSSHHost(input),
    connectSSHHost: (input, fingerprint) =>
      Service.connectSSHHost(input, fingerprint),
    detectLocalRuntimes: () => Service.detectLocalRuntimes(),
    // Go rejects any engine name but these two before it runs a command.
    connectLocal: (engine) => Service.connectLocal(engine),
    containerPreflight: () => Service.containerPreflight(),
    installContainer: (input) => Service.installContainer(input),
    adoptContainer: () => Service.adoptContainer(),
    containerStatus: () => Service.containerStatus(),
    restoreContainerConfig: () => Service.restoreContainerConfig(),
    disconnectContainer: () => Service.disconnectContainer(),
    onContainerProgress: (listener) => events.containerProgress.on(listener),
    upgradeAvailable: () => Service.upgradeAvailable(),
    upgrade: () => Service.upgrade(),
    checkClientUpdates: () => Service.checkClientUpdates(),
    getConfig: () => Service.getConfig(),
    cachedConfig: () => Service.cachedConfig(),
    modelCatalog: () => Service.modelCatalog(),
    mcpCatalog: () => Service.mcpCatalog(),
    addMcpServer: (input) => Service.addMcpServer(input),
    updateMcpServer: (name, server, secrets) =>
      Service.updateMcpServer(name, server, secrets),
    removeMcpServer: (name) => Service.removeMcpServer(name),
    probeMcp: (name) => Service.probeMcp(name),
    testExchange: (accountId) => Service.testExchange(accountId),
    syncExchange: (accountId) => Service.syncExchange(accountId),
    exchangeSyncStatus: () => Service.exchangeSyncStatus(),
    walletStatus: () => Service.walletStatus(),
    lifeVitals: () => Service.lifeVitals(),
    saveWallet: (input) => Service.saveWallet(input),
    mcpStatus: () => Service.mcpStatus(),
    startMcpOAuth: (name) => Service.startMcpOAuth(name),
    previewConfig: (input) => Service.previewConfig(input),
    publishConfig: (input) => Service.publishConfig(input),
    resumeOperation: (id) => Service.resumeOperation(id),
    abandonOperation: (id) => Service.abandonOperation(id),
    pendingOperations: () => Service.pendingOperations(),
    startWeChatLogin: () => Service.startWeChatLogin(),
    cancelWeChatLogin: (opId) => Service.cancelWeChatLogin(opId),
    connectTelegram: (token) => Service.connectTelegram(token),
    selectEntry: (channel) => Service.selectEntry(channel),
    status: () => Service.status(),
    cachedStatus: () => Service.cachedStatus(),
    exportDiagnostics: () => Service.exportDiagnostics(),
    probeModel: (provider, model, key, api, baseUrl) =>
      Service.probeModel(provider, model, key, api, baseUrl),
    subscribeLoginStatus: (listener) => events.loginStatus.on(listener),
    exportData: () => Service.exportData(),
    backupSettings: () => Service.backupSettings(),
    saveBackupSettings: (input) => Service.saveBackupSettings(input),
    chooseBackupDir: () => Service.chooseBackupDir(),
    openBackupFolder: () => Service.openBackupFolder(),
    listBackups: () => Service.listBackups(),
    chooseBackupAt: (path) => Service.chooseBackupAt(path),
    chooseBackup: () => Service.chooseBackup(),
    restoreData: () => Service.restoreData(),
    pendingRestore: () => Service.pendingRestore(),
    retryRestore: (useSnapshot) => Service.retryRestore(useSnapshot),
    abandonPendingRestore: () => Service.abandonPendingRestore(),
    subscribeBackupProgress: (listener) => events.backupProgress.on(listener),
  };
}

function toLocaleDTO(value: { source: string; resolved: string }): LocaleDTO {
  return {
    source: value.source as LocaleSource,
    resolved: value.resolved as Locale,
  };
}

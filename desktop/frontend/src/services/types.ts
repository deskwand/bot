// Type-only view of the generated MyGo client. Importing this module never
// loads the MyGo runtime; the production adapter is the only place that does.
import type {
  AccountDTO,
  BackupFileDTO,
  BackupPreviewDTO,
  BackupSettingsDTO,
  BackupSettingsEditDTO,
  BackupSummaryDTO,
  BootStateDTO,
  CachedConfigDTO,
  CachedStatusDTO,
  CloudflareLoginDTO,
  ConfigDTO,
  ConfigEditDTO as GeneratedConfigEditDTO,
  ConnectionDTO,
  ContainerCheckDTO,
  ContainerExistingDTO,
  ContainerInstallInputDTO as GeneratedContainerInstallInputDTO,
  ContainerPreflightDTO,
  ContainerStatusDTO,
  CustomModelDTO,
  CustomProviderDTO,
  EntryResultDTO,
  ExchangeAccountDTO,
  ExchangeProbeDTO,
  ExchangeSyncDTO,
  ImportInputDTO as GeneratedImportInputDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LifeSourceDTO,
  LifeVitalsDTO,
  LoginStatusDTO,
  McpAddInput,
  McpAuthDTO,
  McpCatalogEntryDTO,
  McpCustomInput,
  McpFieldDTO,
  McpHeaderInput,
  McpProbeDTO,
  McpToolDTO,
  ModelCatalogDTO,
  ModelDTO,
  ModelEntryDTO,
  ModelProviderDTO,
  OperationDTO,
  PendingRestoreDTO,
  PlaintextSecretDTO,
  Progress,
  ResultDTO,
  SecretNameDTO,
  SSHHostInputDTO,
  SSHProbeDTO,
  StatusItemDTO,
  StepDTO,
  UpgradeDTO,
  WalletStatusDTO,
  WorkerDTO,
} from "../mygo";

export type {
  AccountDTO,
  BackupFileDTO,
  BackupPreviewDTO,
  BackupSettingsDTO,
  BackupSettingsEditDTO,
  BackupSummaryDTO,
  BootStateDTO,
  CachedConfigDTO,
  CachedStatusDTO,
  CloudflareLoginDTO,
  ConfigDTO,
  ConnectionDTO,
  ContainerCheckDTO,
  ContainerExistingDTO,
  ContainerPreflightDTO,
  ContainerStatusDTO,
  CustomModelDTO,
  CustomProviderDTO,
  EntryResultDTO,
  ExchangeAccountDTO,
  ExchangeProbeDTO,
  ExchangeSyncDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LifeSourceDTO,
  LifeVitalsDTO,
  LoginStatusDTO,
  McpAddInput,
  McpAuthDTO,
  McpCatalogEntryDTO,
  McpCustomInput,
  McpFieldDTO,
  McpHeaderInput,
  McpProbeDTO,
  McpToolDTO,
  ModelCatalogDTO,
  ModelDTO,
  ModelEntryDTO,
  ModelProviderDTO,
  OperationDTO,
  PendingRestoreDTO,
  PlaintextSecretDTO,
  Progress,
  ResultDTO,
  SecretNameDTO,
  SSHHostInputDTO,
  SSHProbeDTO,
  StatusItemDTO,
  StepDTO,
  UpgradeDTO,
  WalletStatusDTO,
  WorkerDTO,
};

/**
 * Write-only secret edit. The generated client currently widens `secrets` to
 * `unknown[]` because the Go DTO is write-only; this adapter restores the typed
 * shape the UI uses without importing the MyGo runtime.
 */
export interface SecretEditDTO {
  name: string;
  operation: string;
  value?: string;
}

/**
 * Write-only wallet edit. Empty fields stay unchanged, so changing only the
 * RPC URL never rewrites a secret; the private key is never read back.
 */
export interface WalletEditDTO {
  privateKey?: string;
  ownerAddress?: string;
  rpcUrl?: string;
}

export interface ImportSecretDTO {
  name: string;
  value: string;
}

export type ConfigEditDTO = Omit<GeneratedConfigEditDTO, "secrets"> & {
  secrets?: SecretEditDTO[];
};

export type ContainerInstallInputDTO = Omit<
  GeneratedContainerInstallInputDTO,
  "secrets"
> & {
  secrets: SecretEditDTO[];
};

export type ImportInputDTO = Omit<GeneratedImportInputDTO, "secrets"> & {
  secrets?: ImportSecretDTO[];
};

/** The appearance the client stores. Go rejects anything else. */
export type ThemeSource = "system" | "light" | "dark";

/** The language preference the client stores. Go rejects anything else. */
export type LocaleSource = "system" | "zh" | "en";

/** The language the UI shows. */
export type Locale = "zh" | "en";

export interface LocaleDTO {
  source: LocaleSource;
  resolved: Locale;
}

/**
 * The narrow application-service surface consumed by the UI. It mirrors the
 * bound Service methods exactly, so a Go DTO change only requires updating this
 * file and the production adapter.
 */
export interface ClientService {
  name(): Promise<string>;
  theme(): Promise<ThemeSource>;
  setTheme(source: ThemeSource): Promise<void>;
  locale(): Promise<LocaleDTO>;
  setLocale(source: LocaleSource): Promise<LocaleDTO>;
  telemetryEnabled(): Promise<boolean>;
  setTelemetryEnabled(enabled: boolean): Promise<void>;
  bootState(): Promise<BootStateDTO>;
  cloudflareStatus(): Promise<ConnectionDTO>;
  startCloudflareLogin(): Promise<string>;
  cancelCloudflareLogin(opId: string): Promise<void>;
  confirmCloudflareAccount(accountId: string): Promise<void>;
  subscribeCloudflareLogin(listener: (status: CloudflareLoginDTO) => void): () => void;
  disconnectCloudflare(): Promise<void>;
  listWorkers(): Promise<WorkerDTO[]>;
  selectDeployment(scriptName: string): Promise<void>;
  inspectImport(): Promise<ImportPreviewDTO>;
  confirmImport(input: ImportInputDTO): Promise<ResultDTO>;
  install(input: InstallInputDTO): Promise<ResultDTO>;
  probeSSHHost(input: SSHHostInputDTO): Promise<SSHProbeDTO>;
  connectSSHHost(
    input: SSHHostInputDTO,
    fingerprint: string,
  ): Promise<ContainerPreflightDTO>;
  containerPreflight(): Promise<ContainerPreflightDTO>;
  installContainer(input: ContainerInstallInputDTO): Promise<ResultDTO>;
  adoptContainer(): Promise<ResultDTO>;
  containerStatus(): Promise<ContainerStatusDTO>;
  restoreContainerConfig(): Promise<ResultDTO>;
  disconnectContainer(): Promise<void>;
  onContainerProgress(listener: (step: StepDTO) => void): () => void;
  upgradeAvailable(): Promise<UpgradeDTO>;
  upgrade(): Promise<ResultDTO>;
  checkClientUpdates(): Promise<void>;
  getConfig(): Promise<ConfigDTO>;
  cachedConfig(): Promise<CachedConfigDTO>;
  modelCatalog(): Promise<ModelCatalogDTO>;
  mcpCatalog(): Promise<McpCatalogEntryDTO[]>;
  addMcpServer(input: McpAddInput): Promise<ResultDTO>;
  updateMcpServer(
    name: string,
    server: unknown,
    secrets: SecretEditDTO[],
  ): Promise<ResultDTO>;
  removeMcpServer(name: string): Promise<ResultDTO>;
  probeMcp(name: string): Promise<McpProbeDTO>;
  testExchange(accountId: string): Promise<ExchangeProbeDTO>;
  syncExchange(accountId: string): Promise<ExchangeSyncDTO>;
  exchangeSyncStatus(): Promise<ExchangeSyncDTO[]>;
  walletStatus(): Promise<WalletStatusDTO>;
  lifeVitals(): Promise<LifeVitalsDTO>;
  saveWallet(input: WalletEditDTO): Promise<ResultDTO>;
  mcpStatus(): Promise<McpAuthDTO[]>;
  startMcpOAuth(name: string): Promise<void>;
  previewConfig(input: ConfigEditDTO): Promise<StepDTO[]>;
  publishConfig(input: ConfigEditDTO): Promise<ResultDTO>;
  resumeOperation(id: string): Promise<ResultDTO>;
  abandonOperation(id: string): Promise<ResultDTO>;
  pendingOperations(): Promise<OperationDTO[]>;
  startWeChatLogin(): Promise<string>;
  cancelWeChatLogin(opId: string): Promise<void>;
  connectTelegram(token: string): Promise<ResultDTO>;
  selectEntry(channel: string): Promise<EntryResultDTO>;
  status(): Promise<StatusItemDTO[]>;
  cachedStatus(): Promise<CachedStatusDTO>;
  exportDiagnostics(): Promise<string>;
  probeModel(
    provider: string,
    model: string,
    key: string,
    api: string,
    baseUrl: string,
  ): Promise<StatusItemDTO>;
  subscribeLoginStatus(listener: (status: LoginStatusDTO) => void): () => void;
  exportData(): Promise<BackupSummaryDTO | null>;
  backupSettings(): Promise<BackupSettingsDTO>;
  saveBackupSettings(input: BackupSettingsEditDTO): Promise<BackupSettingsDTO>;
  chooseBackupDir(): Promise<BackupSettingsDTO>;
  openBackupFolder(): Promise<void>;
  listBackups(): Promise<BackupFileDTO[]>;
  chooseBackupAt(path: string): Promise<BackupPreviewDTO | null>;
  chooseBackup(): Promise<BackupPreviewDTO | null>;
  restoreData(): Promise<void>;
  pendingRestore(): Promise<PendingRestoreDTO | null>;
  retryRestore(useSnapshot: boolean): Promise<void>;
  abandonPendingRestore(): Promise<void>;
  subscribeBackupProgress(listener: (progress: Progress) => void): () => void;
}

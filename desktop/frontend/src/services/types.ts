// Type-only view of the generated MyGo client. Importing this module never
// loads the MyGo runtime; the production adapter is the only place that does.
import type {
  AccountDTO,
  ClientUpdateDTO,
  ClientUpdateResultDTO,
  ConfigDTO,
  ConfigEditDTO as GeneratedConfigEditDTO,
  ConnectionDTO,
  EntryResultDTO,
  ImportInputDTO as GeneratedImportInputDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LoginStatusDTO,
  ModelDTO,
  OperationDTO,
  PlaintextSecretDTO,
  ResultDTO,
  SecretNameDTO,
  StatusItemDTO,
  StepDTO,
  UpgradeDTO,
  WorkerDTO,
} from "../mygo";

export type {
  AccountDTO,
  ClientUpdateDTO,
  ClientUpdateResultDTO,
  ConfigDTO,
  ConnectionDTO,
  EntryResultDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LoginStatusDTO,
  ModelDTO,
  OperationDTO,
  PlaintextSecretDTO,
  ResultDTO,
  SecretNameDTO,
  StatusItemDTO,
  StepDTO,
  UpgradeDTO,
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

export interface ImportSecretDTO {
  name: string;
  value: string;
}

export type ConfigEditDTO = Omit<GeneratedConfigEditDTO, "secrets"> & {
  secrets?: SecretEditDTO[];
};

export type ImportInputDTO = Omit<GeneratedImportInputDTO, "secrets"> & {
  secrets?: ImportSecretDTO[];
};

/**
 * The narrow application-service surface consumed by the UI. It mirrors the
 * bound Service methods exactly, so a Go DTO change only requires updating this
 * file and the production adapter.
 */
export interface ClientService {
  name(): Promise<string>;
  cloudflareStatus(): Promise<ConnectionDTO>;
  connectCloudflare(accountId: string, token: string): Promise<AccountDTO>;
  disconnectCloudflare(): Promise<void>;
  openTokenPage(): Promise<void>;
  listWorkers(): Promise<WorkerDTO[]>;
  selectDeployment(scriptName: string): Promise<void>;
  inspectImport(): Promise<ImportPreviewDTO>;
  confirmImport(input: ImportInputDTO): Promise<ResultDTO>;
  install(input: InstallInputDTO): Promise<ResultDTO>;
  upgradeAvailable(): Promise<UpgradeDTO>;
  upgrade(): Promise<ResultDTO>;
  checkClientUpdate(): Promise<ClientUpdateDTO>;
  installClientUpdate(): Promise<ClientUpdateResultDTO>;
  getConfig(): Promise<ConfigDTO>;
  previewConfig(input: ConfigEditDTO): Promise<StepDTO[]>;
  publishConfig(input: ConfigEditDTO): Promise<ResultDTO>;
  resumeOperation(id: string): Promise<ResultDTO>;
  abandonOperation(id: string): Promise<ResultDTO>;
  pendingOperations(): Promise<OperationDTO[]>;
  startWeChatLogin(): Promise<string>;
  cancelWeChatLogin(opId: string): Promise<void>;
  connectTelegram(token: string, rotate: boolean): Promise<ResultDTO>;
  selectEntry(channel: string): Promise<EntryResultDTO>;
  status(): Promise<StatusItemDTO[]>;
  exportDiagnostics(): Promise<string>;
  probeModel(provider: string, model: string, key: string): Promise<StatusItemDTO>;
  subscribeLoginStatus(listener: (status: LoginStatusDTO) => void): () => void;
}

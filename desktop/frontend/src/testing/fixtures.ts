// Mock ClientService used only by the Vite test entry (test.html). The
// production entry never imports this module; a Playwright test asserts the
// built bundle contains no fixture router.
import type {
  BackupPreviewDTO,
  BackupSummaryDTO,
  CloudflareLoginDTO,
  ConfigDTO,
  ConfigEditDTO,
  CustomProviderDTO,
  EntryResultDTO,
  ImportInputDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LoginStatusDTO,
  McpAddInput,
  McpAuthDTO,
  McpCatalogEntryDTO,
  McpProbeDTO,
  McpToolDTO,
  ModelCatalogDTO,
  ModelDTO,
  OperationDTO,
  PendingRestoreDTO,
  Progress,
  ResultDTO,
  StatusItemDTO,
  StepDTO,
  ThemeSource,
  WorkerDTO,
} from "../services/types";
import type { ClientService } from "../services/types";

type Scenario =
  | "default"
  | "cf-denied"
  | "cf-timeout"
  | "cf-slow-apply"
  | "cf-slow-apply-fail"
  | "cf-signout-failed"
  | "multi-account"
  | "credential-denied"
  | "store-unavailable"
  | "config-conflict"
  | "multi-version"
  | "upgrade-required"
  | "upgrade-keys-missing"
  | "model-key-missing"
  | "client-update-available"
  | "client-update-unavailable"
  | "catalog-unavailable"
  | "pending-operations"
  | "pending-other-account"
  | "version-unknown"
  | "install-conflict"
  | "import-resume"
  | "import-secret-retry"
  | "configured"
  | "qr-expired"
  | "qr-publish-failed"
  | "login-sync"
  | "entry-unknown"
  | "entry-unchanged"
  | "diagnostics-unknown"
  | "user-evidence"
  | "verified-local"
  | "backup"
  | "backup-progress"
  | "backup-version-mismatch"
  | "backup-pending"
  | "backup-pending-corrupt"
  | "backup-pending-unavailable"
  | "backup-restore-snapshot-failed"
  | "backup-restore-midway-failed"
  | "mcp-many-tools"
  | "mcp-admin-unavailable";

interface MockState {
  scenario: Scenario;
  theme: ThemeSource;
  connected: boolean;
  accountId: string;
  target: string | null;
  fingerprint: string;
  configPresent: boolean;
  activeChannel: string;
  ownerUserIds: number[];
  butlerModel: ModelDTO | null;
  taskModel: ModelDTO | null;
  customProviders: CustomProviderDTO[];
  secrets: Record<string, boolean>;
  mcpServers: MockMcpServer[];
  mcpAuth: Record<string, string>;
  installAttempts: number;
  pending: OperationDTO[];
  loginTimers: Map<string, number[]>;
}

const NOW = "2026-11-02T09:00:00Z";

type MockMcpServer = {
  name: string;
  url: string;
  description?: string;
  catalogId?: string;
  oauth?: boolean;
  enabled?: boolean;
  approvalPolicy?: string;
  autoApprove?: string[];
  requireApproval?: string[];
  disabledTools?: string[];
  headers?: Record<string, string>;
};

const MCP_CATALOG: McpCatalogEntryDTO[] = [
  {
    id: "deepwiki",
    name: "DeepWiki",
    category: "开发",
    description: "DeepWiki：GitHub 仓库的 AI 文档与问答",
    oauth: false,
    fields: [],
  },
  {
    id: "github",
    name: "GitHub",
    category: "开发",
    description: "GitHub：仓库、issue、PR 与代码检索",
    oauth: false,
    fields: [
      {
        key: "token",
        label: "Personal Access Token",
        help: "GitHub 个人访问令牌。",
        helpUrl: "https://github.com/settings/tokens",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    category: "文档 / 知识",
    description: "Notion：页面、数据库与工作区内容",
    oauth: true,
    fields: [],
  },
];

const MCP_TOOLS: Record<string, McpToolDTO[]> = {
  deepwiki: [
    { name: "read_wiki_structure", description: "读取仓库 wiki 目录", mode: "auto" },
    { name: "ask_question", description: "向仓库提问", mode: "approval" },
  ],
  github: [
    { name: "get_file_contents", description: "读取仓库文件", mode: "auto" },
    { name: "create_issue", description: "创建 issue", mode: "approval" },
  ],
  notion: [
    { name: "search_pages", description: "搜索页面", mode: "auto" },
    { name: "create_page", description: "创建页面", mode: "approval" },
  ],
};

function mcpToolMode(server: MockMcpServer, tool: McpToolDTO): string {
  if (server.disabledTools?.includes(tool.name)) return "disabled";
  if (server.requireApproval?.includes(tool.name)) return "approval";
  if (server.autoApprove?.includes(tool.name)) return "auto";
  return tool.mode;
}

const BACKUP_SUMMARY: BackupSummaryDTO = {
  path: "deskwand-backup-deskwand-bot-20261102-090000.zip",
  exportedAt: "2026-11-02T09:00:00Z",
  release: "1.1.0",
  rows: 1280,
  tasks: 4,
  objects: 12,
  bytes: 1234567,
  oversized: [],
};

const MODELS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  openrouter: ["anthropic/claude-sonnet-5-5"],
  "opencode-go": [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "glm-5.3",
    "kimi-k3",
    "qwen3.8-max",
    "gpt-5.6-luna",
  ],
};

const CATALOG: ModelCatalogDTO = {
  providers: [
    {
      id: "workers-ai",
      name: "Cloudflare Workers AI（免费额度）",
      keyless: true,
      models: [
        {
          id: "@cf/zai-org/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          input: ["text", "image"],
        },
        { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash", input: ["text"] },
      ],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      models: [
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (New)" },
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "kimi-k3", name: "Kimi K3" },
        { id: "qwen3.8-max", name: "Qwen3.8 Max" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
      ],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [
        { id: "deepseek-flash", name: "DeepSeek Flash" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      models: [
        { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      ],
    },
  ],
};

function scenarioFromLocation(): Scenario {
  const value = new URLSearchParams(window.location.search).get("fixture");
  switch (value) {
    case "cf-denied":
    case "cf-timeout":
    case "cf-slow-apply":
    case "cf-slow-apply-fail":
    case "cf-signout-failed":
    case "multi-account":
    case "credential-denied":
    case "store-unavailable":
    case "config-conflict":
    case "multi-version":
    case "upgrade-required":
    case "upgrade-keys-missing":
    case "model-key-missing":
    case "client-update-available":
    case "client-update-unavailable":
    case "catalog-unavailable":
    case "pending-operations":
    case "pending-other-account":
    case "version-unknown":
    case "install-conflict":
    case "import-resume":
    case "import-secret-retry":
    case "configured":
    case "qr-expired":
    case "qr-publish-failed":
    case "login-sync":
    case "entry-unknown":
    case "entry-unchanged":
    case "diagnostics-unknown":
    case "user-evidence":
    case "verified-local":
    case "backup":
    case "backup-progress":
    case "backup-version-mismatch":
    case "backup-pending":
    case "backup-pending-corrupt":
    case "backup-pending-unavailable":
    case "backup-restore-snapshot-failed":
    case "backup-restore-midway-failed":
    case "mcp-many-tools":
    case "mcp-admin-unavailable":
      return value;
    default:
      return "default";
  }
}

function initialState(): MockState {
  const scenario = scenarioFromLocation();
  const configured = scenario === "configured";
  const shellScenario = [
    "config-conflict",
    "multi-version",
    "upgrade-required",
    "upgrade-keys-missing",
    "model-key-missing",
    "client-update-available",
    "client-update-unavailable",
    "pending-operations",
    "pending-other-account",
    "version-unknown",
    "configured",
    "qr-expired",
    "qr-publish-failed",
    "login-sync",
    "entry-unknown",
    "entry-unchanged",
    "diagnostics-unknown",
    "user-evidence",
    "verified-local",
    "cf-signout-failed",
    "backup",
    "backup-progress",
    "backup-version-mismatch",
    "backup-pending",
    "backup-pending-corrupt",
    "backup-pending-unavailable",
    "backup-restore-snapshot-failed",
    "backup-restore-midway-failed",
    "mcp-many-tools",
    "mcp-admin-unavailable",
  ].includes(scenario);
  return {
    scenario,
    theme: "system",
    connected: shellScenario,
    accountId: "a".repeat(32),
    target: shellScenario ? "deskwand-bot" : null,
    fingerprint: "fp-current",
    configPresent: shellScenario,
    activeChannel: scenario === "user-evidence" ? "wechat" : "",
    ownerUserIds: configured ? [100000001] : [],
    butlerModel: shellScenario
      ? { provider: "opencode-go", id: "deepseek-v4.1-flash" }
      : null,
    taskModel: shellScenario
      ? { provider: "opencode-go", id: "deepseek-v4.1-flash" }
      : null,
    customProviders: [],
    secrets: {
      MODEL_KEY_OPENCODE_GO: shellScenario,
      MODEL_KEY_ANTHROPIC: false,
      TELEGRAM_BOT_TOKEN: false,
      TELEGRAM_WEBHOOK_SECRET: false,
      WECHAT_CREDENTIALS: scenario === "user-evidence",
    },
    mcpServers:
      scenario === "mcp-many-tools"
        ? [
            {
              name: "deepwiki",
              url: "https://mcp.deepwiki.com/mcp",
              catalogId: "deepwiki",
              description: "DeepWiki：GitHub 仓库的 AI 文档与问答",
              approvalPolicy: "writes",
            },
          ]
        : [],
    mcpAuth: {},
    installAttempts: 0,
    pending:
      scenario === "pending-operations" || scenario === "pending-other-account"
        ? [
            {
              operationId: "op-pending-1",
              kind: "install",
              // A journal survives sign-out, so this operation can belong to
              // an account that is no longer connected.
              accountId: scenario === "pending-other-account" ? "b".repeat(32) : "a".repeat(32),
              workerName: "deskwand-bot",
              state: "unknown",
              steps: [
                { id: "stage", state: "completed", message: "已上传配置版本", evidence: "mock" },
                { id: "activate", state: "unknown", message: "激活响应丢失", evidence: "mock" },
              ],
              createdAt: NOW,
              updatedAt: NOW,
            },
          ]
        : [],
    loginTimers: new Map(),
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function steps(...labels: string[]): StepDTO[] {
  return labels.map((label, index) => ({
    id: `step-${index + 1}`,
    state: index === labels.length - 1 ? "completed" : "completed",
    message: label,
    evidence: "mock",
  }));
}

function published(opId: string, extra: Partial<ResultDTO> = {}): ResultDTO {
  return {
    operationId: opId,
    deploymentId: "deploy-1",
    versionId: "version-2",
    state: "published",
    workerName: "deskwand-bot",
    releaseVersion: "1.1.0",
    steps: steps("校验变更", "上传配置版本", "激活部署", "核实部署结果"),
    ...extra,
  };
}

function unknownResult(opId: string): ResultDTO {
  return {
    operationId: opId,
    deploymentId: "",
    versionId: "",
    state: "unknown",
    workerName: "deskwand-bot",
    steps: [
      { id: "stage", state: "completed", message: "已上传配置版本", evidence: "mock" },
      { id: "activate", state: "unknown", message: "激活响应丢失", evidence: "mock" },
    ],
    warnings: ["上次操作结果未知。继续操作会先核实远端状态，不会盲目重发。"],
  };
}

export function createMockClient(): ClientService {
  const state = initialState();
  const listeners = new Set<(status: LoginStatusDTO) => void>();
  const cfListeners = new Set<(status: CloudflareLoginDTO) => void>();
  const backupListeners = new Set<(progress: Progress) => void>();
  const backupCalls = { restore: 0, retry: [] as boolean[], choose: 0, abandon: 0 };
  (
    window as unknown as {
      __backupCalls?: {
        restore: number;
        retry: boolean[];
        choose: number;
        abandon: number;
      };
    }
  ).__backupCalls = backupCalls;
  const configCalls = {
    install: [] as InstallInputDTO[],
    publish: [] as ConfigEditDTO[],
  };
  (
    window as unknown as {
      __configCalls?: typeof configCalls;
    }
  ).__configCalls = configCalls;
  const mcpCalls = {
    update: [] as { name: string; server: MockMcpServer; secrets: unknown[] }[],
    remove: [] as string[],
    start: [] as string[],
  };
  (
    window as unknown as {
      __mcpCalls?: typeof mcpCalls;
    }
  ).__mcpCalls = mcpCalls;
  let pendingAbandoned = false;
  let restoreAttempts = 0;
  let cfOperationID = "";
  const emitCloudflare = (status: CloudflareLoginDTO) => {
    for (const listener of cfListeners) listener(status);
  };
  const statusItems = () => statusItemsFor(state);
  let sequence = 0;

  const emit = (status: LoginStatusDTO) => {
    for (const listener of listeners) listener(status);
  };

  const config = (): ConfigDTO => {
    if (!state.target) fail("TARGET_NOT_SELECTED", "请先选择一个 Worker 部署");
    if (state.scenario === "multi-version") {
      fail(
        "MULTI_VERSION_DEPLOYMENT",
        "该部署有 3 个版本正在接收流量，客户端停止编辑以避免危险覆盖。",
      );
    }
    return {
      accountId: state.accountId,
      workerName: state.target,
      fingerprint: state.fingerprint,
      releaseVersion: "1.1.0",
      activeVersionCount: 1,
      configPresent: state.configPresent,
      activeChannel: state.activeChannel,
      ownerUserIds: [...state.ownerUserIds],
      butlerModel: state.butlerModel,
      taskModel: state.taskModel,
      customProviders: state.customProviders,
      mcpServers: state.mcpServers,
      secrets: Object.keys(state.secrets)
        .sort()
        .map((name) => ({ name, configured: state.secrets[name] === true })),
    };
  };

  const applyEdit = (input: ConfigEditDTO) => {
    if (state.scenario === "config-conflict") {
      fail(
        "CONFIG_CONFLICT",
        "云端配置指纹已变化，当前草稿基于旧版本。请重新加载后再提交。",
      );
    }
    if (input.ownerUserIds) state.ownerUserIds = [...input.ownerUserIds];
    if (input.butlerModel) state.butlerModel = { ...input.butlerModel };
    if (input.taskModel) state.taskModel = { ...input.taskModel };
    if (input.customProviders) state.customProviders = [...input.customProviders];
    for (const edit of input.secrets ?? []) {
      if (edit.operation === "clear") state.secrets[edit.name] = false;
      if (edit.operation === "replace") state.secrets[edit.name] = true;
    }
    state.fingerprint = `fp-${++sequence}`;
    state.configPresent = true;
  };

  const plannedSteps = (input: ConfigEditDTO): StepDTO[] => {
    const list: StepDTO[] = [
      { id: "validate", state: "planned", message: "校验配置 schema 与模型引用" },
      { id: "conflict", state: "planned", message: "核对云端配置指纹" },
    ];
    for (const edit of input.secrets ?? []) {
      list.push({
        id: `secret-${edit.name}`,
        state: "planned",
        message:
          edit.operation === "clear"
            ? `清除 secret ${edit.name}`
            : edit.operation === "replace"
              ? `替换 secret ${edit.name}`
              : `保留 secret ${edit.name}`,
      });
    }
    list.push(
      { id: "stage", state: "planned", message: "上传新配置版本（继承未编辑字段）" },
      { id: "activate", state: "planned", message: "激活 100% 流量部署" },
      { id: "verify", state: "planned", message: "读取部署并核对版本与指纹" },
    );
    return list;
  };

  const clearLogin = (opId: string) => {
    const timers = state.loginTimers.get(opId) ?? [];
    for (const timer of timers) window.clearTimeout(timer);
    state.loginTimers.delete(opId);
  };

  return {
    async name() {
      return "DeskWand Bot";
    },

    async theme(): Promise<ThemeSource> {
      return state.theme;
    },

    async setTheme(next: ThemeSource) {
      if (next !== "system" && next !== "light" && next !== "dark") {
        fail("INVALID_REQUEST", "外观设置无效");
      }
      state.theme = next;
    },

    async cloudflareStatus() {
      if (state.scenario === "store-unavailable") return { state: "unavailable" };
      // A real status read has to ask Cloudflare for the deployment, which
      // takes visible time right after login.
      const slow = state.connected && state.scenario === "cf-slow-apply";
      const slowAndFailing = state.connected && state.scenario === "cf-slow-apply-fail";
      if (slow || slowAndFailing) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      if (slowAndFailing) {
        return { state: "unavailable" };
      }
      return state.connected
        ? { state: "connected", accountId: state.accountId, accountName: "测试账户" }
        : { state: "disconnected" };
    },

    async startCloudflareLogin() {
      const operationId = `login-cf-${++sequence}`;
      cfOperationID = operationId;
      queueMicrotask(() => emitCloudflare({ operationId, state: "waiting_browser" }));
      if (state.scenario === "cf-denied") {
        queueMicrotask(() =>
          emitCloudflare({ operationId, state: "denied", code: "AUTH_OAUTH_DENIED" }),
        );
        return operationId;
      }
      if (state.scenario === "cf-timeout") {
        queueMicrotask(() =>
          emitCloudflare({ operationId, state: "timeout", code: "AUTH_OAUTH_TIMEOUT" }),
        );
        return operationId;
      }
      if (state.scenario === "credential-denied") {
        queueMicrotask(() =>
          emitCloudflare({
            operationId,
            state: "error",
            code: "CREDENTIAL_STORE_UNAVAILABLE",
          }),
        );
        return operationId;
      }
      queueMicrotask(() => {
        if (state.scenario === "multi-account") {
          emitCloudflare({
            operationId,
            state: "select_account",
            accounts: [
              { id: state.accountId, name: "测试账户" },
              { id: "b".repeat(32), name: "第二个账户" },
            ],
          });
          return;
        }
        state.connected = true;
        emitCloudflare({ operationId, state: "connected" });
      });
      return operationId;
    },
    async cancelCloudflareLogin() {},
    async confirmCloudflareAccount(accountId: string) {
      state.accountId = accountId;
      state.connected = true;
      emitCloudflare({ operationId: cfOperationID, state: "connected" });
    },
    subscribeCloudflareLogin(listener) {
      cfListeners.add(listener);
      return () => {
        cfListeners.delete(listener);
      };
    },

    async disconnectCloudflare() {
      if (state.scenario === "cf-signout-failed") {
        // Talking to the keychain takes visible time; failing immediately
        // would hide the in-flight state the dialog has to keep coherent.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        fail("CREDENTIAL_STORE_UNAVAILABLE", "无法删除本机凭据");
      }
      state.connected = false;
      state.target = null;
    },

    async listWorkers(): Promise<WorkerDTO[]> {
      return [
        { name: "deskwand-bot-old", modifiedOn: NOW, migrationTag: "v1" },
        { name: "my-bot", modifiedOn: NOW, migrationTag: "legacy" },
      ];
    },

    async selectDeployment(scriptName) {
      state.target = scriptName;
    },

    async inspectImport(): Promise<ImportPreviewDTO> {
      if (!state.target) fail("TARGET_NOT_SELECTED", "请先选择 Worker");
      const legacy = state.target === "my-bot";
      return {
        accountId: state.accountId,
        workerName: state.target,
        releaseVersion: legacy ? "" : "1.1.0",
        legacy,
        configPresent: !legacy,
        ownerConfigured: !legacy,
        modelsConfigured: !legacy,
        activeChannel: legacy ? "" : "telegram",
        secretNames: ["MODEL_KEY_ANTHROPIC", "WECHAT_CREDENTIALS"],
        preserveSecretNames: ["MODEL_KEY_ANTHROPIC", "WECHAT_CREDENTIALS"],
        plaintextSecrets: legacy
          ? [
              {
                field: "mcpServers[0].headers.Authorization",
                secretName: "MCP_HEADER_AUTHORIZATION",
                reference: "env:MCP_HEADER_AUTHORIZATION",
              },
            ]
          : [],
        requiredInputs: legacy
          ? ["telegramUserIds", "butlerModel", "taskModel", "MCP_HEADER_AUTHORIZATION"]
          : [],
        warnings: legacy
          ? ["旧版源码配置无法读取，需要重新填写 owner 与角色模型。"]
          : [],
      };
    },

    async confirmImport(input: ImportInputDTO) {
      if (input.telegramUserIds) state.ownerUserIds = [...input.telegramUserIds];
      if (input.butlerModel) state.butlerModel = { ...input.butlerModel };
      if (input.taskModel) state.taskModel = { ...input.taskModel };
      if (state.scenario === "import-secret-retry") {
        const provided = (input.secrets ?? []).some(
          (secret) => secret.name === "MCP_HEADER_AUTHORIZATION" && secret.value.length > 0,
        );
        if (!provided) {
          fail(
            "PLAINTEXT_SECRET_DETECTED",
            "配置中仍有明文凭据，请重新输入迁移 secret 的值。",
          );
        }
      }
      for (const secret of input.secrets ?? []) {
        if (secret.name) state.secrets[secret.name] = secret.value.length > 0;
      }
      state.configPresent = true;
      state.activeChannel = state.activeChannel || "telegram";
      if (state.scenario === "import-resume") {
        return {
          ...unknownResult("op-import-resume"),
          workerName: state.target ?? "deskwand-bot",
          warnings: ["导入激活响应丢失，请继续核实远端状态。"],
        };
      }
      return published("op-import-1");
    },

    async install(input: InstallInputDTO) {
      configCalls.install.push(input);
      if (state.scenario === "install-conflict") {
        fail(
          "OPERATION_IN_PROGRESS",
          "同一部署已有安装操作正在进行，请先用顶部“继续”处理。",
        );
      }
      state.installAttempts += 1;
      if (state.installAttempts === 1) {
        state.pending = [
          {
            operationId: "op-install-1",
            kind: "install",
            accountId: state.accountId,
            workerName: "deskwand-bot",
            state: "unknown",
            steps: unknownResult("op-install-1").steps,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ];
        return unknownResult("op-install-1");
      }
      state.target = "deskwand-bot";
      state.configPresent = true;
      return published("op-install-1");
    },

    async upgradeAvailable() {
      if (state.scenario === "version-unknown") {
        return {
          available: false,
          currentVersion: "",
          availableVersion: "1.1.0",
          reason: "VERSION_UNKNOWN_REIMPORT",
        };
      }
      return {
        available: true,
        currentVersion: "1.0.0",
        availableVersion: "1.1.0",
        modelKeysMissing:
          state.scenario === "upgrade-keys-missing"
            ? ["MODEL_KEY_OPENCODE_GO"]
            : undefined,
      };
    },

    async upgrade() {
      return published("op-upgrade-1");
    },

    async checkClientUpdate() {
      if (state.scenario === "client-update-unavailable") {
        return {
          state: "not_configured",
          currentVersion: "0.1.0",
          reason: "CLIENT_UPDATE_NOT_CONFIGURED",
          message: "未配置更新源",
        };
      }
      return {
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        notes: "客户端更新测试发行说明",
        date: NOW,
      };
    },

    async installClientUpdate() {
      if (state.scenario === "client-update-unavailable") {
        fail("CLIENT_UPDATE_NOT_CONFIGURED", "未配置更新源");
      }
      return {
        state: "installed",
        currentVersion: "0.1.0",
        version: "0.2.0",
        message: "客户端更新已安装，重启客户端后生效",
      };
    },

    async getConfig() {
      return config();
    },

    async mcpCatalog() {
      return MCP_CATALOG;
    },

    async addMcpServer(input: McpAddInput) {
      const name = input.name.trim();
      if (!/^[a-z0-9_]{1,32}$/.test(name)) {
        fail("INVALID_REQUEST", "服务名称只能使用小写字母、数字和下划线（1-32 个字符）");
      }
      if (state.mcpServers.some((server) => server.name === name)) {
        fail("INVALID_REQUEST", "已存在同名服务");
      }
      let server: MockMcpServer;
      if (input.custom) {
        const url = input.custom.url.trim();
        if (!url) fail("INVALID_REQUEST", "请填写服务 URL");
        const headers: Record<string, string> = {};
        for (const header of input.custom.headers ?? []) {
          if (!header.name.trim()) continue;
          if (!header.value?.trim()) fail("INVALID_REQUEST", `请填写 header ${header.name} 的值`);
          headers[header.name] = header.secret
            ? `env:MCP_${name.toUpperCase()}_${header.name.toUpperCase().replaceAll("-", "_")}`
            : header.value;
        }
        server = {
          name,
          url,
          oauth: input.custom.oauth,
          description: "自定义服务",
          approvalPolicy: "writes",
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        };
      } else {
        const entry = MCP_CATALOG.find((item) => item.id === input.catalogId);
        if (!entry) fail("INVALID_REQUEST", "服务目录中没有该条目");
        for (const field of entry.fields) {
          if (!input.values?.[field.key]?.trim()) {
            fail("INVALID_REQUEST", `${entry.name}：请填写${field.label}`);
          }
        }
        server = {
          name,
          url:
            entry.id === "deepwiki"
              ? "https://mcp.deepwiki.com/mcp"
              : entry.id === "github"
                ? "https://api.githubcopilot.com/mcp/"
                : "https://mcp.notion.com/mcp",
          description: entry.description,
          catalogId: entry.id,
          oauth: entry.oauth,
          approvalPolicy: "writes",
          autoApprove: [],
          requireApproval: [],
          ...(entry.id === "github"
            ? { headers: { Authorization: "env:MCP_GITHUB_TOKEN" } }
            : {}),
        };
      }
      state.mcpServers.push(server);
      if (server.oauth) state.mcpAuth[name] = "unauthorized";
      return published(`op-mcp-add-${++sequence}`);
    },

    async updateMcpServer(name: string, server: unknown, secrets: unknown[]) {
      mcpCalls.update.push({
        name,
        server: server as MockMcpServer,
        secrets,
      });
      const index = state.mcpServers.findIndex((entry) => entry.name === name);
      if (index < 0) fail("INVALID_REQUEST", "服务不存在");
      state.mcpServers[index] = server as MockMcpServer;
      state.fingerprint = `fp-${++sequence}`;
      return published(`op-mcp-update-${sequence}`);
    },

    async removeMcpServer(name: string) {
      mcpCalls.remove.push(name);
      state.mcpServers = state.mcpServers.filter((server) => server.name !== name);
      delete state.mcpAuth[name];
      return published(`op-mcp-remove-${++sequence}`);
    },

    async probeMcp(name: string): Promise<McpProbeDTO> {
      const server = state.mcpServers.find((entry) => entry.name === name);
      if (!server) fail("INVALID_REQUEST", "服务不存在");
      if (server.oauth && state.mcpAuth[name] !== "ok") {
        return {
          ok: false,
          auth: state.mcpAuth[name] ?? "unauthorized",
          reason: "需要在桌面端登录授权",
          tools: [],
        };
      }
      const base =
        state.scenario === "mcp-many-tools"
          ? Array.from({ length: 101 }, (_, index) => ({
              name: `tool_${index + 1}`,
              description: `工具 ${index + 1}`,
              mode: "auto",
            }))
          : (MCP_TOOLS[server.catalogId ?? ""] ?? MCP_TOOLS.deepwiki ?? []);
      return {
        ok: true,
        tools: base.map((tool) => ({ ...tool, mode: mcpToolMode(server, tool) })),
      };
    },

    async mcpStatus(): Promise<McpAuthDTO[]> {
      if (state.scenario === "mcp-admin-unavailable") {
        fail(
          "MCP_ADMIN_UNAVAILABLE",
          "无法连接云端管理接口，请检查 PUBLIC_BASE_URL 与部署状态",
        );
      }
      return state.mcpServers
        .filter((server) => server.oauth)
        .map((server) => ({
          name: server.name,
          state: state.mcpAuth[server.name] ?? "unauthorized",
        }));
    },

    async startMcpOAuth(name: string) {
      mcpCalls.start.push(name);
      state.mcpAuth[name] = state.mcpAuth[name] ?? "unauthorized";
      window.setTimeout(() => {
        if (state.mcpServers.some((server) => server.name === name)) {
          state.mcpAuth[name] = "ok";
        }
      }, 1200);
    },

    async previewConfig(input: ConfigEditDTO) {
      if (state.scenario === "config-conflict") {
        fail(
          "CONFIG_CONFLICT",
          "云端配置指纹已变化，当前草稿基于旧版本。请重新加载后再提交。",
        );
      }
      if (state.scenario === "upgrade-required") {
        fail("UPGRADE_REQUIRED", "请先在“更新”页升级云端服务。");
      }
      return plannedSteps(input);
    },

    async publishConfig(input: ConfigEditDTO) {
      configCalls.publish.push(input);
      if (state.scenario === "upgrade-required") {
        fail("UPGRADE_REQUIRED", "请先在“更新”页升级云端服务。");
      }
      if (state.scenario === "model-key-missing") {
        fail("MODEL_KEY_MISSING", "缺少模型 key：MODEL_KEY_DEEPSEEK");
      }
      applyEdit(input);
      const result = published(`op-publish-${sequence}`);
      return result;
    },

    async resumeOperation(id: string) {
      state.pending = [];
      if (id === "op-import-resume") {
        state.configPresent = true;
        state.activeChannel = state.activeChannel || "telegram";
        return published("op-import-resume");
      }
      if (id.startsWith("publish-op") || id === "op-entry-resume") {
        state.secrets.WECHAT_CREDENTIALS = true;
        state.activeChannel = "wechat";
        return published("op-resumed-publish");
      }
      state.target = state.target ?? "deskwand-bot";
      state.configPresent = true;
      return published("op-install-1");
    },

    async abandonOperation(id: string) {
      state.pending = state.pending.filter((operation) => operation.operationId !== id);
      return {
        operationId: id,
        state: "cancelled",
        workerName: state.target ?? "deskwand-bot",
        steps: [
          { id: "cancel", state: "cancelled", message: "操作已取消", evidence: "mock" },
        ],
      };
    },

    async pendingOperations() {
      return [...state.pending];
    },

    async startWeChatLogin() {
      const opId = `wx-${++sequence}`;
      const timers: number[] = [];
      state.loginTimers.set(opId, timers);
      const qr = `https://weixin.qq.com/x/deskwand-login-${opId}`;
      const emitWaiting = () => {
        emit({ operationId: opId, state: "wait", qrContent: qr, message: "请用微信扫描二维码" });
      };
      if (state.scenario === "login-sync") {
        // Emits before the promise resolves, exercising first-event adoption.
        emitWaiting();
      } else {
        timers.push(window.setTimeout(emitWaiting, 60));
      }
      if (state.scenario === "qr-expired") {
        timers.push(
          window.setTimeout(() => {
            emit({
              operationId: opId,
              state: "expired",
              message: "二维码已过期，请重新扫码",
            });
            clearLogin(opId);
          }, 420),
        );
        return opId;
      }
      timers.push(
        window.setTimeout(() => {
          emit({ operationId: opId, state: "scaned", message: "已扫码，请在手机上确认" });
        }, 300),
      );
      timers.push(
        window.setTimeout(() => {
          emit({ operationId: opId, state: "confirmed", message: "手机已确认，正在保存凭据" });
          timers.push(
            window.setTimeout(() => {
              if (state.scenario === "qr-publish-failed") {
                emit({
                  operationId: `publish-op-${sequence}`,
                  state: "publish_failed",
                  message: "CONFIG_CONFLICT；可在恢复操作中继续",
                  code: "CONFIG_CONFLICT",
                });
              } else {
                state.secrets.WECHAT_CREDENTIALS = true;
                state.activeChannel = "wechat";
                emit({
                  operationId: `publish-op-${sequence}`,
                  state: "published",
                  message: "登录成功，微信凭据已发布",
                });
              }
              clearLogin(opId);
            }, 500),
          );
        }, 800),
      );
      return opId;
    },

    async cancelWeChatLogin(opId) {
      clearLogin(opId);
      emit({ operationId: opId, state: "cancelled", message: "登录已取消" });
    },

    async connectTelegram(token, _rotate) {
      if (token.trim().length < 6 || /wrong/i.test(token)) {
        throw new Error("telegram: bot token was rejected");
      }
      state.secrets.TELEGRAM_BOT_TOKEN = true;
      state.secrets.TELEGRAM_WEBHOOK_SECRET = true;
      return published("op-telegram-1", {
        activeChannel: state.activeChannel || "telegram",
        steps: steps("校验 Bot Token", "发布 secret", "设置 webhook", "核实部署"),
      });
    },

    async selectEntry(channel: string): Promise<EntryResultDTO> {
      if (channel !== "telegram" && channel !== "wechat") {
        fail("INVALID_ENTRY_CHANNEL", "入口必须是 telegram 或 wechat");
      }
      state.activeChannel = channel;
      const configured =
        channel === "wechat"
          ? state.secrets.WECHAT_CREDENTIALS === true
          : state.secrets.TELEGRAM_BOT_TOKEN === true;
      if (state.scenario === "entry-unchanged") {
        return {
          state: "unchanged",
          channel,
          configured,
        };
      }
      if (state.scenario === "entry-unknown") {
        return {
          operationId: "op-entry-resume",
          state: "unknown",
          channel,
          configured,
          warning: "激活响应丢失，请继续核实远端状态。",
        };
      }
      return {
        operationId: `op-entry-${++sequence}`,
        deploymentId: "deploy-1",
        versionId: "version-2",
        state: "published",
        channel,
        configured,
        warning: configured
          ? undefined
          : `已选择${channel === "wechat" ? "微信" : "Telegram"}，但该入口尚未完成配置，会暂时不可用。客户端不会自动切换。`,
      };
    },

    async status() {
      return statusItems();
    },

    async exportDiagnostics() {
      return JSON.stringify({ exportedAt: NOW, items: statusItems() }, null, 2);
    },

    async modelCatalog() {
      if (state.scenario === "catalog-unavailable") {
        fail("CATALOG_UNAVAILABLE", "无法读取模型目录，请检查网络后重试。");
      }
      return CATALOG;
    },

    async probeModel(provider, model, key, api, baseUrl) {
      if (!key.trim()) {
        throw new Error("请输入要测试的 API 密钥；已有 secret 不可读。");
      }
      if (!api && !baseUrl && !MODELS[provider]?.includes(model)) {
        throw new Error("不支持的模型提供商或模型 ID。");
      }
      return {
        kind: "model",
        state: "unverified",
        source: "local",
        observedAt: new Date().toISOString(),
        detail: "probe_ok（本机探测，不代表云端收发正常）",
      };
    },

    subscribeLoginStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async exportData(): Promise<BackupSummaryDTO | null> {
      if (!state.target) fail("TARGET_NOT_SELECTED", "请先选择一个 Worker 部署");
      if (state.scenario === "backup-progress") {
        for (const listener of backupListeners) {
          listener({
            op: "export",
            phase: "database",
            tables: 3,
            rows: 120,
            objects: 0,
            totalObjects: 0,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return BACKUP_SUMMARY;
    },

    async chooseBackup(): Promise<BackupPreviewDTO | null> {
      if (!state.target) fail("TARGET_NOT_SELECTED", "请先选择一个 Worker 部署");
      backupCalls.choose += 1;
      if (state.scenario === "backup-version-mismatch") {
        return {
          summary: { ...BACKUP_SUMMARY, release: "1.2.0" },
          currentRelease: "1.3.0",
          problem: "BACKUP_VERSION_MISMATCH",
        };
      }
      return { summary: BACKUP_SUMMARY, currentRelease: "1.1.0" };
    },

    async restoreData() {
      if (!state.target) fail("TARGET_NOT_SELECTED", "请先选择一个 Worker 部署");
      backupCalls.restore += 1;
      restoreAttempts += 1;
      if (
        state.scenario === "backup-restore-snapshot-failed" &&
        restoreAttempts === 1
      ) {
        fail("RESTORE_SNAPSHOT_FAILED", "恢复前快照失败，云端数据未改动。");
      }
      if (
        state.scenario === "backup-restore-midway-failed" &&
        restoreAttempts === 1
      ) {
        fail("BACKUP_INVALID", "恢复在中途失败。");
      }
    },

    async pendingRestore(): Promise<PendingRestoreDTO | null> {
      if (pendingAbandoned) return null;
      if (state.scenario === "backup-pending-corrupt") {
        fail("RESTORE_JOURNAL_CORRUPT", "本机恢复记录无法读取。");
      }
      if (state.scenario === "backup-pending-unavailable") {
        fail("ADMIN_UNAVAILABLE", "云端服务尚不支持数据备份。");
      }
      if (
        state.scenario !== "backup-pending" &&
        state.scenario !== "backup-restore-midway-failed"
      ) {
        return null;
      }
      if (
        state.scenario === "backup-restore-midway-failed" &&
        restoreAttempts === 0
      ) {
        return null;
      }
      return {
        operationId: "op-restore-pending",
        backupPath: "/tmp/deskwand-backup-deskwand-bot-20261102-090000.zip",
        snapshotPath: "/tmp/backups/pre-restore-20261102-090500.zip",
        state: state.scenario === "backup-pending" ? "failed" : "running",
        failureCode: "MAINTENANCE_REQUIRED",
      };
    },

    async retryRestore(useSnapshot: boolean) {
      backupCalls.retry.push(useSnapshot);
    },

    async abandonPendingRestore() {
      backupCalls.abandon += 1;
      pendingAbandoned = true;
    },

    subscribeBackupProgress(listener) {
      backupListeners.add(listener);
      return () => {
        backupListeners.delete(listener);
      };
    },
  };
}

function statusItemsFor(state: MockState): StatusItemDTO[] {
      if (state.scenario === "user-evidence") {
        return [
          {
            kind: "model",
            state: "configured",
            source: "config",
            observedAt: NOW,
            detail: "已配置；尚无当前版本的云端日志",
          },
          {
            kind: "wechat",
            state: "verified",
            source: "user",
            observedAt: NOW,
            detail: "user_confirmed（用户确认，非云端日志）",
          },
        ];
      }
      if (state.scenario === "verified-local") {
        // Contract violation from the bridge: a "verified" state backed by a
        // local probe. The UI must not render it as verified delivery.
        return [
          {
            kind: "wechat",
            state: "verified",
            source: "local",
            observedAt: NOW,
            detail: "probe_ok（本机探测，不代表云端收发正常）",
          },
        ];
      }
      if (state.scenario === "diagnostics-unknown") {
        return ["model", "telegram", "wechat"].map((kind) => ({
          kind,
          state: "unknown",
          source: "",
          observedAt: NOW,
          detail: "未找到可用证据（日志可能未保存或被采样）",
        }));
      }
      const items: StatusItemDTO[] = [
        {
          kind: "model",
          state: state.butlerModel ? "configured" : "unknown",
          source: state.butlerModel ? "config" : "",
          observedAt: NOW,
          detail: state.butlerModel
            ? "已配置；尚无当前版本的云端日志"
            : "未找到可用证据（日志可能未保存或被采样）",
        },
      ];
      for (const [kind, secret] of [
        ["telegram", "TELEGRAM_BOT_TOKEN"],
        ["wechat", "WECHAT_CREDENTIALS"],
      ] as const) {
        items.push({
          kind,
          state: state.secrets[secret] ? "configured" : "unavailable",
          source: state.secrets[secret] ? "config" : "",
          observedAt: NOW,
          detail: state.secrets[secret]
            ? "已配置；尚无当前版本的云端日志"
            : "未找到可用证据（日志可能未保存或被采样）",
        });
      }
      return items;
}

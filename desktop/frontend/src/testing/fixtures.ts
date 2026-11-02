// Mock ClientService used only by the Vite test entry (test.html). The
// production entry never imports this module; a Playwright test asserts the
// built bundle contains no fixture router.
import type {
  ConfigDTO,
  ConfigEditDTO,
  EntryResultDTO,
  ImportInputDTO,
  ImportPreviewDTO,
  InstallInputDTO,
  LoginStatusDTO,
  ModelDTO,
  OperationDTO,
  ResultDTO,
  StatusItemDTO,
  StepDTO,
  WorkerDTO,
} from "../services/types";
import type { ClientService } from "../services/types";

type Scenario =
  | "default"
  | "wrong-token"
  | "credential-denied"
  | "store-unavailable"
  | "config-conflict"
  | "multi-version"
  | "upgrade-required"
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
  | "user-evidence";

interface MockState {
  scenario: Scenario;
  connected: boolean;
  accountId: string;
  target: string | null;
  fingerprint: string;
  configPresent: boolean;
  activeChannel: string;
  ownerUserIds: number[];
  butlerModel: ModelDTO | null;
  taskModel: ModelDTO | null;
  secrets: Record<string, boolean>;
  installAttempts: number;
  pending: OperationDTO[];
  loginTimers: Map<string, number[]>;
}

const NOW = "2026-11-02T09:00:00Z";

const MODELS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  "opencode-go": [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "glm-5.3",
    "kimi-k3",
    "qwen3.8-max",
    "gpt-5.6-luna",
  ],
};

function scenarioFromLocation(): Scenario {
  const value = new URLSearchParams(window.location.search).get("fixture");
  switch (value) {
    case "wrong-token":
    case "credential-denied":
    case "store-unavailable":
    case "config-conflict":
    case "multi-version":
    case "upgrade-required":
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
    "configured",
    "qr-expired",
    "qr-publish-failed",
    "login-sync",
    "entry-unknown",
    "entry-unchanged",
    "diagnostics-unknown",
    "user-evidence",
  ].includes(scenario);
  return {
    scenario,
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
    secrets: {
      OPENCODE_API_KEY: shellScenario,
      ANTHROPIC_API_KEY: false,
      TELEGRAM_BOT_TOKEN: false,
      TELEGRAM_WEBHOOK_SECRET: false,
      WECHAT_CREDENTIALS: scenario === "user-evidence",
    },
    installAttempts: 0,
    pending: [],
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

    async cloudflareStatus() {
      if (state.scenario === "store-unavailable") return { state: "unavailable" };
      return state.connected
        ? { state: "connected", accountId: state.accountId }
        : { state: "disconnected" };
    },

    async connectCloudflare(accountId, token) {
      if (state.scenario === "credential-denied") {
        fail(
          "CREDENTIAL_STORE_UNAVAILABLE",
          "系统凭据库不可用，未保存 API token。",
        );
      }
      if (
        state.scenario === "wrong-token" ||
        /wrong|invalid/i.test(token) ||
        token.trim().length < 8
      ) {
        fail("AUTH_INVALID_TOKEN", "Cloudflare 拒绝了这个 API token（HTTP 403）。");
      }
      if (!/^[a-f0-9]{32}$/i.test(accountId.trim())) {
        fail("AUTH_INVALID_ACCOUNT_ID", "Cloudflare 账户 ID 应为 32 位十六进制字符。");
      }
      state.connected = true;
      state.accountId = accountId.trim();
      return { id: state.accountId, name: "测试账户" };
    },

    async disconnectCloudflare() {
      state.connected = false;
      state.target = null;
    },

    async openTokenPage() {
      return;
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
        secretNames: ["ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"],
        preserveSecretNames: ["ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"],
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

    async install(_input: InstallInputDTO) {
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
      return {
        available: true,
        currentVersion: "1.0.0",
        availableVersion: "1.1.0",
      };
    },

    async upgrade() {
      return published("op-upgrade-1");
    },

    async getConfig() {
      return config();
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
      if (state.scenario === "upgrade-required") {
        fail("UPGRADE_REQUIRED", "请先在“更新”页升级云端服务。");
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

    async probeModel(provider, model, key) {
      if (!key.trim()) {
        throw new Error("请输入要测试的 API 密钥；已有 secret 不可读。");
      }
      if (!MODELS[provider]?.includes(model)) {
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

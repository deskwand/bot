import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, FolderOpen, Loader2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeCode } from "@/services/errors";
import type {
  BackupFileDTO,
  BackupPreviewDTO,
  BackupSettingsDTO,
  BackupSettingsEditDTO,
  BackupSummaryDTO,
  PendingRestoreDTO,
  Progress,
} from "@/services/types";

const SENSITIVE_NOTICE =
  "备份已保存。文件未加密，包含记忆、对话和微信会话上下文，请妥善保管。";

const OVERWRITE_NOTICE =
  "将清空当前部署的全部业务数据并替换为备份内容；恢复前会自动保存当前数据快照；备份时正在运行的任务恢复后可能重复执行外部动作。";

const PHASE_LABELS: Record<string, string> = {
  preparing: "准备中",
  database: "导出数据库",
  objects: "传输产物",
  finishing: "收尾",
  clearing: "清理",
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatExportedAt(value: string): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function problemMessage(preview: BackupPreviewDTO): string | null {
  if (!preview.problem) return null;
  if (preview.problem === "BACKUP_VERSION_MISMATCH") {
    return `备份来自版本 ${preview.summary.release}，当前部署是 ${preview.currentRelease}。请先把云端升级或降级到 ${preview.summary.release} 再恢复。`;
  }
  return describeCode(preview.problem);
}

export function Backup() {
  const { client } = useApp();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportSummary, setExportSummary] = useState<BackupSummaryDTO | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);

  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<BackupPreviewDTO | null>(null);
  const [chooseError, setChooseError] = useState<unknown>(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoreDone, setRestoreDone] = useState(false);
  const [pending, setPending] = useState<PendingRestoreDTO | null>(null);

  const [settings, setSettings] = useState<BackupSettingsDTO | null>(null);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [files, setFiles] = useState<BackupFileDTO[]>([]);
  const [filesError, setFilesError] = useState<unknown>(null);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await client.backupSettings());
      setSettingsError(null);
    } catch (cause) {
      setSettingsError(cause);
    }
  }, [client]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await client.listBackups());
      setFilesError(null);
    } catch (cause) {
      setFilesError(cause);
    }
  }, [client]);

  useEffect(() => {
    void refreshSettings();
    void refreshFiles();
  }, [refreshFiles, refreshSettings]);

  // "finishing" is the last phase the exporter reports, and by then the archive
  // is renamed into place. A background auto backup produces no other signal,
  // so without this an open page would keep saying "还没有" after one ran.
  useEffect(
    () =>
      client.subscribeBackupProgress((next) => {
        setProgress(next);
        if (next.op === "export" && next.phase === "finishing") {
          void refreshFiles();
          void refreshSettings();
        }
      }),
    [client, refreshFiles, refreshSettings],
  );

  const refreshPending = useCallback(async () => {
    try {
      setPending(await client.pendingRestore());
    } catch {
      setPending(null);
    }
  }, [client]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  const exportData = useCallback(async () => {
    setExportRunning(true);
    setExportError(null);
    setExportSummary(null);
    setProgress(null);
    try {
      const summary = await client.exportData();
      if (summary) setExportSummary(summary);
      await Promise.all([refreshSettings(), refreshFiles()]);
    } catch (cause) {
      setExportError(cause);
    } finally {
      setExportRunning(false);
    }
  }, [client, refreshFiles, refreshSettings]);

  const openFolder = useCallback(async () => {
    setFolderBusy(true);
    setSettingsError(null);
    try {
      await client.openBackupFolder();
    } catch (cause) {
      setSettingsError(cause);
    } finally {
      setFolderBusy(false);
    }
  }, [client]);

  const changeFolder = useCallback(async () => {
    setFolderBusy(true);
    setSettingsError(null);
    try {
      setSettings(await client.chooseBackupDir());
      await refreshFiles();
    } catch (cause) {
      setSettingsError(cause);
    } finally {
      setFolderBusy(false);
    }
  }, [client, refreshFiles]);

  const patchSettings = useCallback(
    async (patch: Partial<BackupSettingsEditDTO>) => {
      if (!settings) return;
      const next: BackupSettingsEditDTO = {
        dir: settings.dir,
        auto: settings.auto,
        intervalHours: settings.intervalHours,
        keep: settings.keep,
        ...patch,
      };
      setSavingSettings(true);
      setSettingsError(null);
      try {
        setSettings(await client.saveBackupSettings(next));
      } catch (cause) {
        setSettingsError(cause);
        await refreshSettings();
      } finally {
        setSavingSettings(false);
      }
    },
    [client, refreshSettings, settings],
  );

  const restoreFile = useCallback(
    async (path: string) => {
      setChooseError(null);
      setRestoreError(null);
      setRestoreDone(false);
      try {
        const next = await client.chooseBackupAt(path);
        if (next) setPreview(next);
      } catch (cause) {
        setChooseError(cause);
      }
    },
    [client],
  );

  const chooseBackup = useCallback(async () => {
    setChoosing(true);
    setChooseError(null);
    setPreview(null);
    setRestoreError(null);
    setRestoreDone(false);
    try {
      const next = await client.chooseBackup();
      if (next) setPreview(next);
    } catch (cause) {
      setChooseError(cause);
    } finally {
      setChoosing(false);
    }
  }, [client]);

  const restoreData = useCallback(async () => {
    setRestoreOpen(false);
    setRestoreRunning(true);
    setRestoreError(null);
    setRestoreDone(false);
    try {
      await client.restoreData();
      setRestoreDone(true);
      setPending(null);
    } catch (cause) {
      setRestoreError(cause);
      // A failure after the destructive step leaves a journal record; a
      // snapshot/file failure does not. The retry action below depends on it.
      await refreshPending();
    } finally {
      setRestoreRunning(false);
    }
  }, [client, refreshPending]);

  const retryRestore = useCallback(async () => {
    if (!pending) {
      // Pre-write failure (file/snapshot): the service consumed the chosen
      // path, so select the file again and show the normal preview.
      await chooseBackup();
      return;
    }
    setRestoreRunning(true);
    setRestoreError(null);
    setRestoreDone(false);
    try {
      // The journal protects the second write; never re-open the dialog with
      // a path the service no longer has.
      await client.retryRestore(false);
      setRestoreDone(true);
      setPending(null);
    } catch (cause) {
      setRestoreError(cause);
      await refreshPending();
    } finally {
      setRestoreRunning(false);
    }
  }, [chooseBackup, client, pending, refreshPending]);

  const blocked = preview ? problemMessage(preview) : null;
  const canRestore = Boolean(preview) && !blocked;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">维护</p>
          <h1 className="text-2xl font-semibold tracking-tight">数据备份</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            导出云端数据，或从备份整体恢复。备份未加密，请妥善保管。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void exportData()} disabled={exportRunning}>
            {exportRunning ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
            立即备份
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void openFolder()}
            disabled={folderBusy}
          >
            <FolderOpen aria-hidden />
            打开目录
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void chooseBackup()}
            disabled={choosing || restoreRunning}
          >
            {choosing ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Upload aria-hidden />
            )}
            从本地恢复
          </Button>
        </div>
      </div>

      <ErrorAlert error={exportError} onRetry={exportData} retryLabel="重新导出" />
      <ErrorAlert error={chooseError} onRetry={chooseBackup} retryLabel="重新选择备份" />
      <ErrorAlert error={settingsError} onRetry={refreshSettings} retryLabel="重新读取备份设置" />

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>备份位置</CardTitle>
          <CardDescription>
            每次备份都写到这里；开着客户端时按间隔自动备份。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 break-all font-mono text-xs" data-testid="backup-dir">
              {settings ? settings.dir : "读取中…"}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void openFolder()}
              disabled={folderBusy}
            >
              打开目录
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void changeFolder()}
              disabled={folderBusy}
            >
              更改…
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={settings?.auto ? "secondary" : "outline"}
              aria-pressed={settings?.auto ?? false}
              disabled={!settings || savingSettings}
              onClick={() => void patchSettings({ auto: !settings?.auto })}
            >
              自动备份：{settings?.auto ? "开" : "关"}
            </Button>
            <Select
              value={String(settings?.intervalHours ?? 24)}
              onValueChange={(value) => void patchSettings({ intervalHours: Number(value) })}
              disabled={!settings || savingSettings}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="备份间隔">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">每 1 小时</SelectItem>
                <SelectItem value="6">每 6 小时</SelectItem>
                <SelectItem value="24">每 24 小时</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(settings?.keep ?? 5)}
              onValueChange={(value) => void patchSettings({ keep: Number(value) })}
              disabled={!settings || savingSettings}
            >
              <SelectTrigger size="sm" className="w-28" aria-label="保留份数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">保留 1 份</SelectItem>
                <SelectItem value="5">保留 5 份</SelectItem>
                <SelectItem value="10">保留 10 份</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            上次成功：
            {settings?.lastSuccessAt ? formatExportedAt(settings.lastSuccessAt) : "还没有"}
            {settings?.lastErrorCode
              ? ` · 最近失败：${describeCode(settings.lastErrorCode)}${
                  settings.lastErrorMessage ? `（${settings.lastErrorMessage}）` : ""
                }`
              : ""}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>导出</CardTitle>
          <CardDescription>
            不含部署配置和密钥。期间消息暂停，最长约 15 分钟。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {progress ? (
            <div
              className="rounded-md border border-border p-3 text-sm"
              data-testid="backup-progress"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{progress.op === "restore" ? "恢复" : "导出"}</Badge>
                <span className="font-medium">{phaseLabel(progress.phase)}</span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                <span>表 {progress.tables}</span>
                <span>行 {progress.rows}</span>
                <span>
                  对象 {progress.objects}
                  {progress.totalObjects ? ` / ${progress.totalObjects}` : ""}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">还没有导出过。</p>
          )}

          {exportSummary ? (
            <div className="mt-3 space-y-1 text-sm">
              <p className="font-medium">备份已保存到 {exportSummary.path}</p>
              <p className="text-xs text-muted-foreground">
                {formatExportedAt(exportSummary.exportedAt)} · 版本 {exportSummary.release || "未知"} ·{" "}
                {exportSummary.rows} 行 · {exportSummary.tasks} 个任务 · {exportSummary.objects} 个产物 ·{" "}
                {formatBytes(exportSummary.bytes)}
              </p>
              {exportSummary.oversized.length > 0 ? (
                <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {exportSummary.oversized.length} 个产物超过 100 MiB，未导出；这份备份不能直接恢复：
                  {exportSummary.oversized.join("、")}
                </p>
              ) : null}
            </div>
          ) : null}

          {exportSummary ? (
            <Alert className="mt-4">
              <AlertTitle>导出完成</AlertTitle>
              <AlertDescription>{SENSITIVE_NOTICE}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>本地备份</CardTitle>
          <CardDescription>
            按时间从新到旧；选一份即可恢复，不用再开文件对话框。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorAlert error={filesError} onRetry={refreshFiles} retryLabel="重新读取备份列表" />
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">这个目录里还没有备份。</p>
          ) : (
            <ul className="space-y-2" data-testid="backup-file-list">
              {files.map((file) => (
                <li
                  key={file.path}
                  data-testid="backup-file"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
                >
                  <div className="min-w-0">
                    <p className="break-all font-mono text-xs">{file.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatExportedAt(file.modifiedAt)} · {formatBytes(file.bytes)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={choosing || restoreRunning}
                    onClick={() => void restoreFile(file.path)}
                  >
                    恢复这份
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>恢复</CardTitle>
          <CardDescription>
            只能恢复到同一版本。开始前会自动保存当前数据快照。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">恢复摘要</span>
                  <Badge variant="outline">版本 {preview.summary.release || "未知"}</Badge>
                  {preview.problem ? <Badge variant="destructive">{preview.problem}</Badge> : null}
                </div>
                <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <div className="break-all sm:col-span-2">{preview.summary.path}</div>
                  <div>导出时间：{formatExportedAt(preview.summary.exportedAt)}</div>
                  <div>当前部署版本：{preview.currentRelease || "未知"}</div>
                  <div>数据行数：{preview.summary.rows}</div>
                  <div>任务数：{preview.summary.tasks}</div>
                  <div>产物数：{preview.summary.objects}</div>
                  <div>文件大小：{formatBytes(preview.summary.bytes)}</div>
                </dl>
                {preview.summary.oversized.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    备份里有超大产物：{preview.summary.oversized.join("、")}
                  </p>
                ) : null}
              </div>

              {blocked ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>无法恢复这个备份</AlertTitle>
                  <AlertDescription>{blocked}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={blocked ? "outline" : "destructive"}
                  onClick={() => setRestoreOpen(true)}
                  disabled={!canRestore || restoreRunning}
                >
                  {restoreRunning ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  覆盖并恢复
                </Button>
                <span className="text-xs text-muted-foreground">
                  失败时可回到恢复前快照。
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              选择一个备份后显示摘要。
            </p>
          )}

          <ErrorAlert
            error={restoreError}
            onRetry={() => void retryRestore()}
            retryLabel={pending ? "重试未完成恢复" : "重新选择备份"}
          />

          {restoreDone ? (
            <Alert className="mt-4">
              <AlertTitle>恢复完成</AlertTitle>
              <AlertDescription>数据已恢复。</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认覆盖恢复</DialogTitle>
            <DialogDescription>{OVERWRITE_NOTICE}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreOpen(false)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void restoreData()}>
              确认覆盖恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

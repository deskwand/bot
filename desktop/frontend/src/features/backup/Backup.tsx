import { PageHeader } from "@/components/page-header";
import { MoveCard } from "@/features/backup/MoveCard";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Upload } from "lucide-react";
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
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { formatDateTime, getT, useT, type MessageKey } from "@/i18n";
import { queryKeys, useContainerStatusQuery, useInvalidate } from "@/services/queries";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeCode, toClientError } from "@/services/errors";
import type {
  BackupFileDTO,
  BackupPreviewDTO,
  BackupSettingsDTO,
  BackupSettingsEditDTO,
  BackupSummaryDTO,
  PendingRestoreDTO,
  Progress,
} from "@/services/types";

const PHASE_KEYS: Record<string, MessageKey> = {
  preparing: "backup.phasePreparing",
  database: "backup.phaseDatabase",
  objects: "backup.phaseObjects",
  finishing: "backup.phaseFinishing",
  clearing: "backup.phaseClearing",
};

function phaseLabel(phase: string): string {
  const key = PHASE_KEYS[phase];
  return key ? getT()(key) : phase;
}

const WARNING_KEYS: Record<string, MessageKey> = {
  BACKUP_RELEASE_UNKNOWN: "backup.warningReleaseUnknownBackup",
  TARGET_RELEASE_UNKNOWN: "backup.warningReleaseUnknownTarget",
  RELEASE_UNCOMPARABLE: "backup.warningReleaseUncomparable",
};

function warningLabel(code: string): string {
  const key = WARNING_KEYS[code];
  return key ? getT()(key) : code;
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
  if (!value) return getT()("backup.notRecorded");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

function problemMessage(preview: BackupPreviewDTO): string | null {
  if (!preview.problem) return null;
  if (preview.problem === "BACKUP_VERSION_MISMATCH") {
    return getT()("backup.versionMismatch", {
      backup: preview.summary.release,
      current: preview.currentRelease,
    });
  }
  return describeCode(preview.problem);
}

export function Backup() {
  const { client, targetKind } = useApp();
  const t = useT();
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  const statusQuery = useContainerStatusQuery(targetKind === "container");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const statusErrorCode = statusQuery.error ? toClientError(statusQuery.error).code : "";
  const runtimeDown =
    targetKind === "container" &&
    (statusErrorCode.startsWith("LOCAL_RUNTIME_") || statusErrorCode.startsWith("SSH_"));
  const stopped =
    !runtimeDown &&
    targetKind === "container" &&
    statusQuery.data?.reachable === true &&
    statusQuery.data.running === false;
  // Backup and restore both need the admin API; a stopped runtime or host makes
  // every request fail, so the buttons are off with the reason above them.
  const actionsBlocked = stopped || runtimeDown;

  const startContainer = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await client.startContainer();
      await queryClient.invalidateQueries({ queryKey: queryKeys.containerStatus });
    } catch (cause) {
      setStartError(cause);
    } finally {
      setStarting(false);
    }
  };
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
      invalidate.configAndStatus();
    } catch (cause) {
      setRestoreError(cause);
      // A failure after the destructive step leaves a journal record; a
      // snapshot/file failure does not. The retry action below depends on it.
      await refreshPending();
    } finally {
      setRestoreRunning(false);
    }
  }, [client, invalidate, refreshPending]);

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
      invalidate.configAndStatus();
    } catch (cause) {
      setRestoreError(cause);
      await refreshPending();
    } finally {
      setRestoreRunning(false);
    }
  }, [chooseBackup, client, invalidate, pending, refreshPending]);

  const blocked = preview ? problemMessage(preview) : null;
  const canRestore = Boolean(preview) && !blocked;

  return (
    <div>
      <PageHeader title={t("shell.pages.backup")} subtitle={pageSubtitle("backup")} />

      <MoveCard />

      <ErrorAlert error={exportError} onRetry={exportData} retryLabel={t("backup.retryExport")} />
      <ErrorAlert error={chooseError} onRetry={chooseBackup} retryLabel={t("backup.retryChoose")} />
      <ErrorAlert error={settingsError} onRetry={refreshSettings} retryLabel={t("backup.retrySettings")} />

      <section className="mt-5 border-b border-border pb-5" aria-label={t("backup.position")}>
        <div className="mb-3">
          <h2 className="text-base font-medium">{t("backup.position")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("backup.positionDescription")}
          </p>
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 break-all font-mono text-xs" data-testid="backup-dir" data-i18n-ignore>
              {settings ? settings.dir : t("backup.reading")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void openFolder()}
              disabled={folderBusy}
            >
              {t("backup.openFolder")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void changeFolder()}
              disabled={folderBusy}
            >
              {t("backup.changeFolder")}
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
              {t("backup.autoBackup", {
                state: settings?.auto ? t("backup.autoOn") : t("backup.autoOff"),
              })}
            </Button>
            <Select
              value={String(settings?.intervalHours ?? 24)}
              onValueChange={(value) => void patchSettings({ intervalHours: Number(value) })}
              disabled={!settings || savingSettings}
            >
              <SelectTrigger size="sm" className="w-32" aria-label={t("backup.intervalAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t("backup.interval1")}</SelectItem>
                <SelectItem value="6">{t("backup.interval6")}</SelectItem>
                <SelectItem value="24">{t("backup.interval24")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(settings?.keep ?? 5)}
              onValueChange={(value) => void patchSettings({ keep: Number(value) })}
              disabled={!settings || savingSettings}
            >
              <SelectTrigger size="sm" className="w-28" aria-label={t("backup.keepAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t("backup.keep1")}</SelectItem>
                <SelectItem value="5">{t("backup.keep5")}</SelectItem>
                <SelectItem value="10">{t("backup.keep10")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("backup.noAutoWhenClosed")}
          </p>

          <p className="text-xs text-muted-foreground">
            {t("backup.lastSuccess")}
            {settings?.lastSuccessAt ? formatExportedAt(settings.lastSuccessAt) : t("backup.never")}
            {settings?.lastErrorCode ? (
              <>
                {` · ${t("backup.lastFailure")}${describeCode(settings.lastErrorCode)}`}
                {settings.lastErrorMessage ? (
                  <span data-i18n-ignore>
                    {t("backup.lastFailureDetail", { message: settings.lastErrorMessage })}
                  </span>
                ) : null}
              </>
            ) : null}
          </p>
        </div>
      </section>

      {stopped ? (
        <Alert className="mt-5" data-testid="backup-container-stopped">
          <AlertTitle>{t("backup.containerStoppedTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("backup.containerStoppedDescription")}</p>
            <Button type="button" size="sm" disabled={starting} onClick={() => void startContainer()}>
              {starting ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("backup.startContainer")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <ErrorAlert error={runtimeDown ? statusQuery.error : null} />
      <ErrorAlert error={startError} />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{t("backup.exportTitle")}</CardTitle>
          <Button type="button" onClick={() => void exportData()} disabled={exportRunning || actionsBlocked}>
            {exportRunning ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
            {t("backup.exportNow")}
          </Button>
          </div>
          <CardDescription>
            {t("backup.exportDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {progress ? (
            <div
              className="rounded-md border border-border p-3 text-sm"
              data-testid="backup-progress"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{progress.op === "restore" ? t("backup.progressRestore") : t("backup.progressExport")}</Badge>
                <span className="font-medium">{phaseLabel(progress.phase)}</span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                <span>{t("backup.progressTables", { count: progress.tables })}</span>
                <span>{t("backup.progressRows", { count: progress.rows })}</span>
                <span>
                  {t("backup.progressObjects", { count: progress.objects })}
                  {progress.totalObjects ? ` / ${progress.totalObjects}` : ""}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("backup.neverExported")}</p>
          )}

          {exportSummary ? (
            <div className="mt-3 space-y-1 text-sm">
              <p className="font-medium">
                {t("backup.exportSavedTo")}
                <span data-i18n-ignore>{exportSummary.path}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {formatExportedAt(exportSummary.exportedAt)} ·{" "}
                {t("backup.version", { release: exportSummary.release || t("common.unknown") })} ·{" "}
                {t(exportSummary.rows === 1 ? "backup.rowsOne" : "backup.rowsOther", {
                  count: exportSummary.rows,
                })}{" "}
                ·{" "}
                {t(exportSummary.tasks === 1 ? "backup.tasksOne" : "backup.tasksOther", {
                  count: exportSummary.tasks,
                })}{" "}
                ·{" "}
                {t(exportSummary.objects === 1 ? "backup.objectsOne" : "backup.objectsOther", {
                  count: exportSummary.objects,
                })}{" "}
                · {formatBytes(exportSummary.bytes)}
              </p>
              {exportSummary.oversized.length > 0 ? (
                <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t(
                    exportSummary.oversized.length === 1
                      ? "backup.oversizedOne"
                      : "backup.oversizedOther",
                    { count: exportSummary.oversized.length },
                  )}{" "}
                  <span data-i18n-ignore>
                    {exportSummary.oversized.join(t("backup.listSeparator"))}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {exportSummary ? (
            <Alert className="mt-4">
              <AlertTitle>{t("backup.exportDoneTitle")}</AlertTitle>
              <AlertDescription>{t("backup.sensitiveNotice")}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t("backup.filesTitle")}</CardTitle>
          <CardDescription>
            {t("backup.filesDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorAlert error={filesError} onRetry={refreshFiles} retryLabel={t("backup.retryFiles")} />
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("backup.filesEmpty")}</p>
          ) : (
            <ul className="space-y-2" data-testid="backup-file-list">
              {files.map((file) => (
                <li
                  key={file.path}
                  data-testid="backup-file"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
                >
                  <div className="min-w-0">
                    <p className="break-all font-mono text-xs" data-i18n-ignore>{file.name}</p>
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
                    {t("backup.restoreThis")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{t("backup.restoreTitle")}</CardTitle>
          <Button
            type="button"
            variant="outline"
            onClick={() => void chooseBackup()}
            disabled={choosing || restoreRunning || actionsBlocked}
          >
            {choosing ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Upload aria-hidden />
            )}
            {t("backup.restoreFromFile")}
          </Button>          </div>
          <CardDescription>
            {t("backup.restoreDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t("backup.summaryTitle")}</span>
                  <Badge variant="outline">
                    {t("backup.version", {
                      release: preview.summary.release || t("common.unknown"),
                    })}
                  </Badge>
                  {preview.problem ? (
                    <Badge variant="destructive" data-i18n-ignore>{preview.problem}</Badge>
                  ) : null}
                </div>
                <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <div className="break-all sm:col-span-2" data-i18n-ignore>{preview.summary.path}</div>
                  <div>{t("backup.exportedAt")}{formatExportedAt(preview.summary.exportedAt)}</div>
                  <div>{t("backup.currentRelease")}{preview.currentRelease || t("common.unknown")}</div>
                  <div>{t("backup.dataRows")}{preview.summary.rows}</div>
                  <div>{t("backup.taskCount")}{preview.summary.tasks}</div>
                  <div>{t("backup.objectCount")}{preview.summary.objects}</div>
                  <div>{t("backup.fileSize")}{formatBytes(preview.summary.bytes)}</div>
                </dl>
                {preview.warnings?.length ? (
                  <Alert className="mt-2">
                    <AlertTriangle aria-hidden />
                    <AlertTitle>{t("backup.warningsTitle")}</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {preview.warnings.map((code) => (
                          <li key={code}>{warningLabel(code)}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {preview.summary.oversized.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    {t("backup.oversizedPreview")}
                    <span data-i18n-ignore>
                      {preview.summary.oversized.join(t("backup.listSeparator"))}
                    </span>
                  </p>
                ) : null}
              </div>

              {blocked ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>{t("backup.blockedTitle")}</AlertTitle>
                  <AlertDescription>{blocked}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={blocked ? "outline" : "destructive"}
                  onClick={() => setRestoreOpen(true)}
                  disabled={!canRestore || restoreRunning || actionsBlocked}
                >
                  {restoreRunning ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {t("backup.overwriteRestore")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("backup.snapshotNote")}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("backup.choosePrompt")}
            </p>
          )}

          <ErrorAlert
            error={restoreError}
            onRetry={() => void retryRestore()}
            retryLabel={pending ? t("backup.retryPending") : t("backup.retryChoose")}
          />

          {restoreDone ? (
            <Alert className="mt-4">
              <AlertTitle>{t("backup.restoreDoneTitle")}</AlertTitle>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backup.confirmRestoreTitle")}</DialogTitle>
            <DialogDescription>{t("backup.overwriteNotice")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void restoreData()}>
              {t("backup.confirmRestoreTitle")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

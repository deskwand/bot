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
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { describeCode } from "@/services/errors";
import type {
  BackupPreviewDTO,
  BackupSummaryDTO,
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

  useEffect(() => client.subscribeBackupProgress(setProgress), [client]);

  const exportData = useCallback(async () => {
    setExportRunning(true);
    setExportError(null);
    setExportSummary(null);
    setProgress(null);
    try {
      const summary = await client.exportData();
      if (summary) setExportSummary(summary);
    } catch (cause) {
      setExportError(cause);
    } finally {
      setExportRunning(false);
    }
  }, [client]);

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
    } catch (cause) {
      setRestoreError(cause);
    } finally {
      setRestoreRunning(false);
    }
  }, [client]);

  const blocked = preview ? problemMessage(preview) : null;
  const canRestore = Boolean(preview) && !blocked;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">维护</p>
          <h1 className="text-2xl font-semibold tracking-tight">数据备份</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            把云端的记忆、对话、任务和产物导出为本地文件，或从一个备份整体恢复。备份文件未加密，请妥善保管。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void exportData()} disabled={exportRunning}>
            {exportRunning ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
            导出到本地
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

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>导出</CardTitle>
          <CardDescription>
            导出包含全部业务表和产物，不包含部署配置与 secret。导出和恢复期间消息会暂停，最多 10 分钟后自动恢复。
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
            <p className="text-sm text-muted-foreground">尚未开始导出。</p>
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
                  {exportSummary.oversized.length} 个产物超过 100 MiB，已按原样导出，但无法恢复：
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
          <CardTitle>恢复</CardTitle>
          <CardDescription>
            只能恢复到与备份相同的云端版本。恢复会整体覆盖当前部署；开始前会先自动保存一份当前数据快照。
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
                    备份中有无法恢复的超大产物：{preview.summary.oversized.join("、")}
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
                  恢复失败时可以从恢复前快照回到当前数据。
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              选择一个本地备份后，这里会显示导出时间、版本、行数和产物数量。
            </p>
          )}

          <ErrorAlert error={restoreError} onRetry={() => setRestoreOpen(true)} retryLabel="重新恢复" />

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

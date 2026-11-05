import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { McpToolDTO } from "@/services/types";
import { useT, type MessageKey } from "@/i18n";

const MODE_LABELS: Record<string, MessageKey> = {
  review: "mcp.modes.review",
  auto: "mcp.modes.auto",
  approval: "mcp.modes.approval",
  disabled: "mcp.modes.disabled",
};

export function McpToolList({
  tools,
  reviewable,
  dirty,
  saving,
  disabled = false,
  onChange,
  onSave,
}: {
  tools: McpToolDTO[];
  /** Tool names whose probed mode is "review"; only they may offer 智能. */
  reviewable: ReadonlySet<string>;
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  onChange: (name: string, mode: string) => void;
  onSave: () => void;
}) {
  const t = useT();
  if (tools.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("mcp.noTools")}</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {tools.map((tool) => (
          <li
            key={tool.name}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
          >
            <div className="min-w-0">
              <p className="break-all font-mono text-xs"><span data-i18n-ignore>{tool.name}</span></p>
              {tool.description ? (
                <p className="mt-1 text-xs text-muted-foreground" data-i18n-ignore>{tool.description}</p>
              ) : null}
            </div>
            <Select
              value={tool.mode}
              onValueChange={(mode) => onChange(tool.name, mode)}
              disabled={disabled}
            >
              <SelectTrigger
                size="sm"
                className="w-24"
                aria-label={t("mcp.toolModeAria", { name: tool.name })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MODE_LABELS).map(([value, labelKey]) =>
                  value === "review" && !reviewable.has(tool.name) ? null : (
                    <SelectItem key={value} value={value}>
                      {t(labelKey)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onSave} disabled={disabled || !dirty || saving}>
          {saving ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Save aria-hidden />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

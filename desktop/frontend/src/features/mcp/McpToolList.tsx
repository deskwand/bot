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

const MODE_LABELS: Record<string, string> = {
  auto: "免审",
  approval: "要审",
  disabled: "停用",
};

export function McpToolList({
  tools,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  tools: McpToolDTO[];
  dirty: boolean;
  saving: boolean;
  onChange: (name: string, mode: string) => void;
  onSave: () => void;
}) {
  if (tools.length === 0) {
    return <p className="text-sm text-muted-foreground">没有可用的工具。</p>;
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
              <p className="break-all font-mono text-xs">{tool.name}</p>
              {tool.description ? (
                <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
              ) : null}
            </div>
            <Select value={tool.mode} onValueChange={(mode) => onChange(tool.name, mode)}>
              <SelectTrigger
                size="sm"
                className="w-24"
                aria-label={`${tool.name} 审批方式`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MODE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onSave} disabled={!dirty || saving}>
          {saving ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Save aria-hidden />
          )}
          保存
        </Button>
      </div>
    </div>
  );
}

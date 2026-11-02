import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProviderOption } from "./catalog";

export function ModelSelect({
  id,
  value,
  onChange,
  options,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ProviderOption[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectContent>
        {options.flatMap((provider) =>
          provider.models.map((model) => (
            <SelectItem key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>
              {provider.label} · {model.label}
            </SelectItem>
          )),
        )}
      </SelectContent>
    </Select>
  );
}

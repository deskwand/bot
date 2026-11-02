import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { allModels } from "./catalog";

export function ModelSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectContent>
        {allModels().map((model) => (
          <SelectItem key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

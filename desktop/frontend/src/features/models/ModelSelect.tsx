import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useT } from "@/i18n";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseModelKey, type ProviderOption } from "./catalog";

// Provider first, then a searchable list of that provider's models. `value`
// only changes once a model is picked, so switching provider alone never
// saves a half-chosen model.
export function ModelSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ProviderOption[];
}) {
  const t = useT();
  const current = parseModelKey(value);
  const [providerID, setProviderID] = useState(current?.provider ?? "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Set when a new provider is picked; the model list opens once the provider
  // dropdown has finished closing, so it does not take focus back.
  const openAfterProvider = useRef(false);

  useEffect(() => {
    setProviderID(current?.provider ?? "");
  }, [current?.provider]);

  // Radix mirrors every provider option into a visually hidden native select,
  // where the Go-provided provider names become plain text nodes. Mark that
  // element (and only it) so the copy scan does not read them as UI copy.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mark = () => {
      root.querySelectorAll("select[aria-hidden]").forEach((node) => {
        node.setAttribute("data-i18n-ignore", "");
      });
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const provider = options.find((option) => option.id === providerID);
  const models = provider?.models ?? [];
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (model) =>
        model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
    );
  }, [models, query]);

  // Provider and model names come from the Go catalog; keep them out of the
  // translation walk. Only the image-support suffix is ours.
  const modelName = (model: ProviderOption["models"][number]) => (
    <>
      <span data-i18n-ignore>{model.label}</span>
      {provider?.keyless && !model.imageInput ? t("models.noImage") : null}
    </>
  );

  const selected = models.find((model) => model.id === current?.id);

  const openModels = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      const index = models.findIndex(
        (model) => current?.provider === providerID && model.id === current.id,
      );
      setActive(Math.max(index, 0));
    }
  };

  const pick = (modelID: string) => {
    onChange(`${providerID}/${modelID}`);
    setOpen(false);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + matches.length) % matches.length;
      setActive(next);
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = matches[active];
      if (model) pick(model.id);
    }
  };

  const builtin = options.filter((option) => !option.custom);
  const custom = options.filter((option) => option.custom);

  return (
    <div className="@container" ref={rootRef}>
      <div className="grid gap-2 @sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Select
          value={providerID}
          onValueChange={(next) => {
            setProviderID(next);
            openAfterProvider.current = next !== current?.provider;
          }}
        >
          <SelectTrigger id={`${id}-provider`} aria-label={t("models.providerAria", { label })} className="w-full">
            <SelectValue placeholder={t("models.selectProvider")}>{provider?.label ? <span data-i18n-ignore>{provider.label}</span> : <span data-i18n-ignore>{providerID}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent
            onCloseAutoFocus={(event) => {
              if (!openAfterProvider.current) return;
              openAfterProvider.current = false;
              event.preventDefault();
              openModels(true);
            }}
          >
            {custom.length > 0 ? (
              <SelectGroup>
                <SelectLabel>{t("models.customGroup")}</SelectLabel>
                {custom.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <span data-i18n-ignore>{option.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            <SelectGroup>
              {custom.length > 0 ? <SelectLabel>{t("models.builtinGroup")}</SelectLabel> : null}
              {builtin.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span data-i18n-ignore>{option.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Popover.Root open={open} onOpenChange={openModels}>
          <Popover.Trigger asChild>
            <button
              id={id}
              type="button"
              role="combobox"
              aria-expanded={open}
              aria-controls={`${id}-list`}
              disabled={!provider}
              className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
            >
              <span className={cn("truncate", !selected && "text-muted-foreground")}>
                {current && current.provider === providerID ? (
                  selected ? modelName(selected) : <span data-i18n-ignore>{current.id}</span>
                ) : provider ? (
                  t("models.selectModel")
                ) : (
                  t("models.selectProviderFirst")
                )}
              </span>
              <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={4}
              className="z-50 w-(--radix-popover-trigger-width) min-w-64 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <div className="relative p-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKey}
                  placeholder={t("models.searchPlaceholder")}
                  aria-label={t("models.searchModelsAria")}
                  aria-controls={`${id}-list`}
                  aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
                  className="pl-8"
                  spellCheck={false}
                />
              </div>
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                <span data-i18n-ignore>{provider?.label}</span> ·{" "}
                {models.length === 1
                  ? t("models.modelCount_one", { count: models.length })
                  : t("models.modelCount_other", { count: models.length })}
              </p>
              <div
                ref={listRef}
                id={`${id}-list`}
                role="listbox"
                aria-label={t("models.modelListAria")}
                className="max-h-72 overflow-y-auto"
              >
                {matches.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">{t("models.noMatchingModels")}</p>
                ) : (
                  matches.map((model, index) => {
                    const selected = current?.provider === providerID && current.id === model.id;
                    return (
                      <div
                        key={model.id}
                        id={`${id}-option-${index}`}
                        data-index={index}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => setActive(index)}
                        onClick={() => pick(model.id)}
                        className={cn(
                          "relative flex cursor-default flex-col rounded-md py-1.5 pr-8 pl-2 text-sm select-none",
                          index === active && "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="truncate">{modelName(model)}</span>
                        {model.label !== model.id ? (
                          <span className="truncate text-xs text-muted-foreground" data-i18n-ignore>
                            {model.id}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2" />
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/feedback";
import { useT } from "@/i18n";
import type {
  McpAddInput,
  McpCatalogEntryDTO,
  McpCustomInput,
  McpFieldDTO,
} from "@/services/types";

const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

interface HeaderDraft {
  name: string;
  value: string;
  secret: boolean;
}

type Selection = McpCatalogEntryDTO | "custom" | null;

function fieldRows(entry: McpCatalogEntryDTO): McpFieldDTO[] {
  return entry.fields;
}

export function McpAddDialog({
  open,
  onOpenChange,
  catalog,
  existingNames,
  onAdd,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: McpCatalogEntryDTO[];
  existingNames: string[];
  onAdd: (input: McpAddInput) => Promise<void>;
  error: unknown;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [url, setURL] = useState("");
  const [oauth, setOAuth] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft[]>([
    { name: "", value: "", secret: true },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const t = useT();

  const reset = () => {
    setSelection(null);
    setName("");
    setValues({});
    setURL("");
    setOAuth(false);
    setHeaders([{ name: "", value: "", secret: true }]);
    setSubmitting(false);
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, McpCatalogEntryDTO[]>();
    for (const entry of catalog) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return [...groups.entries()];
  }, [catalog]);

  const choose = (entry: McpCatalogEntryDTO) => {
    setSelection(entry);
    setName(entry.id);
    setValues({});
  };

  const chooseCustom = () => {
    setSelection("custom");
    setName("");
    setURL("");
    setOAuth(false);
    setHeaders([{ name: "", value: "", secret: true }]);
  };

  const trimmedName = name.trim();
  const nameError = !NAME_PATTERN.test(trimmedName)
    ? t("mcp.namePattern")
    : existingNames.includes(trimmedName)
      ? t("mcp.nameExists")
      : "";
  const missingField =
    selection !== null && selection !== "custom"
      ? fieldRows(selection).find((field) => !values[field.key]?.trim())
      : undefined;
  const missingHeader = headers.some(
    (header) => header.name.trim() && !header.value.trim(),
  );
  const canSave =
    selection !== null &&
    !submitting &&
    nameError === "" &&
    (selection === "custom"
      ? url.trim() !== "" && !missingHeader
      : missingField === undefined);

  const submit = async () => {
    if (!canSave || selection === null) return;
    const input: McpAddInput = { catalogId: "", name: trimmedName, values };
    if (selection === "custom") {
      const custom: McpCustomInput = {
        url: url.trim(),
        oauth,
        headers: headers
          .filter((header) => header.name.trim())
          .map((header) => ({
            name: header.name.trim(),
            value: header.value,
            secret: header.secret,
          })),
      };
      input.custom = custom;
    } else {
      input.catalogId = selection.id;
    }
    setSubmitting(true);
    try {
      await onAdd(input);
      close(false);
    } catch {
      // The parent renders the publish error; keep the form open.
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    selection === null
      ? t("mcp.addService")
      : selection === "custom"
        ? t("mcp.addCustomService")
        : t("mcp.addNamed", { name: selection.name });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {selection === null
              ? t("mcp.catalogDescription")
              : t("mcp.formDescription")}
          </DialogDescription>
        </DialogHeader>

        {selection === null ? (
          <div className="space-y-5">
            {grouped.map(([category, entries], groupIndex) => (
              <section key={category} aria-labelledby={`mcp-category-${groupIndex}`}>
                <h3
                  id={`mcp-category-${groupIndex}`}
                  className="mb-2 text-sm font-medium"
                  data-i18n-ignore
                >
                  {category}
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {entries.map((entry) => (
                    <Card key={entry.id} size="sm">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <span data-i18n-ignore>{entry.name}</span>
                          {entry.oauth ? (
                            <span className="text-xs font-normal text-muted-foreground">
                              {t("mcp.loginAuthorization")}
                            </span>
                          ) : null}
                        </CardTitle>
                        <CardDescription data-i18n-ignore>{entry.description}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={t("mcp.addNamed", { name: entry.name })}
                          onClick={() => choose(entry)}
                        >
                          <Plus aria-hidden />
                          {t("mcp.addAction")}
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            ))}
            <section aria-label={t("mcp.custom")}>
              <h3 className="mb-2 text-sm font-medium">{t("mcp.custom")}</h3>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{t("mcp.customUrl")}</CardTitle>
                  <CardDescription>
                    {t("mcp.customDescription")}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button type="button" variant="outline" size="sm" onClick={chooseCustom}>
                    <Plus aria-hidden />
                    {t("mcp.customUrl")}
                  </Button>
                </CardContent>
              </Card>
            </section>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-name">{t("mcp.name")}</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my_service"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {t("mcp.nameHint", { name: trimmedName || "my_service" })}
              </p>
              {name !== "" && nameError ? (
                <p className="text-sm text-destructive">{nameError}</p>
              ) : null}
            </div>

            {selection === "custom" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="mcp-url">{t("mcp.url")}</Label>
                  <Input
                    id="mcp-url"
                    value={url}
                    onChange={(event) => setURL(event.target.value)}
                    placeholder="https://example.com/mcp"
                    spellCheck={false}
                  />
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-primary"
                    checked={oauth}
                    onChange={(event) => setOAuth(event.target.checked)}
                  />
                  <span>
                    {t("mcp.oauthRequired")}
                    <span className="block text-xs text-muted-foreground">
                      {t("mcp.oauthHint")}
                    </span>
                  </span>
                </label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Headers</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setHeaders((current) => [
                          ...current,
                          { name: "", value: "", secret: true },
                        ])
                      }
                    >
                      <Plus aria-hidden />
                      {t("mcp.addHeader")}
                    </Button>
                  </div>
                  {headers.map((header, index) => (
                    <div
                      key={index}
                      className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_auto_auto]"
                    >
                      <Input
                        aria-label={t("mcp.headerNameAria", { index: index + 1 })}
                        value={header.name}
                        onChange={(event) =>
                          setHeaders((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="Authorization"
                        spellCheck={false}
                      />
                      <Input
                        aria-label={t("mcp.headerValueAria", { index: index + 1 })}
                        type={header.secret ? "password" : "text"}
                        value={header.value}
                        onChange={(event) =>
                          setHeaders((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder={header.secret ? t("mcp.headerSecretPlaceholder") : t("mcp.headerValuePlaceholder")}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={header.secret}
                          onChange={(event) =>
                            setHeaders((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, secret: event.target.checked }
                                  : item,
                              ),
                            )
                          }
                        />
                        {t("mcp.secret")}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("mcp.deleteHeaderAria", { index: index + 1 })}
                        onClick={() =>
                          setHeaders((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {fieldRows(selection).map((field) => (
                  <div key={field.key} className="space-y-2">
                    <Label htmlFor={`mcp-field-${field.key}`}>
                      <span data-i18n-ignore>{field.label}</span>
                    </Label>
                    <Input
                      id={`mcp-field-${field.key}`}
                      type="password"
                      value={values[field.key] ?? ""}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <p className="text-xs text-muted-foreground">
                      <span data-i18n-ignore>{field.help}</span>
                      {field.helpUrl ? (
                        <>
                          {" "}
                          <a
                            className="underline underline-offset-2"
                            href={field.helpUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("mcp.whereToGet")}
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                ))}
                {selection.oauth ? (
                  <Alert>
                    <AlertTitle>{t("mcp.oauthTitle")}</AlertTitle>
                    <AlertDescription>
                      {t("mcp.oauthDescription")}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}

            <ErrorAlert error={error} />
          </div>
        )}

        <DialogFooter>
          {selection !== null ? (
            <Button type="button" variant="ghost" onClick={() => setSelection(null)}>
              <ArrowLeft aria-hidden />
              {t("mcp.backToCatalog")}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          {selection !== null ? (
            <Button type="button" onClick={() => void submit()} disabled={!canSave}>
              {submitting ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("common.save")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

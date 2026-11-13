import { useT } from "@/i18n";

export function Unsupported() {
  const t = useT();
  return (
    <div data-testid="unsupported" className="mx-auto max-w-2xl py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t("server.unsupportedTitle")}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {t("server.unsupportedDescription")}
      </p>
    </div>
  );
}

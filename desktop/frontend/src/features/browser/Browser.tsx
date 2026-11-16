import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/components/app-context";
import type { BrowserEventDTO, BrowserFrameDTO } from "@/services/types";
import { useT, type MessageKey } from "@/i18n";
import { toFramePoint, toViewportPoint } from "./coords";

const VIEWPORT = { width: 1280, height: 800 };

type Availability = { ok: boolean; reason?: string };

/** A single printable character is typed as text: `press("你")` is not a key. */
function isTypedText(event: React.KeyboardEvent<HTMLCanvasElement>): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return [...event.key].length === 1;
}

export function Browser() {
  const t = useT();
  const { client } = useApp();
  const [available, setAvailable] = useState<Availability | null>(null);
  const [url, setUrl] = useState("");
  const [current, setCurrent] = useState("");
  const [frame, setFrame] = useState<BrowserFrameDTO | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Input must arrive in the order it was produced: a `up` that overtakes its
  // `down` leaves the page with the button stuck down.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const painting = useRef(false);

  const enqueue = (events: BrowserEventDTO[]) => {
    const seq = frame?.seq ?? 0;
    queue.current = queue.current
      .then(() => client.browserInput(seq, events))
      .catch(() => undefined);
  };

  useEffect(() => {
    let alive = true;
    void client
      .browserStatus()
      .then((status) => alive && setAvailable({ ok: status.available, reason: status.reason }))
      .catch(() => alive && setAvailable({ ok: false, reason: "sandbox-unreachable" }));
    return () => {
      alive = false;
    };
  }, [client]);

  // Frames only exist while a stream runs, so the page owns the stream's life.
  useEffect(() => {
    const offFrame = client.subscribeBrowserFrame((next) => {
      if (painting.current) return; // a slow decoder must not build a backlog
      painting.current = true;
      setFrame(next);
    });
    const offStream = client.subscribeBrowserStream((state) => {
      if (state.kind === "state") {
        setCurrent(state.url ?? "");
        setEnded(null);
        return;
      }
      if (state.kind === "end") setEnded(state.reason ?? "closed");
    });
    return () => {
      offFrame();
      offStream();
      void client.browserStreamStop();
    };
  }, [client]);

  useEffect(() => {
    if (frame === null || canvas.current === null) return;
    const element = canvas.current;
    const image = new Image();
    image.onload = () => {
      const context = element.getContext("2d");
      if (context != null) context.drawImage(image, 0, 0, element.width, element.height);
      painting.current = false;
    };
    image.onerror = () => {
      painting.current = false;
    };
    image.src = `data:image/jpeg;base64,${frame.jpeg}`;
  }, [frame]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (frame === null || canvas.current === null) return null;
    const box = canvas.current.getBoundingClientRect();
    const scaled = toFramePoint(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      { width: box.width, height: box.height },
      frame.w,
      frame.h,
    );
    return toViewportPoint(scaled, VIEWPORT);
  };

  const start = (target: string) => {
    void client.browserOpen(target).then(() => client.browserStreamStart());
  };

  if (available === null) return null;
  if (!available.ok) {
    const reason = available.reason ?? "sandbox-unreachable";
    return (
      <Alert>
        <AlertTitle>{t("browser.title")}</AlertTitle>
        <AlertDescription>
          {t(`browser.unavailable.${reason}` as MessageKey) ||
            t("browser.unavailable.sandbox-unreachable")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t("browser.urlPlaceholder")}
        />
        <Button onClick={() => start(url)}>{t("browser.open")}</Button>
        <Button variant="ghost" onClick={() => void client.browserClose()}>
          {t("browser.close")}
        </Button>
      </div>
      {ended === null ? null : (
        <Alert>
          <AlertTitle>{t("browser.ended")}</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{t("browser.endedHint")}</span>
            <Button size="sm" onClick={() => start(url || current)}>
              {t("browser.reconnect")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        {current === "" ? t("browser.frameHint") : current}
      </p>
      <canvas
        ref={canvas}
        width={VIEWPORT.width}
        height={VIEWPORT.height}
        tabIndex={0}
        className="w-full rounded-lg border border-border/60 bg-muted focus:outline-none"
        onPointerDown={(event) => {
          const at = point(event);
          if (at === null) return;
          enqueue([{ type: "mouse", kind: "down", x: at.x, y: at.y, button: "left" }]);
        }}
        onPointerUp={(event) => {
          const at = point(event);
          if (at === null) return;
          enqueue([{ type: "mouse", kind: "up", x: at.x, y: at.y, button: "left" }]);
        }}
        onPointerMove={(event) => {
          // Only a held button moves the pointer: idle moves are 30/s of noise.
          if (event.buttons === 0) return;
          const at = point(event);
          if (at === null) return;
          enqueue([{ type: "mouse", kind: "move", x: at.x, y: at.y, button: "left" }]);
        }}
        onWheel={(event) => {
          if (frame === null) return;
          event.preventDefault();
          enqueue([{ type: "mouse", kind: "wheel", deltaY: event.deltaY }]);
        }}
        onKeyDown={(event) => {
          if (frame === null) return;
          if (event.key === "Process" || event.key === "Dead") return;
          event.preventDefault();
          if (isTypedText(event)) {
            enqueue([{ type: "key", kind: "text", text: event.key }]);
            return;
          }
          enqueue([{ type: "key", kind: "press", key: event.key }]);
        }}
      />
    </div>
  );
}

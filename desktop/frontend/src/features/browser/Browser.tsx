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
  const [empty, setEmpty] = useState(false);
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
    let timer: ReturnType<typeof setTimeout> | null = null;

    // No url: attach to whatever the sandbox browser is already showing. While
    // nothing is open, keep asking: a task that starts a page later has to
    // appear without the human reloading anything.
    const attach = () => {
      void client
        .browserOpen("")
        .then((opened) => {
          if (!alive) return;
          if (opened.url === "") {
            setEmpty(true);
            timer = setTimeout(attach, 3000);
            return;
          }
          setEmpty(false);
          setCurrent(opened.url);
          void client.browserStreamStart();
        })
        // A page mid-navigation can refuse a snapshot; that is not a dead
        // sandbox, so keep the URL box and try again shortly.
        .catch(() => {
          if (!alive) return;
          setEmpty(true);
          timer = setTimeout(attach, 3000);
        });
    };

    void client
      .browserStatus()
      .then((status) => {
        if (!alive) return;
        setAvailable({ ok: status.available, reason: status.reason });
        if (status.available) attach();
      })
      .catch(() => alive && setAvailable({ ok: false, reason: "sandbox-unreachable" }));

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
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
    if (frame === null || canvas.current === null) {
      // A frame that arrives with no canvas must not leave the guard stuck shut.
      painting.current = false;
      return;
    }
    const element = canvas.current;
    let cancelled = false;
    let pending: ImageBitmap | null = null;

    const release = (): void => {
      painting.current = false;
    };

    const paint = (decoded: ImageBitmap): void => {
      if (cancelled) {
        decoded.close();
        return;
      }
      try {
        const context = element.getContext("2d");
        if (context != null) context.drawImage(decoded, 0, 0, element.width, element.height);
      } finally {
        decoded.close();
        pending = null;
        release();
      }
    };

    let blob: Blob;
    try {
      const binary = atob(frame.jpeg);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: "image/jpeg" });
    } catch {
      // A truncated base64 string must not leave the canvas wedged shut.
      release();
      return;
    }

    if (typeof createImageBitmap === "function") {
      // Decoded off the main thread: the old data-URL path parsed and decoded on it.
      void createImageBitmap(blob)
        .then((decoded) => {
          pending = decoded;
          paint(decoded);
        })
        .catch(release);
    } else {
      // WKWebView and WebView2 both have createImageBitmap; this path only keeps an
      // ancient webview showing a picture instead of nothing.
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        if (cancelled) {
          release();
          return;
        }
        const context = element.getContext("2d");
        if (context != null) context.drawImage(image, 0, 0, element.width, element.height);
        release();
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        release();
      };
      image.src = url;
    }

    return () => {
      cancelled = true;
      if (pending !== null) {
        pending.close();
        pending = null;
      }
    };
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
    void client.browserOpen(target).then((opened) => {
      setCurrent(opened.url);
      setEmpty(opened.url === "");
      setEnded(null);
      if (opened.url !== "") void client.browserStreamStart();
    });
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
            <Button size="sm" onClick={() => start(url)}>
              {t("browser.reconnect")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {empty && frame === null ? (
        <Alert>
          <AlertTitle>{t("browser.title")}</AlertTitle>
          <AlertDescription>{t("browser.empty")}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground">{empty ? "" : current === "" ? t("browser.frameHint") : current}</p>
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

/**
 * Wraps a `Models` collection so that `onFirstToken` fires as soon as a streamed
 * response produces its first event with content. pi only sees the provider's
 * raw stream here, before progress throttling commits anything to storage.
 */
export function withFirstToken<M extends object>(
  models: M,
  onFirstToken: () => void,
): M {
  return new Proxy(models, {
    get(target, prop) {
      if (prop !== "streamSimple") {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const stream = (
          Reflect.get(target, prop, target) as (...input: unknown[]) => {
            [Symbol.asyncIterator](): AsyncIterator<unknown>;
            result(): Promise<unknown>;
          }
        ).apply(target, args);
        let called = false;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              if (!called && hasContent(event)) {
                called = true;
                try {
                  onFirstToken();
                } catch (error) {
                  console.error("butler first-token callback failed:", error);
                }
              }
              yield event;
            }
          },
          result: () => stream.result(),
        };
      };
    },
  });
}

/** Same rule pi's `streamResponse` uses to decide an event is worth showing. */
function hasContent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const { type, partial } = event as {
    type?: unknown;
    partial?: { content?: unknown };
  };
  if (type === "done" || type === "error") return false;
  return Array.isArray(partial?.content) && partial.content.length > 0;
}

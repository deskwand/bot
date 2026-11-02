import { useEffect } from "react";
import { useApp } from "./app-context";

/** Registers unsaved form state with the shell so navigation can warn. */
export function useDirty(dirty: boolean): void {
  const { setDirty } = useApp();
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppInfo } from "./mygo";
import "./style.css";

function App() {
  const [name, setName] = useState("DeskWand Bot");
  const [source, setSource] = useState("waiting for the Go binding");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    AppInfo.name()
      .then((value) => {
        if (!active) return;
        setName(value);
        setSource("name read from Go via mygo.Bind");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailed(true);
        setSource(error instanceof Error ? error.message : "Go binding failed");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <p className="eyebrow">Desktop shell</p>
      <h1>{name}</h1>
      <p className={failed ? "status status-error" : "status"}>{source}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

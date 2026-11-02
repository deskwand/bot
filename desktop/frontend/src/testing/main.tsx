// Vite test-mode entry. The production build uses index.html only, so the mock
// service and its ?fixture= router never ship in the desktop bundle.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App";
import { createMockClient } from "./fixtures";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App client={createMockClient()} />
  </StrictMode>,
);

// Vite test-mode entry. The production build uses index.html only, so the mock
// service and its ?fixture= router never ship in the desktop bundle.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App";
import { LocaleProvider } from "../i18n";
import { createMockClient } from "./fixtures";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const client = createMockClient();

createRoot(root).render(
  <StrictMode>
    <LocaleProvider client={client}>
      <App client={client} />
    </LocaleProvider>
  </StrictMode>,
);

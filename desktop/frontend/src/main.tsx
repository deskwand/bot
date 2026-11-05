import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./i18n";
import { createProductionClient } from "./services/client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const client = createProductionClient();

createRoot(root).render(
  <StrictMode>
    <LocaleProvider client={client}>
      <App client={client} />
    </LocaleProvider>
  </StrictMode>,
);

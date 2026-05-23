// Standalone dev mount. Run `pnpm dev` in this package to open at
// http://localhost:5174 with /api proxied to http://localhost:3000.
// The host shell uses its own mount and consumes our PluginUI export
// from src/ui.ts — this file is dev-only.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

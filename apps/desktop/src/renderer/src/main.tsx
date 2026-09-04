import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredTheme } from "./theme";
import "./tauri-api";
import "./styles.css";

// Paint the saved theme before the first render so a light-mode window never
// flashes the dark palette on the way up.
applyStoredTheme();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

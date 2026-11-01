import * as ReactDOMClient from "react-dom/client";
import { App } from "./App.tsx";
import { followSettings } from "./host.ts";
import { provideHostModules } from "./host-modules.ts";
import { startScreenRelay } from "./screen.ts";
import "./styles.css";

// Node modules are compiled with these as host-provided singletons (one React, one bridge).
provideHostModules();
// The person's settings (language, theme, …), the same in every app of theirs: read, and followed.
followSettings();

ReactDOMClient.createRoot(document.getElementById("root")!).render(<App />);
startScreenRelay();

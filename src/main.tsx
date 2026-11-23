import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles/tokens.css";
import "./styles/ui.css";
// Theme layer last so it can restyle every feature surface.
import "./styles/glass.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element missing");

createRoot(container).render(<App />);

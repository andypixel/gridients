import React from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import App from "./App.jsx";
import LoginGate from "./LoginGate.jsx";
import Styleguide from "./Styleguide.jsx";

const page = window.location.pathname === "/styleguide" ? <Styleguide /> : <App />;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LoginGate>
      {page}
    </LoginGate>
  </React.StrictMode>
);

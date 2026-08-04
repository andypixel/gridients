import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev the client runs on 5173 and the API on 3000. Proxying
    // keeps the app same-origin in development too, so cookies and
    // relative /api paths behave identically to production.
    proxy: { "/api": "http://localhost:3000" },
  },
});

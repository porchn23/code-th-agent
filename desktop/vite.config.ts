import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// อ่าน env โดยไม่ต้องพึ่ง @types/node (cast เอง)
const isDebug = Boolean(
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.TAURI_DEBUG
);

// Tauri ใช้ port 1420 (dev) และรอ build เสร็จก่อนเปิดหน้าต่าง
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri ใช้ Chromium รุ่นที่มาพร้อมกับ WebView2
    target: "chrome105",
    minify: !isDebug ? "esbuild" : false,
    sourcemap: isDebug,
    outDir: "dist",
    emptyOutDir: true,
  },
});

// electron.vite.config.js
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";
var __electron_vite_injected_import_meta_url = "file:///D:/Dropbox/Dropbox/CNS/COding/GazeAAC/electron.vite.config.js";
var __dirname = fileURLToPath(new URL(".", __electron_vite_injected_import_meta_url));
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main.js")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload.js")
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src"),
    publicDir: resolve(__dirname, "public"),
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/index.html")
        }
      }
    },
    resolve: {
      alias: {
        "@engine": resolve(__dirname, "src/engine"),
        "@components": resolve(__dirname, "src/components"),
        "@context": resolve(__dirname, "src/context")
      }
    },
    plugins: [react()]
  }
});
export {
  electron_vite_config_default as default
};

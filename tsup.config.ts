import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  minify: false,
  banner: { js: "" },
  // Stamp the build with a unique version so `yolo-code --version` reflects
  // *which* build is running. Sandboxes that bake yolo-code via this
  // config (containers/sandboxes/yolo-studio-all/Dockerfile) used to
  // always report "0.1.0" because nothing replaced BUILD_VERSION here —
  // making it impossible to tell an old baked binary from a fresh one.
  // CI passes IMAGE_TAG (=`main-<sha>`) through as YOLO_CODE_VERSION;
  // local builds get `<pkg-version>-dev`.
  define: {
    BUILD_VERSION: JSON.stringify(
      process.env.YOLO_CODE_VERSION ??
        `${process.env.npm_package_version ?? "0.0.0"}-dev`,
    ),
  },
  external: [
    // keep runtime deps out of the bundle so they resolve from node_modules
    "ink",
    "ink-text-input",
    "ink-spinner",
    "ink-select-input",
    "react",
    "commander",
    "fast-glob",
    "diff",
    "turndown",
  ],
});

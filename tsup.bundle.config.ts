import { defineConfig } from "tsup";

/**
 * Bundle config for the distribution artifact (the "yolo-code" executable
 * shipped to R2 at `yolo/<version>/claurst-linux-x86_64` and consumed by
 * install-yolo.sh). Produces a single self-contained ESM file with a
 * `#!/usr/bin/env node` shebang — chmod +x and it runs on any host that
 * has node on PATH (every YOLO Studio sandbox does via NVM).
 *
 * Differs from the dev config (tsup.config.ts) in that:
 *   - all runtime deps (ink, react, commander, fast-glob, diff, turndown)
 *     are INLINED instead of resolved from node_modules at runtime, so
 *     the dist artifact is a single file
 *   - minified, no sourcemap (artifact size matters for R2 uploads)
 *   - shebang prepended so the file is directly executable
 *   - react-devtools-core is force-externalized — ink only needs it when
 *     DEV=1 at runtime, and pulling its transitive `ws` / websocket graph
 *     into the bundle adds ~2 MB of cold code the sandbox will never hit
 */
export default defineConfig({
  entry: { yolo: "src/index.tsx" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  shims: false,
  minify: true,
  outDir: "dist-bundle",
  outExtension: () => ({ js: ".mjs" }),
  // The shebang makes the file Linux-executable. Following lines give
  // bundled CommonJS deps (commander / turndown / ink internals) a real
  // `require` they can use for dynamic requires of Node built-ins —
  // tsup's default shim throws on those in a pure-ESM bundle.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __yoloCreateRequire } from "node:module";',
      'import { fileURLToPath as __yoloFileURLToPath } from "node:url";',
      'import { dirname as __yoloDirname } from "node:path";',
      "const require = __yoloCreateRequire(import.meta.url);",
      "const __filename = __yoloFileURLToPath(import.meta.url);",
      "const __dirname = __yoloDirname(__filename);",
    ].join("\n"),
  },
  // Embed the version into the bundle so `yolo-code --version` still works
  // when the binary lives at ~/.local/bin/yolo-code and has no sibling
  // package.json. CI sets YOLO_CODE_VERSION to something like
  // `main-70bcba6`; local invocations default to the package.json
  // version appended with `-dev`.
  define: {
    BUILD_VERSION: JSON.stringify(
      process.env.YOLO_CODE_VERSION ??
        `${process.env.npm_package_version ?? "0.0.0"}-dev`,
    ),
  },
  external: ["react-devtools-core"],
  noExternal: [/.*/],
});

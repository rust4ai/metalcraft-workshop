# metalcraft-workshop

[![CI](https://github.com/ethereumdegen/metalcraft-workshop/actions/workflows/ci.yml/badge.svg)](https://github.com/ethereumdegen/metalcraft-workshop/actions/workflows/ci.yml)
[![Release](https://github.com/ethereumdegen/metalcraft-workshop/actions/workflows/release.yml/badge.svg)](https://github.com/ethereumdegen/metalcraft-workshop/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/ethereumdegen/metalcraft-workshop?include_prereleases&sort=semver)](https://github.com/ethereumdegen/metalcraft-workshop/releases/latest)

A Tauri desktop app for viewing and editing
[metalcraft-agent](https://github.com/rust4ai/metalcraft) project files —
personas, skills, flows, and diagnostics logs — in one place.

Point it at a `metalcraft-agent` project directory and you get:

- **Personas** — form editor for `personas/*.json`: name, description, tools,
  skills (chip-picker populated from the project's actual skills), system
  prompt.
- **Skills** — `skills/*.md` editor with YAML-frontmatter `description` field
  and side-by-side markdown preview.
- **Flows** — a graph editor for `flows/*.json` built on
  [`@xyflow/react`](https://reactflow.dev). Per-node-type inspector for the
  spec-defined node kinds (`entry`, `prompt`, `branch`, `branch_tool`) plus a
  raw-JSON escape hatch. Save runs `metalcraft_flows::validate` and surfaces
  errors inline.
- **Chats** — a live viewer for the per-run diagnostics dumps that
  `metalcraft-agent --diagnostics` writes to `logs/<timestamp>/`.
  Reconstructs the conversation from `turn_NNN.json` files, renders tool
  calls/results as collapsible cards, and overlays markers for context
  compactions and config changes. New turn files appear in real time as the
  agent runs (filesystem watcher).

## Download

Pre-built binaries for Linux, macOS (Intel + Apple Silicon), and Windows are
attached to each release:

→ **[Latest release](https://github.com/ethereumdegen/metalcraft-workshop/releases/latest)**

Unpack the archive for your platform and run the `metalcraft-workshop`
binary. SHA256 checksums for every artifact are in
`checksums-<tag>.sha256` on the release page.

## Run from source

### Linux prerequisites

```bash
sudo apt install \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  libdbus-1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  pkg-config
```

Plus a stable Rust toolchain and Node 20+.

### Build & launch

```bash
cd crates/workshop-tauri/frontend
npm install
npm run build
cd ../../..
cargo run -p workshop-tauri                       # opens the picker
cargo run -p workshop-tauri -- /path/to/my-agent  # auto-opens that directory
```

## Architecture

Cargo workspace with two crates plus a Vite/React/Tailwind frontend:

```
crates/
  workshop-api/      pure data layer — file I/O for personas/skills/flows
                     plus diagnostics-session reconstruction.
                     Tauri-free; unit-testable.
  workshop-tauri/    binary. Thin Tauri commands over workshop-api +
                     a notify(2) file watcher that streams change events
                     to the webview via emit("workshop-event").
    frontend/        Vite + React 19 + Tailwind 3. One hook
                     (useWorkshop) holds the project snapshot;
                     each section is a self-contained view component.
```

Same shape as [starkbot-native](https://github.com/rust4ai/starkbot-native);
the flow editor is lifted from there.

## Status

Functional v0.1. Roadmap items: per-node JSON-schema validation in the flow
inspector, monaco-based JSON view for raw artifact debugging, multi-project
recents pinning.

## License

MIT

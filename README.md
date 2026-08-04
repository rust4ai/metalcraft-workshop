# metalcraft-workshop

[![CI](https://github.com/rust4ai/metalcraft-workshop/actions/workflows/ci.yml/badge.svg)](https://github.com/rust4ai/metalcraft-workshop/actions/workflows/ci.yml)
[![Release](https://github.com/rust4ai/metalcraft-workshop/actions/workflows/release.yml/badge.svg)](https://github.com/rust4ai/metalcraft-workshop/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/rust4ai/metalcraft-workshop?include_prereleases&sort=semver)](https://github.com/rust4ai/metalcraft-workshop/releases/latest)

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

## Connecting to a remote agent pod

Besides opening a local project directory, the Workshop can sign in with
**Metalcraft ID** (OIDC) and connect to a `metalcraft-agent` **pod** you run on
the hosted cluster — list your pods, pick one, and drive its chat/keys/gateway
surfaces over the network.

Auth is **OIDC-only — no static API key is stored**. To talk to a pod's
`/api/v1/*` API, the Workshop mints a short-lived, audience-scoped
(`pod:{slug}`) **connection token** from the control plane
(`POST /api/pods/{slug}/connection/mint`) and sends it as the pod's Bearer. That
mint is a general per-pod, per-owner primitive: any Metalcraft ID–authenticated
client that owns the pod can mint one — it is **not** specific to the Workshop
and has nothing to do with the Metalcraft Gateway. The token lives ~1h and a
background refresher re-mints it before expiry, so long chats never drop. For a
self-hosted agent you point at directly, the manual **API key (Bearer)** field
still works.

## Getting started

The Workshop is also a **viewer/editor for a local `metalcraft-agent` project** —
a directory that holds `personas/`, `skills/`, `flows/`, and diagnostics
`logs/`. You point the app at such a directory (or launch it and pick one
from the file dialog), so have a metalcraft-agent project on hand. There are
two ways to run it.

### Option 1 — download a prebuilt binary (no toolchain required)

The easiest path for most people. Every [release](https://github.com/rust4ai/metalcraft-workshop/releases/latest)
attaches binaries for Linux, macOS (Intel + Apple Silicon), and Windows:

→ **[Latest release](https://github.com/rust4ai/metalcraft-workshop/releases/latest)**

Unpack the archive for your platform and run the `metalcraft-workshop`
binary. SHA256 checksums for every artifact are in
`checksums-<tag>.sha256` on the release page.

### Option 2 — run from source

You need:

- **Rust** — a stable toolchain (install via [rustup](https://rustup.rs))
- **Node 20+** — the UI is a Vite/React bundle that is compiled into the app,
  so Node is required even though the app itself is a native binary
- **Linux only** — the WebKit/GTK system libraries below (macOS just needs the
  Xcode command-line tools; Windows needs nothing extra):

  ```bash
  sudo apt install \
    libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
    libdbus-1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    pkg-config
  ```

Then use the `run.sh` helper — it installs the frontend deps (first run
only), builds the bundle, and compiles + launches the app:

```bash
./run.sh                      # debug build, opens the project picker
./run.sh --release            # optimized build
./run.sh /path/to/my-agent    # auto-open that agent project on launch
```

Prefer to drive the steps yourself? `run.sh` is just a wrapper around:

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

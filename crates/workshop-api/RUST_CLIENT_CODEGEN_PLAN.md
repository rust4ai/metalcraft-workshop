# Plan: generate the Rust pod DTOs from the agent's OpenAPI (typify/progenitor)

**Status:** proposed, not started. This is a plan only — do not implement without sign-off.

## Why

The agent (`metalcraft-agent`) now publishes a derived OpenAPI 3.1 document at
`GET /api/v1/openapi.json` (see its `ApiDoc`). Both Workshop frontends already
generate their TypeScript pod types from it (`gen:types` → `api-types.ts`), so
the browser-facing shapes can no longer drift.

One hand-written mirror of the pod remains: **the Rust DTOs in this crate**
(`workshop-api`). `RemoteConnection` (`src/connection.rs`) calls the pod over
reqwest and deserializes each response into structs we maintain by hand across
`keys.rs`, `gateway.rs`, `personas.rs`, `skills.rs`, `api_tools.rs`,
`diagnostics.rs`, `integration_packs.rs`, and `chat.rs`. If the pod changes a
field, nothing here fails to compile — it just deserializes wrong at runtime.
That is the last drift surface, one level below the TS types (which are
generated from the schema, but the Tauri frontend's real contract is *these*
Rust command return types, so a Rust-side drift is invisible to `tsc`).

Goal: generate these DTOs from the same `openapi.json`, so `openapi.json` feeds
**three** consumers — web TS, Tauri TS, and this Rust crate — with zero
hand-mirrored pod shapes.

## Current architecture (what the codegen must fit)

- `Connection` trait (`src/connection.rs`) with two impls:
  - `LocalConnection` — builds the same DTOs from a local project dir (no pod).
  - `RemoteConnection` — reqwest → pod `/api/v1/*`, deserialize into the DTOs.
- The DTOs are the trait's currency, so **both** impls must produce the
  generated types. They're plain data structs with `pub` fields, so
  `LocalConnection` can construct them directly — no blocker.
- Bespoke concerns the codegen must *not* disturb: the auth/token flow
  (connection-token mint + refresh), and SSE streaming for
  `POST /api/v1/chats/{id}/turn` + `/events` (the `ChatEvent` frames in
  `chat.rs` are parsed from a `text/event-stream`, not a JSON body).

## Approach: types-only, not a full generated client

Use **`typify`** (the JSON-Schema→Rust engine inside progenitor) to generate
only the DTO structs/enums from the schema's `components`. Do **not** adopt
progenitor's full generated reqwest client.

Rationale: progenitor's generated client would fight the pieces that are
deliberately custom here — the dual Local/Remote trait, the token
mint/refresh, and especially SSE (progenitor models JSON responses, not
event-streams). Types-only closes the drift gap with the least disruption:
swap the hand-written DTO definitions for generated ones and keep every line of
connection, auth, and streaming logic as-is.

(If a future goal is a standalone SDK for external callers, revisit the full
progenitor client then — it's out of scope here.)

## Codegen mechanics

- **Source of truth:** the same `openapi.json` the frontends vendor. Vendor a
  copy at `crates/workshop-api/openapi.json` (regenerated in the agent via
  `cargo run --example dump_openapi > openapi.json`).
- **Committed output, explicit regen** (mirrors the TS `gen:types` ergonomics —
  reviewable diffs, no build-time codegen dependency): a tiny generator
  (`cargo xtask gen-pod-types`, or a `src/bin/gen_pod_types.rs`) runs `typify`
  over `openapi.json` and writes `src/generated.rs`. Prefer this over a
  `build.rs` so the generated types are diffable in review and the crate has no
  codegen deps in its normal build graph.
- **Module layout:** `mod generated;` with `#![allow(clippy::all, dead_code)]`
  at the top; re-export the needed types from `lib.rs`. Delete the hand-written
  duplicates and repoint `use` sites.

## Scope: what gets generated vs stays hand-written

Generate (pure pod pass-throughs, already ToSchema in the agent):
`KeyEntry`, `KeySummary`, `RecommendedKey`, `PersonaSummary`, `Persona`,
`SkillSummary`, `Skill`, `ApiToolSummary`, `HttpApiToolConfig`,
`DiagnosticsSessionSummary`, `IntegrationPackSummary`/`Detail`, `ChatSummary`,
`ChatDetail`, gateway `ChannelType`/`ChannelInstance`/`SettingField`/
`GatewayEvent`/`GatewayStatus`, and the `ChatEvent` frame enum (the *type* is
generated even though SSE parsing stays custom).

Stay hand-written (out of scope, with reasons):
- **Flows** (`SavedFlow`, `FlowSummary`, flow-run shapes): the agent exposes
  these as opaque `Object` in the schema (they come from the external
  `metalcraft-flows` crate, which has no `ToSchema`). typify would emit
  `serde_json::Value`, but the Tauri flow editor needs the *structured* shape,
  so these remain hand-written. (Alternative, larger: add `ToSchema` upstream in
  `metalcraft-flows` so flows become first-class in the schema — separate task.)
- **Types the Tauri Rust layer genuinely reshapes** beyond the pod
  (e.g. `ProjectSnapshot`/`ProjectLayout` carry local-mode fields the pod
  doesn't send; `DiagnosticsSessionSummary` has an extra `persona_name`;
  `ScheduledTask`). These are Tauri contracts, not pod schemas — leave them.

## Validation spikes to run BEFORE the full roll

Two known sharp edges decide whether this is smooth or fiddly — spike them
first on a single module:

1. **Internally-tagged enums.** The agent's `ChatMessageWire` (tag `role`) and
   `ChatEvent` (tag `kind`) are internally-tagged. Confirm typify emits a
   matching `#[serde(tag = "…")]` Rust enum that round-trips the pod's JSON.
   This is the highest-risk item.
2. **The flows `Object` gap** above — confirm the generated code compiles with
   flows excluded and the hand-written flow types bridged where a generated
   struct references a flow (e.g. `FlowTemplate.flow`).

Do these on `keys.rs` (trivial structs) + the `chat.rs` enums before committing
to the rest.

## Migration steps

1. Add the generator (`typify` dep in an xtask/bin) + vendor `openapi.json`.
2. Generate `src/generated.rs`; wire the module + allow attrs.
3. **Vertical slice:** replace `keys.rs` DTOs with the generated ones; delete the
   hand-written structs; `cargo build` the workspace; confirm the `Connection`
   trait, both impls, the Tauri commands, and the frontend all still line up.
4. Run the enum spike (`ChatEvent`).
5. Roll through the remaining in-scope modules one at a time, building between
   each.
6. Delete all now-dead hand-written DTOs; grep for stragglers.

## Verification

- `cargo build`/`cargo clippy` the whole workspace.
- Tauri frontend build unaffected (types already generated from the same schema;
  a mismatch would surface as a Rust deserialize error at runtime, not `tsc`).
- Round-trip a live pod for each migrated surface (keys, gateway, packs, chats,
  diagnostics) — connect the desktop app to a real pod and confirm each view
  loads, since runtime deserialization is the actual contract here.
- Regenerate `openapi.json` from the agent and re-run the generator; the diff
  should be empty when the agent hasn't changed (proves determinism).

## Non-goals

- Replacing reqwest with progenitor's generated client.
- Any change to auth, token refresh, SSE parsing, or the frontend.
- Bringing flows into the schema (tracked separately).

## Payoff

`openapi.json` becomes the single source for **three** generated consumers.
After this, no hand-maintained copy of a pod response shape exists anywhere in
the Workshop stack — an agent field change that a client cares about becomes a
compile error (Rust) or a `tsc` error (frontends), not a silent runtime bug.

## Effort

Small–medium. The mechanical struct swaps are quick; the risk/time is
concentrated in the two validation spikes (tagged enums, flows gap). Estimate
~1 focused session for the spikes + keys slice, then incremental for the rest.

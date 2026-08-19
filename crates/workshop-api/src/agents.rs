//! Agent presets and agent instances.
//!
//! An **agent preset** is what a pod *can be*: a default persona, the roster it may
//! call, the integration packs those personas need, its skills and seed memories. An
//! **agent instance** is an agent that actually exists — one per long-running thing
//! you talk to, owning its own memory and many conversations.
//!
//! Mirrors the on-disk format in `metalcraft-agent/src/agent_preset.rs` and
//! `agent_instance.rs`, so the local-directory backend can read them straight off
//! disk exactly as it already does for personas. The remote backend gets richer
//! answers from the API (a roster resolved against what is installed, conversation
//! counts); the local reader fills in what it can and leaves the rest at its default.
//!
//! ## Vocabulary
//!
//! In the UI an instance is an **agent** — "Amy — Sunday prep" is an agent, and the
//! fact that it instantiates a preset is our vocabulary, not the user's. "Preset" is
//! reserved for the authoring surface, where it genuinely is the template being
//! edited.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ---- Presets --------------------------------------------------------------

/// A preset as it appears in a list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresetSummary {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub tagline: Option<String>,
    #[serde(default)]
    pub description: String,
    pub default_persona: String,
    /// How many personas this agent can call, including its default.
    #[serde(default)]
    pub persona_count: usize,
}

/// The stored preset document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPreset {
    #[serde(default = "one")]
    pub manifest_version: u32,
    pub slug: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tagline: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub default_persona: String,
    #[serde(default)]
    pub personas: Vec<PresetPersona>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub integration_packs: Vec<String>,
    /// Kept as raw JSON: the workshop does not edit memories, but dropping the field
    /// on save would silently strip an agent's seed knowledge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memories: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<serde_json::Value>,
    #[serde(default)]
    pub requires_env: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetPersona {
    pub slug: String,
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_role() -> String {
    "subagent".to_string()
}

/// A preset plus its roster resolved against what this pod actually has.
///
/// `installed: false` is the interesting case and the reason this type exists: it
/// means the preset names a persona the pod does not have, which is a real state the
/// API already reports and no client could previously show.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresetDetail {
    pub preset: AgentPreset,
    #[serde(default)]
    pub personas: Vec<RosterPersona>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterPersona {
    pub slug: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// False when the preset names a persona this pod does not have.
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    /// Present when the persona could not be resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentPreset {
    /// Every persona this agent can be, default first. Internal roles are excluded —
    /// they exist for the agent's own plumbing, not as something to talk to.
    pub fn callable_personas(&self) -> Vec<String> {
        let mut out = vec![self.default_persona.clone()];
        for p in &self.personas {
            if p.role != "internal" && !out.contains(&p.slug) {
                out.push(p.slug.clone());
            }
        }
        out
    }

    pub fn summary(&self) -> AgentPresetSummary {
        AgentPresetSummary {
            slug: self.slug.clone(),
            name: self.name.clone(),
            tagline: self.tagline.clone(),
            description: self.description.clone(),
            default_persona: self.default_persona.clone(),
            persona_count: self.callable_personas().len(),
        }
    }
}

// ---- Instances ------------------------------------------------------------

/// An agent. Named for the file it lives in, not for how it reads in a UI — see the
/// vocabulary note at the top of this module.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstance {
    pub id: String,
    pub agent_preset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_from_version: Option<String>,
    pub name: String,
    pub persona: String,
    #[serde(default)]
    pub origin: InstanceOrigin,
    /// Ephemeral agents are reaped after a TTL; naming one makes it persistent.
    #[serde(default)]
    pub persistent: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_active_at: String,
    /// Only present in list responses from the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_count: Option<usize>,
}

/// Where an agent came from. `Gateway` is the one a UI must not treat as ordinary:
/// messages arrive without anyone watching, so that agent acts on its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstanceOrigin {
    Workshop,
    Cli,
    Gateway { channel: String },
    Flow { flow_id: String },
    #[serde(other)]
    Unknown,
}

impl Default for InstanceOrigin {
    fn default() -> Self {
        Self::Unknown
    }
}

/// An agent plus its conversations and what it is scheduled to do.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceDetail {
    #[serde(flatten)]
    pub instance: AgentInstance,
    #[serde(default)]
    pub conversations: Vec<crate::chat::ChatSummary>,
    /// Flow schedules armed to this agent. A pod could not previously answer "what
    /// is this background agent scheduled to do".
    #[serde(default)]
    pub scheduled: Vec<ScheduledFlowRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledFlowRef {
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_name: Option<String>,
    #[serde(default)]
    pub schedule_ids: Vec<String>,
}

/// Which agent a flow runs as, plus everything the arm dialog has to state.
///
/// A flow may only name personas from its preset's roster. That containment rule is
/// what makes [`ArmConsent`] constructible at all — if the graph could reach any
/// persona on the pod, "this flow can reach these domains" would be a guess.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowBinding {
    pub flow_id: String,
    /// Always populated: an unbound flow resolves to the default agent, which is what
    /// it effectively already was.
    pub preset: String,
    /// True when the preset was chosen deliberately rather than defaulted.
    #[serde(default)]
    pub bound: bool,
    #[serde(default)]
    pub personas: Vec<FlowPersonaCheck>,
    #[serde(default)]
    pub armed: Vec<ArmedSchedule>,
    #[serde(default)]
    pub consent: ArmConsent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowPersonaCheck {
    pub slug: String,
    #[serde(default)]
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmedSchedule {
    pub schedule_id: String,
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
}

/// The resolved content of the arm dialog — the second consent moment, and the
/// sharper of the two: a scheduled flow acts **while nobody is watching**, so a tool
/// that writes is a materially bigger commitment here than the same tool in a chat
/// where an approval prompt exists.
///
/// Every field is derived on the agent side from resolved data — the domains come
/// from the vendored tools' own definitions, never from anything an author wrote
/// about them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArmConsent {
    #[serde(default)]
    pub preset_name: String,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub requires_env: Vec<String>,
    /// Credentials the pod does not have. Those tools fail at 3am rather than at a
    /// moment anyone is looking, which is exactly why this belongs on the dialog.
    #[serde(default)]
    pub missing_env: Vec<String>,
    #[serde(default)]
    pub mutating_tools: Vec<String>,
    #[serde(default)]
    pub tool_count: usize,
    /// Seed memories the agent starts from; it accumulates more on every run.
    #[serde(default)]
    pub base_memories: usize,
}

/// What an agent knows: the shared base it inherited from its preset, plus what it
/// has learned since.
///
/// Read-only, and deliberately so on the agent's side too — reading it does not touch
/// access counts, so looking at what an agent knows cannot skew its decay curve.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceMemory {
    #[serde(default)]
    pub instance_id: String,
    /// `<preset>@<version>` when this agent was shipped a knowledge base; `None` when
    /// everything it knows, it learned.
    #[serde(default)]
    pub base: Option<String>,
    /// Memories the pack gave it that it can still see (tombstones excluded).
    #[serde(default)]
    pub shipped: usize,
    /// Memories this agent formed itself.
    #[serde(default)]
    pub learned: usize,
    /// Shipped memories this agent has been told to forget.
    #[serde(default)]
    pub forgotten: usize,
    #[serde(default)]
    pub sample: Vec<MemorySample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySample {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub importance: f32,
    /// `"shipped"` (came with the preset) or `"learned"` (this agent's own) — the
    /// distinction a "what does it know" view exists to draw.
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub entity: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Fields a rename/promote can change. Everything else about an agent is derived.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstancePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent: Option<bool>,
    /// Must be in the preset's roster; the agent rejects anything else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
}

// ---- Local directory backend ----------------------------------------------

pub fn presets_dir(project_root: &Path) -> PathBuf {
    project_root.join("agent_presets")
}

pub fn instances_dir(project_root: &Path) -> PathBuf {
    project_root.join("agent_instances")
}

/// Read `<project>/agent_presets/*.json`.
pub fn list_presets(project_root: &Path) -> Vec<AgentPresetSummary> {
    let Ok(entries) = std::fs::read_dir(presets_dir(project_root)) else {
        return Vec::new();
    };
    let mut out: Vec<AgentPresetSummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let preset: AgentPreset = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
            Some(preset.summary())
        })
        .collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn load_preset(project_root: &Path, slug: &str) -> anyhow::Result<AgentPreset> {
    let file = presets_dir(project_root).join(format!("{slug}.json"));
    Ok(serde_json::from_str(&std::fs::read_to_string(&file)?)?)
}

/// A preset with its roster resolved against the personas on disk.
///
/// This is the local-mode answer to the same question the API answers remotely, and
/// it must agree: a persona named by the preset but absent from `personas/` is
/// `installed: false` with a reason, not a silent omission.
pub fn load_preset_detail(project_root: &Path, slug: &str) -> anyhow::Result<AgentPresetDetail> {
    let preset = load_preset(project_root, slug)?;
    let personas = preset
        .callable_personas()
        .into_iter()
        .map(|p| match crate::personas::load(project_root, &p) {
            Ok(persona) => RosterPersona {
                slug: p,
                name: persona.name,
                description: persona.description,
                installed: true,
                tools: persona.tools,
                skills: persona.skills,
                error: None,
            },
            Err(e) => RosterPersona {
                name: p.clone(),
                slug: p,
                description: String::new(),
                installed: false,
                tools: Vec::new(),
                skills: Vec::new(),
                error: Some(e.to_string()),
            },
        })
        .collect();
    Ok(AgentPresetDetail { preset, personas })
}

pub fn save_preset(project_root: &Path, slug: &str, preset: &AgentPreset) -> anyhow::Result<()> {
    let dir = presets_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{slug}.json")), serde_json::to_string_pretty(preset)?)?;
    Ok(())
}

pub fn delete_preset(project_root: &Path, slug: &str) -> anyhow::Result<()> {
    let file = presets_dir(project_root).join(format!("{slug}.json"));
    if file.exists() {
        std::fs::remove_file(&file)?;
    }
    Ok(())
}

/// Read `<project>/agent_instances/*/instance.json`, most recently active first.
pub fn list_instances(project_root: &Path) -> Vec<AgentInstance> {
    let Ok(entries) = std::fs::read_dir(instances_dir(project_root)) else {
        return Vec::new();
    };
    let mut out: Vec<AgentInstance> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let raw = std::fs::read_to_string(e.path().join("instance.json")).ok()?;
            serde_json::from_str(&raw).ok()
        })
        .collect();
    // Newest activity first, matching the agent's own ordering so the two backends
    // do not disagree about what "the top of the list" means.
    out.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    out
}

pub fn load_instance(project_root: &Path, id: &str) -> anyhow::Result<AgentInstance> {
    let file = instances_dir(project_root).join(id).join("instance.json");
    Ok(serde_json::from_str(&std::fs::read_to_string(&file)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(json: &str) -> AgentPreset {
        serde_json::from_str(json).expect("parse preset")
    }

    #[test]
    fn the_default_persona_leads_the_roster_and_never_repeats() {
        let p = preset(
            r#"{"slug":"amy","name":"Amy","default_persona":"amy-chef",
                "personas":[{"slug":"amy-chef","role":"default"},
                            {"slug":"amy-shopper","role":"subagent"}]}"#,
        );
        assert_eq!(p.callable_personas(), vec!["amy-chef", "amy-shopper"]);
        assert_eq!(p.summary().persona_count, 2);
    }

    #[test]
    fn internal_personas_are_not_offered() {
        // They exist for the agent's plumbing; a person should not be able to open a
        // chat as one.
        let p = preset(
            r#"{"slug":"amy","name":"Amy","default_persona":"amy-chef",
                "personas":[{"slug":"amy-chef","role":"default"},
                            {"slug":"summarizer","role":"internal"}]}"#,
        );
        assert_eq!(p.callable_personas(), vec!["amy-chef"]);
    }

    #[test]
    fn a_preset_with_no_roster_still_offers_its_default() {
        let p = preset(r#"{"slug":"a","name":"A","default_persona":"solo"}"#);
        assert_eq!(p.callable_personas(), vec!["solo"]);
    }

    #[test]
    fn an_unknown_origin_kind_does_not_break_the_list() {
        // A newer agent inventing an origin must not make every instance unreadable.
        let i: AgentInstance = serde_json::from_str(
            r#"{"id":"inst_1","agent_preset":"amy","name":"Amy","persona":"amy-chef",
                "origin":{"kind":"telepathy"}}"#,
        )
        .expect("parse");
        assert!(matches!(i.origin, InstanceOrigin::Unknown));
    }

    #[test]
    fn a_gateway_origin_keeps_its_channel() {
        let i: AgentInstance = serde_json::from_str(
            r#"{"id":"inst_1","agent_preset":"amy","name":"Amy","persona":"amy-chef",
                "origin":{"kind":"gateway","channel":"whatsapp-main"}}"#,
        )
        .expect("parse");
        match i.origin {
            InstanceOrigin::Gateway { channel } => assert_eq!(channel, "whatsapp-main"),
            other => panic!("expected gateway, got {other:?}"),
        }
    }

    #[test]
    fn preset_json_round_trips_without_losing_memories() {
        // The workshop does not edit `memories`, but saving a preset must not strip
        // it — that would silently delete an agent's seed knowledge.
        let raw = r#"{"manifest_version":1,"slug":"amy","name":"Amy","default_persona":"amy-chef",
                      "personas":[{"slug":"amy-chef","role":"default"}],
                      "memories":{"file":"memories.jsonl","count":42},"version":"1.0.0"}"#;
        let p = preset(raw);
        let out = serde_json::to_value(&p).unwrap();
        assert_eq!(out["memories"]["count"], 42);
        assert_eq!(out["version"], "1.0.0");
    }
}

// ---- Agent packs ----------------------------------------------------------
//
// The distribution unit: one preset plus every persona, skill and integration pack
// it needs, in a signed-by-content `.agentpack` archive. Installing one is the
// moment a person grants an agent reach into their accounts, so the preview below
// exists to make that a decision rather than a surprise.

/// An installed agent pack.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAgentPack {
    pub id: String,
    pub manifest: AgentPackManifest,
    #[serde(default)]
    pub root: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentPackManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub presets: Vec<String>,
    #[serde(default)]
    pub provides: PackProvides,
    #[serde(default)]
    pub author: Option<serde_json::Value>,
    #[serde(default)]
    pub content_sha256: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PackProvides {
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub integration_packs: Vec<serde_json::Value>,
}

/// What installing a pack would grant — **derived from the archive's own bytes**,
/// never from what its author wrote about it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConsentSummary {
    /// Every origin this agent's tools can reach.
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub requires_env: Vec<EnvRequirement>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// A read-only agent is a materially smaller commitment than one that can write,
    /// and a dialog should say which it is.
    #[serde(default)]
    pub mutating_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvRequirement {
    pub name: String,
    #[serde(default)]
    pub needed_by: Vec<String>,
    #[serde(default = "yes")]
    pub required: bool,
}

fn yes() -> bool {
    true
}

/// The answer to "what would installing this do", without installing it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPackPreview {
    pub manifest: AgentPackManifest,
    pub consent: ConsentSummary,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub content_sha256: String,
    #[serde(default)]
    pub source: String,
    /// Present means this is an upgrade (or a downgrade), not a first install.
    #[serde(default)]
    pub installed_version: Option<String>,
    /// Credentials the pod does not have yet. A warning, not a blocker.
    #[serde(default)]
    pub missing_env: Vec<String>,
    #[serde(default)]
    pub preset_collisions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstallReport {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub presets: Vec<String>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub packs_stored: Vec<String>,
    #[serde(default)]
    pub packs_deduplicated: Vec<String>,
    #[serde(default)]
    pub missing_env: Vec<String>,
    #[serde(default)]
    pub preset_collisions: Vec<String>,
    #[serde(default)]
    pub memories_indexed: usize,
    #[serde(default)]
    pub consent: ConsentSummary,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UninstallReport {
    pub id: String,
    /// Agents left pointing at a preset that no longer exists. Never silently
    /// deleted — someone's memories are in there.
    #[serde(default)]
    pub orphaned_agents: Vec<String>,
    /// Integration packs whose last reference this was, so the content store
    /// released them.
    #[serde(default)]
    pub packs_freed: usize,
}

pub fn agent_packs_dir(project_root: &Path) -> PathBuf {
    project_root.join("agent_packs")
}

/// Read `<project>/agent_packs/*/agent_pack.json`.
///
/// The local backend can answer *what is installed* — those are files. It cannot
/// install: that writes into the content store and rebuilds a memory index, which is
/// the pod's job.
pub fn list_installed_packs(project_root: &Path) -> Vec<InstalledAgentPack> {
    let Ok(entries) = std::fs::read_dir(agent_packs_dir(project_root)) else {
        return Vec::new();
    };
    let mut out: Vec<InstalledAgentPack> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let root = e.path();
            let raw = std::fs::read_to_string(root.join("agent_pack.json")).ok()?;
            let manifest: AgentPackManifest = serde_json::from_str(&raw).ok()?;
            Some(InstalledAgentPack {
                id: manifest.id.clone(),
                manifest,
                root: root.display().to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Where the archive comes from. A dialog inspects a source and then installs *that
/// same source*, so both operations take one of these — any divergence between the
/// two would be a divergence between what was approved and what was done.
#[derive(Debug, Clone)]
pub enum PackSource {
    /// A registry URL. The pod refuses origins outside its allowlist.
    Url(String),
    /// A path on the *pod's* filesystem, not the client's.
    Path(String),
    /// Raw archive bytes, uploaded.
    Bytes(Vec<u8>),
}

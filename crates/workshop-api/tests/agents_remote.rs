//! The agent-preset and agent-instance wire types, against a real agent.
//!
//! Every method here is a runtime `serde` decode of whatever the pod sends. A field
//! that has been renamed or a shape that has drifted compiles cleanly and fails at
//! the moment a user clicks something — which is precisely the class of bug the
//! generated TypeScript types cannot catch, because they describe the pod's spec
//! rather than this crate's structs.
//!
//! Skipped unless `TEST_AGENT_URL` is set:
//!
//! ```bash
//! metalcraft-daemon --api k --api-port 8801 &
//! TEST_AGENT_URL=http://localhost:8801 TEST_AGENT_KEY=k \
//!   cargo test -p workshop-api --test agents_remote
//! ```
use workshop_api::agents::{InstancePatch, PackSource};
use workshop_api::connection::{NewChat, ProjectConnection, RemoteConnection};

fn connect() -> Option<RemoteConnection> {
    let url = std::env::var("TEST_AGENT_URL").ok()?;
    let key = std::env::var("TEST_AGENT_KEY").unwrap_or_else(|_| "k".into());
    RemoteConnection::new(url, key).ok()
}

macro_rules! agent {
    () => {
        match connect() {
            Some(c) => c,
            None => {
                eprintln!("skipping: TEST_AGENT_URL not set");
                return;
            }
        }
    };
}

#[tokio::test]
async fn presets_and_their_rosters_decode() {
    let conn = agent!();

    let presets = conn.list_agent_presets().await.expect("list presets");
    assert!(!presets.is_empty(), "a pod always seeds at least the default agent");

    let general = presets
        .iter()
        .find(|p| p.slug == "general-agent")
        .expect("the default agent must exist");
    assert!(!general.name.is_empty());
    assert!(!general.default_persona.is_empty());
    assert!(general.persona_count > 0, "a preset with no callable personas is unusable");

    let detail = conn.get_agent_preset(&general.slug).await.expect("get preset");
    assert_eq!(detail.preset.slug, general.slug);
    assert_eq!(
        detail.personas.len(),
        general.persona_count,
        "the resolved roster must match the count the list advertised"
    );
    // The whole point of the resolved roster: `installed` is answerable per persona.
    assert!(
        detail.personas.iter().any(|p| p.installed),
        "a seeded preset's personas should be installed"
    );
    assert!(
        detail.personas.iter().any(|p| p.slug == detail.preset.default_persona),
        "the default persona must appear in the roster it is the default of"
    );

    // Local and remote must agree about what "callable" means, or the desktop app's
    // two data sources would offer different personas for the same preset.
    let mut from_document = detail.preset.callable_personas();
    let mut from_api: Vec<String> = detail.personas.iter().map(|p| p.slug.clone()).collect();
    from_document.sort();
    from_api.sort();
    assert_eq!(from_document, from_api);
}

#[tokio::test]
async fn an_agent_can_be_minted_renamed_and_deleted() {
    let conn = agent!();

    let created = conn
        .create_agent_instance(Some("general-agent"), Some("Workshop test agent"))
        .await
        .expect("create instance");
    assert_eq!(created.agent_preset, "general-agent");
    assert!(created.persistent, "an explicitly created agent is one you meant to keep");
    assert!(!created.persona.is_empty());

    let listed = conn.list_agent_instances().await.expect("list instances");
    let found = listed
        .iter()
        .find(|i| i.id == created.id)
        .expect("a created agent must appear in the list");
    assert_eq!(
        found.conversation_count,
        Some(0),
        "the list carries conversation counts; a fresh agent has none"
    );

    let detail = conn.get_agent_instance(&created.id).await.expect("get instance");
    assert_eq!(detail.instance.id, created.id);
    assert!(detail.conversations.is_empty());
    assert!(detail.scheduled.is_empty(), "a fresh agent runs no flows");

    // Renaming is also the one-click promotion to persistent.
    let renamed = conn
        .patch_agent_instance(
            &created.id,
            &InstancePatch { name: Some("Renamed".into()), ..Default::default() },
        )
        .await
        .expect("rename");
    assert_eq!(renamed.name, "Renamed");
    assert!(renamed.persistent);

    // A persona outside the preset's roster is refused — containment, from the client's
    // side of the wire.
    let err = conn
        .patch_agent_instance(
            &created.id,
            &InstancePatch { persona: Some("not-in-this-roster".into()), ..Default::default() },
        )
        .await
        .expect_err("a persona outside the roster must be rejected");
    assert!(format!("{err}").contains("not-in-this-roster"), "{err}");

    // What it knows — empty, but the shape must decode.
    let memory = conn
        .agent_instance_memory(&created.id, Some(5))
        .await
        .expect("instance memory");
    assert_eq!(memory.learned, 0);
    assert!(memory.sample.len() <= 5);

    let kept = conn.delete_agent_instance(&created.id).await.expect("delete");
    assert_eq!(kept, 0, "no conversations to keep");
}

#[tokio::test]
async fn a_chat_can_be_started_as_an_agent() {
    let conn = agent!();

    let instance = conn
        .create_agent_instance(Some("general-agent"), Some("Chat host"))
        .await
        .expect("create instance");

    // The picker's actual call: an agent, no persona.
    let chat = conn
        .create_chat(&NewChat {
            agent_preset: Some("general-agent"),
            instance_id: Some(&instance.id),
            ..Default::default()
        })
        .await
        .expect("a chat should start from an agent alone, with no persona named");
    assert_eq!(
        chat.instance_id.as_deref(),
        Some(instance.id.as_str()),
        "the chat must belong to the agent it was started as"
    );
    assert!(!chat.persona_slug.is_empty(), "the preset's default persona fills in");

    // The Advanced path: an explicit persona inside the roster.
    let advanced = conn
        .create_chat(&NewChat {
            agent_preset: Some("general-agent"),
            persona_slug: Some("coding-agent"),
            ..Default::default()
        })
        .await
        .expect("an in-roster persona is allowed");
    assert_eq!(advanced.persona_slug, "coding-agent");

    // Outside the roster is not.
    let err = conn
        .create_chat(&NewChat {
            agent_preset: Some("general-agent"),
            persona_slug: Some("morning-briefer"),
            ..Default::default()
        })
        .await
        .expect_err("a persona outside the preset's roster must be refused");
    assert!(format!("{err}").contains("morning-briefer"), "{err}");

    // Nothing named at all still works — that is the pre-preset behaviour, preserved.
    let bare = conn.create_chat(&NewChat::default()).await.expect("a bare chat");
    assert!(!bare.persona_slug.is_empty());

    for id in [chat.id, advanced.id, bare.id] {
        let _ = conn.delete_chat(&id).await;
    }
    let _ = conn.delete_agent_instance(&instance.id).await;
}

#[tokio::test]
async fn the_snapshot_carries_agents() {
    let conn = agent!();
    let snap = conn.snapshot().await.expect("snapshot");
    assert!(!snap.agent_presets.is_empty(), "one round-trip must paint the agent picker");
    assert!(
        snap.default_agent_preset.is_some(),
        "the picker needs to know what to select by default"
    );
    assert!(snap.layout.has_agent_presets);
    assert!(snap.layout.has_agent_instances);
}

#[tokio::test]
async fn an_agent_pack_can_be_inspected_before_it_is_installed() {
    let conn = agent!();
    let Ok(url) = std::env::var("TEST_AGENTPACK_URL") else {
        eprintln!("skipping: TEST_AGENTPACK_URL not set (needs a registry the pod allowlists)");
        return;
    };

    // The pod says what it will accept before anyone pastes a link.
    let registries = conn.agent_pack_registries().await.expect("registries");
    assert!(!registries.is_empty(), "a pod that can install must say from where");

    // ── inspect grants nothing ──────────────────────────────────────────────
    let before: Vec<String> =
        conn.list_agent_packs().await.expect("list").into_iter().map(|p| p.id).collect();

    let preview = conn
        .inspect_agent_pack(&PackSource::Url(url.clone()))
        .await
        .expect("inspect a pack the pod is allowed to fetch");
    assert!(!preview.manifest.id.is_empty());
    assert!(preview.preset.is_some(), "an agent pack provides exactly one preset");
    assert_eq!(preview.content_sha256.len(), 64, "the hash of what is about to be installed");
    // The consent summary is what makes this a decision rather than a surprise.
    assert!(
        !preview.consent.domains.is_empty(),
        "a pack with HTTP tools must disclose the origins it reaches"
    );
    assert!(!preview.consent.tools.is_empty());

    let after: Vec<String> =
        conn.list_agent_packs().await.expect("list").into_iter().map(|p| p.id).collect();
    assert_eq!(before, after, "inspecting must not install");

    // ── an origin the pod does not trust is refused ─────────────────────────
    let err = conn
        .inspect_agent_pack(&PackSource::Url("https://evil.example/x.agentpack".into()))
        .await
        .expect_err("an origin outside the allowlist must be refused");
    assert!(format!("{err}").contains("origin"), "{err}");

    // ── install, then the same inspect reports it as an upgrade ─────────────
    let report = conn
        .install_agent_pack(&PackSource::Url(url.clone()))
        .await
        .expect("install from the inspected url");
    assert_eq!(report.id, preview.manifest.id);
    assert_eq!(report.version, preview.manifest.version);

    let again = conn.inspect_agent_pack(&PackSource::Url(url)).await.expect("re-inspect");
    assert_eq!(
        again.installed_version.as_deref(),
        Some(report.version.as_str()),
        "a second look must say this is already installed"
    );

    // The preset it provides is now something a chat can start as.
    let presets = conn.list_agent_presets().await.expect("presets");
    let slug = preview.preset.clone().unwrap();
    assert!(
        presets.iter().any(|p| p.slug == slug),
        "installing a pack must make its agent pickable: {slug}"
    );

    // ── uninstall takes it away again ───────────────────────────────────────
    let un = conn
        .uninstall_agent_pack(&report.id, true)
        .await
        .expect("uninstall");
    assert_eq!(un.id, report.id);
    assert!(
        un.packs_freed > 0,
        "the last reference to its vendored packs should have been released"
    );
    assert!(
        !conn.list_agent_packs().await.expect("list").iter().any(|p| p.id == report.id),
        "an uninstalled pack must be gone"
    );
}

#[tokio::test]
async fn a_preset_round_trips_through_export_and_install() {
    let conn = agent!();

    // Export what this pod already is…
    let bytes = conn
        .export_agent_pack("general-agent", "9.9.9")
        .await
        .expect("export the default agent");
    assert!(bytes.len() > 1000, "an archive should not be empty: {} bytes", bytes.len());

    // …and the pod must accept its own output. An export the installer rejects is
    // the failure mode worth guarding: both sides are ours, so nothing else would
    // catch it.
    let preview = conn
        .inspect_agent_pack(&PackSource::Bytes(bytes))
        .await
        .expect("a pod must be able to read back what it exported");
    assert_eq!(preview.manifest.version, "9.9.9");
    assert_eq!(preview.preset.as_deref(), Some("general-agent"));
    assert!(
        preview.preset_collisions.contains(&"general-agent".to_string()),
        "the seeded preset already owns this slug, and the dialog should say so"
    );
}

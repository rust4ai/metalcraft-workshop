//! Skill file I/O. A skill is a Markdown file with optional YAML frontmatter
//! holding `description: <one-line>`. The frontmatter helpers mirror the
//! parsing in `metalcraft-agent/src/persona.rs`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub slug: String,
    pub description: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSummary {
    pub slug: String,
    pub description: String,
}

pub fn skills_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join("skills")
}

pub fn list(project_root: &Path) -> Vec<SkillSummary> {
    let dir = skills_dir(project_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<SkillSummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let slug = path.file_stem().and_then(|s| s.to_str())?.to_string();
            let content = std::fs::read_to_string(&path).ok()?;
            let description = parse_frontmatter_description(&content)
                .unwrap_or_else(|| "Specialized guidance".to_string());
            Some(SkillSummary { slug, description })
        })
        .collect();

    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn load(project_root: &Path, slug: &str) -> anyhow::Result<Skill> {
    let file = skills_dir(project_root).join(format!("{}.md", slug));
    let content = std::fs::read_to_string(&file)?;
    let description = parse_frontmatter_description(&content)
        .unwrap_or_else(|| "Specialized guidance".to_string());
    let body = strip_frontmatter(&content).to_string();
    Ok(Skill {
        slug: slug.to_string(),
        description,
        body,
    })
}

pub fn save(project_root: &Path, slug: &str, description: &str, body: &str) -> anyhow::Result<()> {
    let dir = skills_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.md", slug));
    let trimmed_body = body.trim_start_matches('\n');
    let assembled = format!("---\ndescription: {}\n---\n\n{}", description, trimmed_body);
    std::fs::write(&file, assembled)?;
    Ok(())
}

pub fn delete(project_root: &Path, slug: &str) -> anyhow::Result<()> {
    let file = skills_dir(project_root).join(format!("{}.md", slug));
    if file.exists() {
        std::fs::remove_file(&file)?;
    }
    Ok(())
}

pub fn parse_frontmatter_description(content: &str) -> Option<String> {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return None;
    }
    let after_open = &content[3..];
    let close_pos = after_open.find("\n---")?;
    let yaml_block = &after_open[..close_pos];
    for line in yaml_block.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("description:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

pub fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return content;
    }
    let after_open = &trimmed[3..];
    match after_open.find("\n---") {
        Some(pos) => {
            let after_close = &after_open[pos + 4..];
            after_close.trim_start_matches('\n')
        }
        None => content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_round_trip() {
        let raw = "---\ndescription: Hello world\n---\n\nBody text here.\n";
        assert_eq!(
            parse_frontmatter_description(raw).as_deref(),
            Some("Hello world")
        );
        assert_eq!(strip_frontmatter(raw), "Body text here.\n");
    }

    #[test]
    fn no_frontmatter() {
        let raw = "Just body, no header.";
        assert_eq!(parse_frontmatter_description(raw), None);
        assert_eq!(strip_frontmatter(raw), raw);
    }
}

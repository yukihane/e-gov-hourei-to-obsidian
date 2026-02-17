use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use clap::Parser;
use regex::Regex;
use reqwest::StatusCode;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Parser)]
#[command(author, version, about)]
struct Cli {
    law_title: String,
    #[arg(long, default_value = "laws")]
    output_dir: PathBuf,
    #[arg(long, default_value_t = 2)]
    max_depth: usize,
    #[arg(long)]
    no_overwrite: bool,
    #[arg(long, default_value = "https://laws.e-gov.go.jp")]
    api_base_url: String,
    #[arg(long)]
    non_interactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LawCandidate {
    law_id: String,
    law_num: Option<String>,
    law_title: String,
    promulgation_date: Option<String>,
}

#[derive(Debug, Clone)]
struct LawContents {
    law_id: String,
    law_num: Option<String>,
    law_title: String,
    rendered_markdown: String,
    original_xml: Option<String>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LawRef {
    law_title: String,
    article: String,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct UnresolvedRef {
    source_law: String,
    raw_text: String,
}

#[derive(Debug)]
struct ApiClient {
    client: Client,
    base_url: String,
}

impl ApiClient {
    fn new(base_url: String) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("HTTPクライアントの初期化に失敗しました")?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    fn get_json(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut last_err: Option<anyhow::Error> = None;

        for attempt in 0..3 {
            let res = self.client.get(&url).query(query).send();
            match res {
                Ok(resp) => {
                    let status = resp.status();
                    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                        std::thread::sleep(Duration::from_millis(400 * (attempt + 1) as u64));
                        continue;
                    }
                    if !status.is_success() {
                        let body = resp.text().unwrap_or_else(|_| "<no body>".to_string());
                        return Err(anyhow!("APIエラー {} {}: {}", status, url, body));
                    }
                    return resp
                        .json::<Value>()
                        .with_context(|| format!("JSON解析に失敗しました: {}", url));
                }
                Err(e) => {
                    last_err = Some(anyhow!(e).context(format!("API呼び出し失敗: {}", url)));
                    std::thread::sleep(Duration::from_millis(400 * (attempt + 1) as u64));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("API呼び出しに失敗しました: {}", url)))
    }

    fn search_laws(&self, law_title: &str) -> Result<Vec<LawCandidate>> {
        let json = self.get_json("/api/2/laws", &[("law_title", law_title)])?;
        parse_law_candidates(&json)
    }

    fn fetch_law_contents(&self, law_id: &str) -> Result<LawContents> {
        let json = self.get_json("/api/2/law_contents", &[("law_id", law_id)])?;
        parse_law_contents(&json)
    }
}

#[derive(Debug)]
struct Processor {
    api: ApiClient,
    output_dir: PathBuf,
    max_depth: usize,
    no_overwrite: bool,
    non_interactive: bool,
    file_by_law_id: HashMap<String, String>,
    title_by_law_id: HashMap<String, String>,
    unresolved_refs: HashSet<UnresolvedRef>,
}

impl Processor {
    fn run(&mut self, root_title: &str) -> Result<()> {
        fs::create_dir_all(&self.output_dir).with_context(|| {
            format!("出力ディレクトリ作成に失敗: {}", self.output_dir.display())
        })?;

        let mut queue = VecDeque::new();
        let mut visited = HashSet::new();
        queue.push_back((root_title.to_string(), 0usize));

        while let Some((title, depth)) = queue.pop_front() {
            if depth > self.max_depth {
                continue;
            }
            let candidate = self.resolve_candidate(&title)?;
            if !visited.insert(candidate.law_id.clone()) {
                continue;
            }

            eprintln!("取得中: {} ({})", candidate.law_title, candidate.law_id);
            let contents = self.api.fetch_law_contents(&candidate.law_id)?;
            let file_name = self.write_law_note(&contents, depth)?;
            self.file_by_law_id
                .insert(contents.law_id.clone(), file_name.clone());
            self.title_by_law_id
                .insert(contents.law_id.clone(), contents.law_title.clone());

            let refs = extract_external_references(&contents.rendered_markdown)?;
            for law_ref in refs {
                queue.push_back((law_ref.law_title, depth + 1));
            }
        }

        if !self.unresolved_refs.is_empty() {
            eprintln!("未解決参照:");
            for r in &self.unresolved_refs {
                eprintln!("  - [{}] {}", r.source_law, r.raw_text);
            }
        }
        Ok(())
    }

    fn resolve_candidate(&self, title: &str) -> Result<LawCandidate> {
        let mut candidates = self.api.search_laws(title)?;
        if candidates.is_empty() {
            bail!("法令が見つかりませんでした: {}", title);
        }
        if candidates.len() == 1 {
            return Ok(candidates.remove(0));
        }

        if self.non_interactive {
            let exact: Vec<_> = candidates
                .iter()
                .filter(|c| c.law_title == title)
                .cloned()
                .collect();
            if exact.len() == 1 {
                return Ok(exact[0].clone());
            }
            bail!(
                "法令名 '{}' は複数候補があります。--non-interactive では自動確定できません。",
                title
            );
        }

        println!("複数候補が見つかりました: {}", title);
        for (i, c) in candidates.iter().enumerate() {
            println!(
                "{}. {} / {} / {}",
                i + 1,
                c.law_title,
                c.law_num.as_deref().unwrap_or("-"),
                c.promulgation_date.as_deref().unwrap_or("-")
            );
        }
        print!("候補番号を入力してください: ");
        io::stdout().flush().context("標準出力flush失敗")?;
        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .context("入力読み取りに失敗")?;
        let idx: usize = input.trim().parse().context("数値を入力してください")?;
        if idx == 0 || idx > candidates.len() {
            bail!("候補番号が不正です");
        }
        Ok(candidates.remove(idx - 1))
    }

    fn write_law_note(&mut self, law: &LawContents, depth: usize) -> Result<String> {
        let file_name = sanitize_filename(&law.law_title);
        let path = self.output_dir.join(format!("{}.md", file_name));
        if self.no_overwrite && path.exists() {
            bail!("既存ファイルがあるためスキップ: {}", path.display());
        }

        let base_markdown = ensure_article_headings(&law.rendered_markdown)?;
        let (markdown, unresolved) =
            linkify_markdown(&base_markdown, &law.law_title, &self.output_dir)?;
        self.unresolved_refs
            .extend(unresolved.into_iter().map(|x| UnresolvedRef {
                source_law: law.law_title.clone(),
                raw_text: x,
            }));

        let frontmatter = format!(
            "---\nlaw_title: \"{}\"\nlaw_id: \"{}\"\nlaw_num: \"{}\"\nsource_api: \"v2\"\nfetched_at: \"{}\"\ndepth: {}\nhas_original_xml: {}\n---\n\n",
            escape_yaml(&law.law_title),
            escape_yaml(&law.law_id),
            escape_yaml(law.law_num.as_deref().unwrap_or("")),
            Utc::now().to_rfc3339(),
            depth,
            law.original_xml.is_some()
        );
        let body = format!("{}{}\n", frontmatter, markdown.trim_end_matches('\n'));
        fs::write(&path, body)
            .with_context(|| format!("ノート書き込み失敗: {}", path.display()))?;
        Ok(file_name)
    }
}

fn parse_law_candidates(v: &Value) -> Result<Vec<LawCandidate>> {
    let arr = pick_array(v, &["laws", "results", "data"])
        .ok_or_else(|| anyhow!("法令候補の配列が見つかりませんでした"))?;
    let mut out = Vec::new();
    for item in arr {
        let law_id = pick_str(item, &["law_id", "lawId", "id"])
            .ok_or_else(|| anyhow!("law_id がありません"))?
            .to_string();
        let law_title = pick_str(item, &["law_title", "lawTitle", "title", "name"])
            .ok_or_else(|| anyhow!("law_title がありません"))?
            .to_string();
        let law_num = pick_str(item, &["law_num", "lawNum", "number"]).map(ToString::to_string);
        let promulgation_date = pick_str(
            item,
            &["promulgation_date", "promulgationDate", "date_promulgation"],
        )
        .map(ToString::to_string);
        out.push(LawCandidate {
            law_id,
            law_num,
            law_title,
            promulgation_date,
        });
    }
    Ok(out)
}

fn parse_law_contents(v: &Value) -> Result<LawContents> {
    let data = pick_obj(v, &["law_contents", "result", "data"]).unwrap_or(v);
    let law_id = pick_str(data, &["law_id", "lawId", "id"])
        .ok_or_else(|| anyhow!("law_id がありません"))?
        .to_string();
    let law_num = pick_str(data, &["law_num", "lawNum", "number"]).map(ToString::to_string);
    let law_title = pick_str(data, &["law_title", "lawTitle", "title", "name"])
        .ok_or_else(|| anyhow!("law_title がありません"))?
        .to_string();
    let rendered_markdown = pick_str(data, &["rendered_markdown", "renderedMarkdown", "markdown"])
        .ok_or_else(|| anyhow!("rendered_markdown がありません"))?
        .to_string();
    let original_xml =
        pick_str(data, &["original_xml", "originalXml", "xml"]).map(ToString::to_string);

    Ok(LawContents {
        law_id,
        law_num,
        law_title,
        rendered_markdown,
        original_xml,
    })
}

fn pick_array<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .find_map(|k| v.get(*k))
        .and_then(|x| x.as_array())
        .or_else(|| v.as_array())
}

fn pick_obj<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k)).or_else(|| Some(v))
}

fn pick_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
            return Some(s);
        }
    }
    None
}

fn sanitize_filename(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_end_matches('.').to_string()
}

fn escape_yaml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn ensure_article_headings(markdown: &str) -> Result<String> {
    let article_re = Regex::new(
        r"(?m)^(第[0-9一二三四五六七八九十百千〇]+条(?:の[0-9一二三四五六七八九十百千〇]+)?)",
    )
    .context("条見出し正規表現の初期化に失敗")?;

    let mut out = String::new();
    for line in markdown.lines() {
        if line.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if let Some(caps) = article_re.captures(line) {
            let token = caps.get(1).map(|m| m.as_str()).unwrap_or(line);
            out.push_str("## ");
            out.push_str(token);
            out.push('\n');
            if line.trim() != token {
                out.push_str(line);
                out.push('\n');
            }
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    Ok(out)
}

fn extract_external_references(markdown: &str) -> Result<HashSet<LawRef>> {
    let ref_re = Regex::new(
        r"(?P<law>[ぁ-んァ-ヶー一-龥A-Za-z0-9・（）()「」『』]+?法)第(?P<article>[0-9一二三四五六七八九十百千〇]+)条",
    )
    .context("他法令参照正規表現の初期化に失敗")?;
    let mut out = HashSet::new();
    for caps in ref_re.captures_iter(markdown) {
        let law_title = caps.name("law").map(|m| m.as_str().to_string());
        let article = caps.name("article").map(|m| format!("第{}条", m.as_str()));
        if let (Some(law_title), Some(article)) = (law_title, article) {
            out.insert(LawRef { law_title, article });
        }
    }
    Ok(out)
}

fn linkify_markdown(
    markdown: &str,
    current_law_title: &str,
    output_dir: &Path,
) -> Result<(String, Vec<String>)> {
    let same_article_re = Regex::new(r"第(?P<n>[0-9一二三四五六七八九十百千〇]+)条")
        .context("同一法令条参照正規表現初期化失敗")?;
    let ext_article_re = Regex::new(
        r"(?P<law>[ぁ-んァ-ヶー一-龥A-Za-z0-9・（）()「」『』]+?法)第(?P<n>[0-9一二三四五六七八九十百千〇]+)条",
    )
    .context("他法令参照正規表現初期化失敗")?;
    let para_re = Regex::new(r"第(?P<n>[0-9一二三四五六七八九十百千〇]+)項")
        .context("項参照正規表現初期化失敗")?;
    let item_re = Regex::new(r"第(?P<n>[0-9一二三四五六七八九十百千〇]+)号")
        .context("号参照正規表現初期化失敗")?;

    let mut unresolved = Vec::new();
    let mut output = String::new();
    let mut last_article_anchor: Option<String> = None;
    let link_dir = obsidian_dir(output_dir);

    for line in markdown.lines() {
        if line.starts_with('#') || line.contains("[[") {
            output.push_str(line);
            output.push('\n');
            if let Some(anchor) = extract_heading_anchor(line) {
                last_article_anchor = Some(anchor);
            }
            continue;
        }

        let mut replaced = line.to_string();
        let mut ext_placeholders = Vec::new();
        replaced = ext_article_re
            .replace_all(&replaced, |caps: &regex::Captures<'_>| {
                let law = caps.name("law").map(|m| m.as_str()).unwrap_or("");
                let n = caps.name("n").map(|m| m.as_str()).unwrap_or("");
                let link = format!(
                    "[[{}#第{}条|{}第{}条]]",
                    obsidian_note_target(&link_dir, law),
                    n,
                    law,
                    n
                );
                let key = format!("__EXT_LINK_{}__", ext_placeholders.len());
                ext_placeholders.push((key.clone(), link));
                key
            })
            .to_string();

        replaced = same_article_re
            .replace_all(&replaced, |caps: &regex::Captures<'_>| {
                let n = caps.name("n").map(|m| m.as_str()).unwrap_or("");
                format!(
                    "[[{}#第{}条|第{}条]]",
                    obsidian_note_target(&link_dir, current_law_title),
                    n,
                    n
                )
            })
            .to_string();

        replaced = para_re
            .replace_all(&replaced, |caps: &regex::Captures<'_>| {
                let n = caps.name("n").map(|m| m.as_str()).unwrap_or("");
                if let Some(article) = &last_article_anchor {
                    format!(
                        "[[{}#{}|第{}項]]",
                        obsidian_note_target(&link_dir, current_law_title),
                        article,
                        n
                    )
                } else {
                    format!("第{}項", n)
                }
            })
            .to_string();

        replaced = item_re
            .replace_all(&replaced, |caps: &regex::Captures<'_>| {
                let n = caps.name("n").map(|m| m.as_str()).unwrap_or("");
                if let Some(article) = &last_article_anchor {
                    format!(
                        "[[{}#{}|第{}号]]",
                        obsidian_note_target(&link_dir, current_law_title),
                        article,
                        n
                    )
                } else {
                    format!("第{}号", n)
                }
            })
            .to_string();

        for (key, link) in ext_placeholders {
            replaced = replaced.replace(&key, &link);
        }

        for token in ["前条", "前項", "次条", "同条", "同項"] {
            if replaced.contains(token) {
                unresolved.push(token.to_string());
            }
        }

        if let Some(anchor) = extract_heading_anchor(&replaced) {
            last_article_anchor = Some(anchor);
        }
        output.push_str(&replaced);
        output.push('\n');
    }
    Ok((output, unresolved))
}

fn obsidian_dir(output_dir: &Path) -> String {
    let mut s = output_dir.to_string_lossy().replace('\\', "/");
    if s == "." {
        s.clear();
    }
    while s.starts_with("./") {
        s = s.trim_start_matches("./").to_string();
    }
    s.trim_matches('/').to_string()
}

fn obsidian_note_target(dir: &str, law_title: &str) -> String {
    let file = sanitize_filename(law_title);
    if dir.is_empty() {
        file
    } else {
        format!("{}/{}", dir, file)
    }
}

fn extract_heading_anchor(line: &str) -> Option<String> {
    let s = line.trim_start_matches('#').trim();
    if s.starts_with('第') && s.contains('条') {
        let end = s.find('条')?;
        Some(s[..=end].to_string())
    } else {
        None
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let api = ApiClient::new(cli.api_base_url)?;
    let mut processor = Processor {
        api,
        output_dir: cli.output_dir,
        max_depth: cli.max_depth,
        no_overwrite: cli.no_overwrite,
        non_interactive: cli.non_interactive,
        file_by_law_id: HashMap::new(),
        title_by_law_id: HashMap::new(),
        unresolved_refs: HashSet::new(),
    };

    processor.run(&cli.law_title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_replaces_forbidden_chars() {
        assert_eq!(sanitize_filename("民法/商法:テスト"), "民法_商法_テスト");
    }

    #[test]
    fn linkify_handles_external_and_internal_articles() {
        let md = "民法第2条及び第3条を参照する。";
        let (out, unresolved) = linkify_markdown(md, "刑法", Path::new("laws")).unwrap();
        assert!(out.contains("[[laws/民法#第2条|民法第2条]]"));
        assert!(out.contains("[[laws/刑法#第3条|第3条]]"));
        assert!(unresolved.is_empty());
    }
}

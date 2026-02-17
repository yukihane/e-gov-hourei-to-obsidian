use std::collections::{HashSet, VecDeque};
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

/// コマンドライン引数定義。
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

/// 法令検索結果から利用する最小単位の候補情報。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LawCandidate {
    law_id: Option<String>,
    law_num: Option<String>,
    law_title: String,
    promulgation_date: Option<String>,
}

/// 取得した法令本文をノート生成向けに正規化したデータ。
#[derive(Debug, Clone)]
struct LawContents {
    law_id: Option<String>,
    law_num: Option<String>,
    law_title: String,
    markdown: String,
    original_xml: Option<String>,
}

/// `/laws` エンドポイントのレスポンス。
#[derive(Debug, Clone, Deserialize)]
struct LawsResponse {
    laws: Vec<LawsResponseLaw>,
}

/// `/laws` の1件分データ。
#[derive(Debug, Clone, Deserialize)]
struct LawsResponseLaw {
    law_info: LawsLawInfo,
    revision_info: LawsRevisionInfo,
}

/// 改正履歴に依存しない法令情報。
#[derive(Debug, Clone, Deserialize)]
struct LawsLawInfo {
    law_id: String,
    law_num: Option<String>,
    promulgation_date: Option<String>,
}

/// 改正履歴に依存する法令情報。
#[derive(Debug, Clone, Deserialize)]
struct LawsRevisionInfo {
    law_title: String,
}

/// `/law_data/{law_id_or_num_or_revision_id}` のレスポンス。
#[derive(Debug, Clone, Deserialize)]
struct LawDataResponse {
    law_info: LawsLawInfo,
    revision_info: LawsRevisionInfo,
    law_full_text: Value,
}

/// 本文中の他法令参照（再帰取得キュー用）。
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LawRef {
    law_title: String,
    article: String,
}

/// 自動解決できなかった相対参照。
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct UnresolvedRef {
    source_law: String,
    raw_text: String,
}

/// e-Gov法令API v2 クライアント。
#[derive(Debug)]
struct ApiClient {
    client: Client,
    base_url: String,
}

impl ApiClient {
    /// APIクライアントを初期化する。
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

    /// 指定パスへGETし、JSONレスポンスを返す。
    fn get_json(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut last_err: Option<anyhow::Error> = None;

        // 一時的障害（5xx, 429）を吸収するため軽いリトライを行う。
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

    /// 法令名で候補一覧を取得する。
    fn search_laws(&self, law_title: &str) -> Result<Vec<LawCandidate>> {
        let json = self.get_json("/api/2/laws", &[("law_title", law_title)])?;
        let parsed: LawsResponse =
            serde_json::from_value(json).context("法令一覧レスポンスの型変換に失敗しました")?;
        parse_law_candidates(parsed)
    }

    /// 法令IDまたは法令番号で本文を取得する。
    fn fetch_law_contents(&self, candidate: &LawCandidate) -> Result<LawContents> {
        let id_or_num = candidate
            .law_id
            .as_deref()
            .or(candidate.law_num.as_deref())
            .ok_or_else(|| anyhow!("law_id/law_num がありません"))?;
        let path = format!("/api/2/law_data/{}", id_or_num);
        let json = self.get_json(
            &path,
            &[
                ("response_format", "json"),
                ("law_full_text_format", "json"),
            ],
        )?;
        let parsed: LawDataResponse =
            serde_json::from_value(json).context("法令本文レスポンスの型変換に失敗しました")?;
        parse_law_contents(parsed)
    }
}

/// 取得・変換・出力の全体処理を担う実行器。
#[derive(Debug)]
struct Processor {
    api: ApiClient,
    output_dir: PathBuf,
    max_depth: usize,
    no_overwrite: bool,
    non_interactive: bool,
    unresolved_refs: HashSet<UnresolvedRef>,
}

impl Processor {
    /// 指定法令名から再帰取得を実行し、ノートを生成する。
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
            let candidate = match self.resolve_candidate(&title) {
                Ok(c) => c,
                Err(e) => {
                    if depth == 0 {
                        return Err(e);
                    }
                    eprintln!("警告: 参照先法令の解決に失敗したためスキップ: {} ({})", title, e);
                    continue;
                }
            };
            let visit_key = candidate.identity_key();
            if !visited.insert(visit_key) {
                continue;
            }

            eprintln!(
                "取得中: {} ({})",
                candidate.law_title,
                candidate.id_display()
            );
            let contents = self.api.fetch_law_contents(&candidate)?;
            self.write_law_note(&contents, depth)?;

            let refs = extract_external_references(&contents.markdown)?;
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

    /// 候補が複数ある場合は対話選択して1件に確定する。
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
                "{}. {} / {} / {} / {}",
                i + 1,
                c.law_title,
                c.id_display(),
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

    /// 1法令分のMarkdownノートを書き出す。
    fn write_law_note(&mut self, law: &LawContents, depth: usize) -> Result<String> {
        let file_name = sanitize_filename(&law.law_title);
        let path = self.output_dir.join(format!("{}.md", file_name));
        if self.no_overwrite && path.exists() {
            bail!("既存ファイルがあるためスキップ: {}", path.display());
        }

        let base_markdown = ensure_article_headings(&law.markdown)?;
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
            escape_yaml(law.law_id.as_deref().unwrap_or("")),
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

/// `/laws` レスポンスを内部候補型へ変換する。
fn parse_law_candidates(v: LawsResponse) -> Result<Vec<LawCandidate>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in v.laws {
        let law_id = Some(item.law_info.law_id);
        let law_num = item.law_info.law_num;
        let law_title = item.revision_info.law_title;
        let promulgation_date = item.law_info.promulgation_date;
        let key = format!(
            "{}|{}|{}",
            law_id.clone().unwrap_or_default(),
            law_num.clone().unwrap_or_default(),
            &law_title
        );
        if seen.insert(key) {
            out.push(LawCandidate {
                law_id,
                law_num,
                law_title,
                promulgation_date,
            });
        }
    }
    Ok(out)
}

/// `/law_data` レスポンスを内部本文型へ変換する。
fn parse_law_contents(v: LawDataResponse) -> Result<LawContents> {
    let markdown = law_full_text_json_to_markdown(&v.law_full_text)?;

    Ok(LawContents {
        law_id: Some(v.law_info.law_id),
        law_num: v.law_info.law_num,
        law_title: v.revision_info.law_title,
        markdown,
        original_xml: None,
    })
}

/// ノート名として使えない文字を安全な文字へ置換する。
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

/// YAML文字列として安全に埋め込める形へエスケープする。
fn escape_yaml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// `law_full_text`（JSON木）から読みやすいテキストを抽出する。
fn law_full_text_json_to_markdown(v: &Value) -> Result<String> {
    let mut out = String::new();
    append_law_text(v, &mut out);

    let ws_re = Regex::new(r"[ \t]+").context("空白正規表現の初期化に失敗")?;
    let mut text = ws_re.replace_all(&out, " ").to_string();
    let nl_re = Regex::new(r"\n{3,}").context("改行正規表現の初期化に失敗")?;
    text = nl_re.replace_all(&text, "\n\n").to_string();

    let text = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        bail!("law_full_text から本文テキストを抽出できませんでした")
    }
    Ok(text)
}

/// `law_full_text` の再帰木を走査し、文字列を連結する。
fn append_law_text(v: &Value, out: &mut String) {
    // 条文構造に対応するタグ前後で改行を入れ、可読性を確保する。
    match v {
        Value::String(s) => {
            out.push_str(s);
        }
        Value::Array(arr) => {
            for item in arr {
                append_law_text(item, out);
            }
        }
        Value::Object(map) => {
            let tag = map.get("tag").and_then(Value::as_str).unwrap_or("");
            let is_block = matches!(
                tag,
                "Law"
                    | "LawBody"
                    | "MainProvision"
                    | "Part"
                    | "Chapter"
                    | "Section"
                    | "Subsection"
                    | "Division"
                    | "Article"
                    | "Paragraph"
                    | "Item"
                    | "Subitem"
                    | "SupplProvision"
                    | "AppdxTable"
                    | "AppdxNote"
                    | "AppdxStyle"
                    | "Appdx"
            );
            if is_block && !out.ends_with('\n') {
                out.push('\n');
            }

            if let Some(children) = map.get("children") {
                append_law_text(children, out);
            } else {
                for val in map.values() {
                    append_law_text(val, out);
                }
            }
            if is_block && !out.ends_with('\n') {
                out.push('\n');
            }
        }
        _ => {}
    }
}

/// 「第X条」行に見出しを補い、Obsidianアンカー解決しやすくする。
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

/// 他法令参照（○○法第X条）を抽出して再帰取得候補を作る。
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

/// 本文中の条・項・号参照をObsidian Wikiリンクへ変換する。
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

/// 出力ディレクトリをObsidianリンク用の相対ディレクトリ文字列へ正規化する。
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

/// 法令名から `dir/filename` 形式のリンク先を作る。
fn obsidian_note_target(dir: &str, law_title: &str) -> String {
    let file = sanitize_filename(law_title);
    if dir.is_empty() {
        file
    } else {
        format!("{}/{}", dir, file)
    }
}

/// 見出し行から `第X条` のアンカー名を抽出する。
fn extract_heading_anchor(line: &str) -> Option<String> {
    let s = line.trim_start_matches('#').trim();
    if s.starts_with('第') && s.contains('条') {
        let end = s.find('条')?;
        Some(s[..end + '条'.len_utf8()].to_string())
    } else {
        None
    }
}

/// エントリーポイント。
fn main() -> Result<()> {
    let cli = Cli::parse();
    let api = ApiClient::new(cli.api_base_url)?;
    let mut processor = Processor {
        api,
        output_dir: cli.output_dir,
        max_depth: cli.max_depth,
        no_overwrite: cli.no_overwrite,
        non_interactive: cli.non_interactive,
        unresolved_refs: HashSet::new(),
    };

    processor.run(&cli.law_title)
}

impl LawCandidate {
    /// 訪問済み判定用の一意キーを返す。
    fn identity_key(&self) -> String {
        if let Some(id) = &self.law_id {
            return format!("id:{}", id);
        }
        if let Some(num) = &self.law_num {
            return format!("num:{}", num);
        }
        format!("title:{}", self.law_title)
    }

    /// ログ表示用の識別子（主に法令ID）を返す。
    fn id_display(&self) -> &str {
        self.law_id.as_deref().unwrap_or("-")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ファイル名禁止文字が置換されることを確認する。
    #[test]
    fn sanitize_filename_replaces_forbidden_chars() {
        assert_eq!(sanitize_filename("民法/商法:テスト"), "民法_商法_テスト");
    }

    /// 同一法令・他法令の条文リンク化が機能することを確認する。
    #[test]
    fn linkify_handles_external_and_internal_articles() {
        let md = "民法第2条及び第3条を参照する。";
        let (out, unresolved) = linkify_markdown(md, "刑法", Path::new("laws")).unwrap();
        assert!(out.contains("[[laws/民法#第2条|民法第2条]]"));
        assert!(out.contains("[[laws/刑法#第3条|第3条]]"));
        assert!(unresolved.is_empty());
    }

    /// `law_full_text` JSON木から本文テキストを抽出できることを確認する。
    #[test]
    fn law_full_text_json_to_markdown_extracts_text() {
        let json = serde_json::json!({
            "tag": "Law",
            "children": [{
                "tag": "Article",
                "children": [
                    {"tag":"ArticleTitle","children":["第一条"]},
                    {"tag":"Paragraph","children":[{"tag":"Sentence","children":["この法律は、テストとする。"]}]}
                ]
            }]
        });
        let out = law_full_text_json_to_markdown(&json).unwrap();
        assert!(out.contains("第一条"));
        assert!(out.contains("この法律は、テストとする。"));
    }

    /// 実レスポンスの `/laws` フィクスチャを型変換できることを確認する。
    #[test]
    fn parse_laws_response_from_fixture() {
        let raw = include_str!("../tests/fixtures/laws_tokkyoho.json");
        let resp: LawsResponse = serde_json::from_str(raw).unwrap();
        let candidates = parse_law_candidates(resp).unwrap();
        assert!(!candidates.is_empty());
        assert!(candidates.iter().any(|c| c.law_title == "特許法"));
        assert!(
            candidates
                .iter()
                .any(|c| c.law_id.as_deref() == Some("334AC0000000121"))
        );
    }

    /// 実レスポンスの `/law_data` フィクスチャを本文へ変換できることを確認する。
    #[test]
    fn parse_law_data_response_from_fixture() {
        let raw = include_str!("../tests/fixtures/law_data_tokkyoho.json");
        let resp: LawDataResponse = serde_json::from_str(raw).unwrap();
        let contents = parse_law_contents(resp).unwrap();
        assert_eq!(contents.law_id.as_deref(), Some("334AC0000000121"));
        assert_eq!(contents.law_title, "特許法");
        assert!(contents.markdown.contains("第一条"));
        assert!(contents.markdown.contains("この法律は"));
    }
}

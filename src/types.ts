export interface CliOptions {
  lawId?: string;
  lawTitle?: string;
  buildDictionary: boolean;
  maxDepth: number;
  ifExists: 'overwrite' | 'skip';
  retry: number;
  timeoutMs: number;
  dictionaryPath: string;
  dictionaryAutoupdate: boolean;
  unresolvedPath: string;
  outputDir: string;
  apiBaseUrl: string;
}

export interface LawCandidate {
  law_id?: string;
  law_num?: string;
  law_title: string;
  promulgation_date?: string;
}

export interface LawDictionaryEntry {
  title: string;
  safe_title: string;
  file_name: string;
  updated_at: string;
}

export type LawDictionary = Record<string, LawDictionaryEntry>;

export interface UnresolvedRefRecord {
  timestamp: string;
  root_law_id: string;
  root_law_title: string;
  from_anchor: string;
  raw_text: string;
  href: string;
  reason: 'target_not_built' | 'unknown_format' | 'depth_limit';
}

export interface SegmentText {
  type: 'text';
  text: string;
}

export interface SegmentLink {
  type: 'link';
  text: string;
  href: string;
}

export type ParagraphSegment = SegmentText | SegmentLink;

export interface ArticleParagraph {
  anchor: string;
  segments: ParagraphSegment[];
}

export interface ArticleBlock {
  id: string;
  heading: string;
  paragraphs: ArticleParagraph[];
}

export interface ScrapedLawDocument {
  lawId: string;
  title: string;
  sourceUrl: string;
  blocks: ArticleBlock[];
}

export interface QueueItem {
  lawId: string;
  titleHint?: string;
  depth: number;
}

export interface ProcessContext {
  rootLawId: string;
  rootLawTitle: string;
  unresolved: UnresolvedRefRecord[];
  unresolvedSeen: Set<string>;
}

export interface ExistingReferenceScanResult {
  referencedLawIds: string[];
}

export interface LawDataResponse {
  law_info?: Record<string, unknown>;
  revision_info?: Record<string, unknown>;
}

export type ExistingNoteIndex = Map<string, string[]>;

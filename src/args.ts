import {
  DEFAULT_API_BASE,
  DEFAULT_DICTIONARY_PATH,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_UNRESOLVED_PATH,
} from './config.js';
import type { CliOptions } from './types.js';

/**
 * CLI引数を解釈し、処理に必要なオプションを構築する。
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    buildDictionary: false,
    maxDepth: 1,
    ifExists: 'overwrite',
    retry: 3,
    timeoutMs: 30_000,
    dictionaryPath: DEFAULT_DICTIONARY_PATH,
    dictionaryAutoupdate: false,
    unresolvedPath: DEFAULT_UNRESOLVED_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    apiBaseUrl: DEFAULT_API_BASE,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--law-id') {
      options.lawId = argv[++i];
      continue;
    }
    if (arg === '--build-dictionary') {
      options.buildDictionary = true;
      continue;
    }
    if (arg === '--max-depth') {
      options.maxDepth = Number(argv[++i]);
      continue;
    }
    if (arg === '--if-exists') {
      const v = argv[++i];
      if (v !== 'overwrite' && v !== 'skip') {
        throw new Error(`--if-exists は overwrite または skip を指定してください: ${v}`);
      }
      options.ifExists = v;
      continue;
    }
    if (arg === '--retry') {
      options.retry = Number(argv[++i]);
      continue;
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === '--dictionary') {
      options.dictionaryPath = argv[++i];
      continue;
    }
    if (arg === '--dictionary-autoupdate') {
      options.dictionaryAutoupdate = true;
      continue;
    }
    if (arg === '--unresolved-path') {
      options.unresolvedPath = argv[++i];
      continue;
    }
    if (arg === '--output-dir') {
      options.outputDir = argv[++i];
      continue;
    }
    if (arg === '--api-base-url') {
      options.apiBaseUrl = argv[++i];
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`未対応オプションです: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    options.lawTitle = positional.join(' ');
  }

  if (!options.buildDictionary && !options.lawId && !options.lawTitle) {
    throw new Error('法令名または --law-id を指定してください');
  }
  if (options.maxDepth < 0 || Number.isNaN(options.maxDepth)) {
    throw new Error('--max-depth は0以上の整数にしてください');
  }
  if (options.retry <= 0 || Number.isNaN(options.retry)) {
    throw new Error('--retry は1以上の整数にしてください');
  }
  if (options.timeoutMs <= 0 || Number.isNaN(options.timeoutMs)) {
    throw new Error('--timeout-ms は1以上の整数にしてください');
  }

  return options;
}

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionEntry } from 'astro:content';
import knowledgeBaseConfig from '../data/knowledge-base-config.json';
import knowledgeBaseLastModified from '../data/knowledge-base-last-modified.json';
import knowledgeBaseTopics from '../data/knowledge-base-topics.json';

export interface KnowledgeBaseTopic {
  id: string;
  label: string;
  description: string;
  legacyIndex?: boolean;
}

export interface KnowledgeBaseArticle {
  slug: string;
  title: string;
  description: string;
  href: string;
  topics: string[];
  lastModified: Date;
}

interface KnowledgeBaseConfig {
  featuredArticleSlugs: string[];
  contextualSearchBoost: number;
  historyBaseCommit: string;
  bulkCommitArticleThreshold: number;
}

export const kbConfig = knowledgeBaseConfig as KnowledgeBaseConfig;
export const kbTopics = knowledgeBaseTopics as KnowledgeBaseTopic[];

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const workspaceRoot = path.resolve(projectRoot, '..');
const docsPathPrefix = 'astro-docs/src/content/docs/';
const kbPathPrefix = `${docsPathPrefix}kb/`;

let cachedLastModifiedDates: Map<string, Date> | undefined;

function getBaselineDates(): Map<string, Date> {
  return new Map(
    Object.entries(knowledgeBaseLastModified).map(([slug, date]) => [
      slug,
      new Date(date),
    ])
  );
}

function runGit(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function normalizeRoute(route: string): string {
  const normalized = route.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return normalized || '/';
}

function routeFromSourceFile(file: string): string {
  const route = file
    .replace(new RegExp(`^${docsPathPrefix}`), '')
    .replace(/\.m(?:doc|dx)$/, '')
    .split('/')
    .map((segment) =>
      segment
        .toLowerCase()
        .replaceAll(' ', '-')
        .replace(/[^a-z0-9_-]/g, '')
    )
    .join('/')
    .replace(/\/index$/, '');

  return `/docs/${route}`;
}

function parseRedirects(): Array<{ from: string; to: string }> {
  const source = readFileSync(path.join(projectRoot, 'netlify.toml'), 'utf8');
  return [
    ...source.matchAll(/\[\[redirects\]\]([\s\S]*?)(?=\n\[\[redirects\]\]|$)/g),
  ].flatMap((match) => {
    const from = match[1].match(/^from\s*=\s*"([^"]+)"/m)?.[1];
    const to = match[1].match(/^to\s*=\s*"([^"]+)"/m)?.[1];
    if (!from || !to || /[*:]/.test(from)) return [];
    return [{ from: normalizeRoute(from), to: normalizeRoute(to) }];
  });
}

function parseLatestDates(gitLog: string): Map<string, Date> {
  const dates = new Map<string, Date>();
  let currentDate: Date | undefined;

  for (const line of gitLog.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      currentDate = new Date(Number(line.slice(2)) * 1000);
      continue;
    }

    if (!currentDate || !line || dates.has(line)) continue;
    dates.set(line, currentDate);
  }

  return dates;
}

function getLegacyDates(): Map<string, Date> {
  const tree = runGit([
    'ls-tree',
    '-r',
    '--name-only',
    kbConfig.historyBaseCommit,
    '--',
    'astro-docs/src/content/docs',
  ]);
  if (!tree) return new Map();

  const sourceByRoute = new Map(
    tree
      .split(/\r?\n/)
      .filter((file) => /\.m(?:doc|dx)$/.test(file))
      .map((file) => [routeFromSourceFile(file), file])
  );

  const sourcesByTarget = new Map<string, string[]>();
  for (const redirect of parseRedirects()) {
    const sources = sourcesByTarget.get(redirect.to) ?? [];
    sources.push(redirect.from);
    sourcesByTarget.set(redirect.to, sources);
  }

  function findSources(target: string, seen = new Set<string>()): string[] {
    if (seen.has(target)) return [];
    seen.add(target);
    return (sourcesByTarget.get(target) ?? []).flatMap((source) => [
      source,
      ...findSources(source, seen),
    ]);
  }

  const legacySourceBySlug = new Map<string, string>();
  const articleTargets = [
    ...new Set(
      parseRedirects()
        .map((redirect) => redirect.to)
        .filter((target) => target.startsWith('/docs/kb/'))
    ),
  ];

  for (const target of articleTargets) {
    const slug = target.slice('/docs/kb/'.length);
    const sourceRoute = findSources(target).find((source) =>
      sourceByRoute.has(source)
    );
    if (sourceRoute) {
      legacySourceBySlug.set(slug, sourceByRoute.get(sourceRoute)!);
    }
  }

  const sourceFiles = [...new Set(legacySourceBySlug.values())];
  const gitLog = runGit([
    'log',
    kbConfig.historyBaseCommit,
    '--format=@@%ct',
    '--name-only',
    '--',
    ...sourceFiles,
  ]);
  const latestDateBySource = parseLatestDates(gitLog);

  return new Map(
    [...legacySourceBySlug].flatMap(([slug, source]) => {
      const date = latestDateBySource.get(source);
      return date ? [[slug, date] as const] : [];
    })
  );
}

function getPostMigrationDates(): Map<string, Date> {
  const gitLog = runGit([
    'log',
    '--format=@@%ct',
    '--name-only',
    '--',
    'astro-docs/src/content/docs/kb',
  ]);
  if (!gitLog) return new Map();

  const dates = new Map<string, Date>();
  const commits = gitLog
    .split(/^@@/m)
    .map((commit) => commit.trim())
    .filter(Boolean);

  for (const commit of commits) {
    const [timestamp, ...files] = commit.split(/\r?\n/);
    const articleFiles = [
      ...new Set(
        files.filter(
          (file) => file.startsWith(kbPathPrefix) && /\.m(?:doc|dx)$/.test(file)
        )
      ),
    ];

    if (
      articleFiles.length === 0 ||
      articleFiles.length > kbConfig.bulkCommitArticleThreshold
    ) {
      continue;
    }

    const date = new Date(Number(timestamp) * 1000);
    for (const file of articleFiles) {
      const slug = path.basename(file).replace(/\.m(?:doc|dx)$/, '');
      if (!dates.has(slug)) dates.set(slug, date);
    }
  }

  return dates;
}

export function getKnowledgeBaseLastModifiedDates(): Map<string, Date> {
  if (cachedLastModifiedDates) return cachedLastModifiedDates;

  const dates = getBaselineDates();
  for (const [slug, date] of getLegacyDates()) {
    dates.set(slug, date);
  }
  for (const [slug, date] of getPostMigrationDates()) {
    dates.set(slug, date);
  }

  cachedLastModifiedDates = dates;
  return dates;
}

export function getKnowledgeBaseArticles(
  docs: CollectionEntry<'docs'>[]
): KnowledgeBaseArticle[] {
  const lastModifiedDates = getKnowledgeBaseLastModifiedDates();

  return docs
    .filter((doc) => doc.id.startsWith('kb/'))
    .map((doc) => {
      const slug = doc.id.slice('kb/'.length);
      const lastModified = lastModifiedDates.get(slug);
      if (!lastModified) {
        throw new Error(
          `Could not resolve the last modified date for ${doc.id}`
        );
      }

      return {
        slug,
        title: doc.data.title,
        description: doc.data.description,
        href: `/docs/kb/${slug}`,
        topics: doc.data.topics ?? [],
        lastModified,
      };
    });
}

export function getTopicId(label: string): string {
  const topic = kbTopics.find((candidate) => candidate.label === label);
  if (!topic) throw new Error(`Unknown Knowledge Base topic: ${label}`);
  return topic.id;
}

export function sortArticlesByTitle(
  articles: KnowledgeBaseArticle[]
): KnowledgeBaseArticle[] {
  return [...articles].sort((left, right) =>
    left.title.localeCompare(right.title)
  );
}

export function sortArticlesByLastModified(
  articles: KnowledgeBaseArticle[]
): KnowledgeBaseArticle[] {
  return [...articles].sort(
    (left, right) =>
      right.lastModified.getTime() - left.lastModified.getTime() ||
      left.title.localeCompare(right.title)
  );
}

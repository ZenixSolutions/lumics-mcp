#!/usr/bin/env node
/**
 * Verify that CHANGELOG.md's section for a version is a finished release note.
 *
 * `release.yml` used to check only that a heading for the tagged version existed.
 * That is satisfied by a section still full of scaffolding, and it was: `0.1.0`
 * published to npm with its section opening "Nothing below has shipped yet; this
 * section is the release note under construction and is finalised at tag time."
 * CHANGELOG.md ships inside the tarball, so the release announced on the registry
 * that it had not happened. Nothing caught it because nothing looked past the
 * heading. See issue #10.
 *
 * Usage:
 *   node scripts/check-changelog.mjs <version> [path/to/CHANGELOG.md]
 *
 * Exits 0 when the section is releasable, 1 otherwise, printing one
 * `::error` line per problem so the annotations surface in the Actions log.
 *
 * On what this can and cannot do: the structural checks — heading present,
 * dated, body non-empty, comparison link present — are exact. The scaffolding
 * check is a phrase list, and a phrase list only catches wording someone thought
 * to write down. It is not a substitute for reading the section before tagging;
 * it is a floor under the one failure that has already happened.
 *
 * Quoted text is excluded from the scaffolding scan — inline code, fenced code
 * blocks, blockquotes, and double-quoted spans. This was not foresight: the gate
 * failed its own first release, because the `0.1.2` entry describing this script
 * quotes the very phrase the script bans. A changelog that documents a
 * scaffolding phrase is not scaffolding, and a gate that cannot tell the
 * difference would push people to reword accurate notes to appease it.
 */

import { readFileSync } from 'node:fs';

/**
 * Wording that means "not finished". Matched case-insensitively, and only
 * within the version's own section — the file preamble legitimately contains
 * "not yet stable" and an `[Unreleased]` heading, and neither is a defect.
 */
const SCAFFOLDING = [
  'nothing below has shipped',
  'under construction',
  'finalised at tag time',
  'finalized at tag time',
  'release note under construction',
  'to be written',
  'not yet written',
  'coming soon',
  'fill in',
  'tbd',
  'todo',
  'fixme',
  'lorem ipsum',
];

/**
 * Remove spans that are quoting rather than asserting: fenced code blocks,
 * inline code, blockquote lines, and double-quoted runs (straight or curly).
 *
 * Without this the gate cannot distinguish "this section is under construction"
 * from a note explaining that a previous release said it was. The trade-off is
 * accepted deliberately: scaffolding a human left behind is not usually in
 * quotes, and a changelog quoting it almost always is.
 *
 * @param {string} body
 * @returns {string}
 */
function stripQuoted(body) {
  return (
    body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n')
      // Quoted spans may wrap across lines — changelog prose is hard-wrapped, and
      // the quote that exposed this bug spans two. Bounded at 500 characters so an
      // odd number of quote marks cannot pair wrongly and blank out the section.
      .replace(/"[^"]{0,500}"/g, ' ')
      .replace(/\u201c[^\u201d]{0,500}\u201d/g, ' ')
  );
}

/** `## [1.2.3] - 2026-07-31` — the shape a finalised heading must have. */
const DATED_HEADING = /^## \[(?<version>[^\]]+)\] - (?<date>\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Not exported. The only consumer is the CLI below, and
 * `tests/unit/check-changelog.test.ts` drives that CLI as a subprocess, because
 * what `release.yml` depends on is the exit status and the `::error` output
 * rather than any function signature.
 *
 * @param {string} text  full CHANGELOG.md contents
 * @param {string} version  version without a leading `v`
 * @returns {string[]} problems; empty means releasable
 */
function checkChangelog(text, version) {
  /** @type {string[]} */
  const problems = [];
  const lines = text.split('\n');

  const headingIndex = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (headingIndex === -1) {
    return [
      `CHANGELOG.md has no section for ${version}. Add a "## [${version}] - YYYY-MM-DD" heading. See docs/RELEASE.md.`,
    ];
  }

  const heading = lines[headingIndex] ?? '';
  const match = DATED_HEADING.exec(heading);
  if (!match) {
    problems.push(
      `CHANGELOG.md heading for ${version} is "${heading.trim()}" — it must be exactly "## [${version}] - YYYY-MM-DD". An undated heading, or one still marked Unreleased, means the section was never finalised.`,
    );
  }

  // The section runs to the next "## " heading, or to the link definitions.
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ') || /^\[[^\]]+\]:\s*http/.test(line)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(headingIndex + 1, end).join('\n');

  if (body.trim().length === 0) {
    problems.push(
      `CHANGELOG.md section for ${version} is empty. A release with no notes is not a release a user can assess.`,
    );
  }

  const lowered = stripQuoted(body).toLowerCase();
  for (const phrase of SCAFFOLDING) {
    if (lowered.includes(phrase)) {
      problems.push(
        `CHANGELOG.md section for ${version} still contains scaffolding: "${phrase}". Finalise the section into release notes a user can read before tagging. CHANGELOG.md ships inside the npm tarball, so this text reaches the registry.`,
      );
    }
  }

  // The comparison link is what makes a version heading navigable on GitHub.
  if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]:\\s*http`, 'm').test(text)) {
    problems.push(
      `CHANGELOG.md has no comparison link for ${version}. Add a "[${version}]: https://github.com/.../compare/..." line with the others at the foot of the file.`,
    );
  }

  return problems;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  const path = process.argv[3] ?? 'CHANGELOG.md';

  if (version.length === 0) {
    process.stderr.write('usage: node scripts/check-changelog.mjs <version> [path]\n');
    process.exit(2);
  }

  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    process.stdout.write(`::error file=${path}::cannot read ${path}: ${String(cause)}\n`);
    process.exit(1);
  }

  const problems = checkChangelog(text, version);
  for (const problem of problems) {
    process.stdout.write(`::error file=${path}::${problem}\n`);
  }
  if (problems.length > 0) {
    process.stdout.write(
      `\n${problems.length} problem(s) with the ${version} changelog section. Tags are immutable, so this is checked before publishing rather than after.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`CHANGELOG.md section for ${version} is finalised.\n`);
}

// Offline publication guard. Reports locations and rule names, never matched values.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const rules = [
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['openai-token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['private-session-link', new RegExp('Claude' + '-Session:|claude\\.ai/code/' + 'session_[A-Za-z0-9]+', 'g')],
];
export function scanPublicText(path, text) {
  const findings = [];
  if (/(?:^|\/)\.env(?:$|\.)/.test(path) && !path.endsWith('.env.example') ||
      /(?:^|\/)\.claude\/settings\.local\.json(?:$|\.)/.test(path) ||
      /(?:^|\/)(?:\.npmrc|\.netrc|id_rsa|id_ed25519)$/.test(path)) findings.push({ path, line: 1, rule: 'private-local-file' });
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ path, line: text.slice(0, match.index).split('\n').length, rule });
  }
  if (path === '[commit-metadata]' && /^(?:author|committer) .*@(?:gmail|yahoo|hotmail|outlook)\.com>/mi.test(text)) {
    findings.push({ path, line: 1, rule: 'personal-commit-email' });
  }
  return findings;
}

export function checkPublicRepository() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const findings = [];
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  for (const path of files) findings.push(...scanPublicText(path, readFileSync(path).toString('utf8')));
  // Inspect all revisions reachable from the publication branch, not private worktree refs.
  for (const row of git('rev-list', '--objects', 'HEAD').trim().split('\n')) {
    const [oid, ...name] = row.split(' ');
    const kind = git('cat-file', '-t', oid).trim();
    if (!['commit', 'blob'].includes(kind)) continue;
    findings.push(...scanPublicText(kind === 'commit' ? '[commit-metadata]' : name.join(' '), git('cat-file', '-p', oid)));
  }
  for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  if (findings.length) return false;
  console.log(`PASS: ${files.length} tracked files and published-branch history checked for covered secret formats and private session metadata.`);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = checkPublicRepository() ? 0 : 1;

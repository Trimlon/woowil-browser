#!/usr/bin/env node
//
// Builds Woowil for Linux (AppImage) and Windows, then creates/updates the
// matching GitHub release with every artifact. Re-running for the same
// version is safe — it reuses the existing release and replaces assets.
//
// Needs two GitHub tokens as environment variables. Never hardcode either
// of them here, and never commit them anywhere:
//
//   GH_PUBLISH_TOKEN  classic PAT, "repo" scope. Used only by this script,
//                     on this machine, to create the release and upload
//                     assets. Must never end up inside the built app.
//   GH_RUNTIME_TOKEN  fine-grained PAT, read-only "Contents", scoped to
//                     just this one repo. Gets baked into the app itself
//                     (app-update.yml) so it can check for updates without
//                     you being logged in. Anyone who unpacks a copy of the
//                     app can read this token back out — that's expected;
//                     it must never be able to do more than read releases.
//
// Usage:
//   GH_PUBLISH_TOKEN=ghp_xxx GH_RUNTIME_TOKEN=github_pat_xxx npm run release

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function fail(message) {
  console.error('✖ ' + message);
  process.exit(1);
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function hasWine() {
  try {
    execFileSync('which', ['wine'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build(args) {
  console.log('→ electron-builder ' + args.filter((a) => !a.includes('token')).join(' '));
  execFileSync('npx', ['electron-builder', ...args], { cwd: ROOT, stdio: 'inherit' });
}

// Only top-level dist/ files matter for a release — dist/*-unpacked/ holds
// the raw (unzipped) app tree, not something users download directly.
function collectArtifacts() {
  return fs
    .readdirSync(DIST)
    .filter((name) => fs.statSync(path.join(DIST, name)).isFile())
    .filter((name) => /\.(AppImage|exe)$/.test(name) || /^latest.*\.yml$/.test(name));
}

async function gh(publishToken, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'token ' + publishToken,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub API ${method} ${url} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 404 ? null : res.json();
}

async function findOrCreateRelease(publishToken, owner, repo, version) {
  const tag = 'v' + version;
  const existing = await gh(publishToken, 'GET', `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
  if (existing) {
    console.log(`→ genbruger eksisterende release ${tag} (id ${existing.id})`);
    return existing;
  }
  console.log(`→ opretter release ${tag}`);
  return gh(publishToken, 'POST', `https://api.github.com/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: false,
  });
}

async function uploadAsset(publishToken, release, filePath) {
  // GitHub silently mangles spaces in asset names (turns them into dots),
  // which is how electron-builder names the Windows output — replace them
  // ourselves first so the uploaded name stays predictable.
  const name = path.basename(filePath).replace(/\s+/g, '-');
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    console.log(`→ fjerner eksisterende asset ${name} for at lægge en frisk version op`);
    await fetch(existing.url, { method: 'DELETE', headers: { Authorization: 'token ' + publishToken } });
  }
  const uploadUrl = release.upload_url.replace('{?name,label}', '') + '?name=' + encodeURIComponent(name);
  console.log(`→ uploader ${name} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB)`);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: 'token ' + publishToken, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(filePath),
  });
  if (!res.ok) {
    throw new Error(`Upload af ${name} fejlede: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const publishToken = process.env.GH_PUBLISH_TOKEN;
  const runtimeToken = process.env.GH_RUNTIME_TOKEN;
  if (!publishToken) fail('GH_PUBLISH_TOKEN er ikke sat (classic PAT, "repo"-scope).');
  if (!runtimeToken) fail('GH_RUNTIME_TOKEN er ikke sat (fine-grained PAT, read-only, kun dette repo).');

  const pkg = readPackageJson();
  const { owner, repo } = pkg.build.publish;
  const version = pkg.version;
  if (!owner || owner.startsWith('REPLACE_')) fail('build.publish.owner er ikke sat i package.json.');

  console.log(`Woowil ${version} → ${owner}/${repo}`);

  fs.rmSync(DIST, { recursive: true, force: true });

  build(['--linux', 'AppImage', '-c.publish.token=' + runtimeToken]);

  const winTarget = hasWine() ? 'nsis' : 'portable';
  if (winTarget === 'portable') {
    console.log('⚠ wine er ikke installeret — bygger en portabel .exe i stedet for en installer.');
    console.log('  Den portable exe understøtter ikke auto-opdatering ordentligt. Installér');
    console.log('  wine (sudo apt install wine) og køm dette script igen for en rigtig');
    console.log('  installer med auto-opdatering på Windows.');
  }
  build(['--win', winTarget, '-c.publish.token=' + runtimeToken]);

  const artifacts = collectArtifacts();
  if (artifacts.length === 0) fail('Ingen build-artefakter fundet i dist/.');

  const release = await findOrCreateRelease(publishToken, owner, repo, version);
  for (const name of artifacts) {
    await uploadAsset(publishToken, release, path.join(DIST, name));
  }

  console.log('\n✔ Færdig: ' + release.html_url);
}

main().catch((error) => fail(error.message));

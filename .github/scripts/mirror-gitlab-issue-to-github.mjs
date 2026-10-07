const gitlabToken = process.env.GITLAB_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const gitlabProject = process.env.GITLAB_PROJECT;
const gitlabBaseUrl = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '');
const githubRepository = process.env.GITHUB_REPOSITORY;

if (!gitlabToken) {
  throw new Error('Missing GITLAB_ISSUE_MIRROR_TOKEN repository secret.');
}
if (!githubToken) {
  throw new Error('Missing GITHUB_TOKEN.');
}
if (!gitlabProject) {
  throw new Error('Missing GITLAB_PROJECT.');
}
if (!githubRepository) {
  throw new Error('Missing GITHUB_REPOSITORY.');
}

const gitlabProjectApi = `${gitlabBaseUrl}/api/v4/projects/${encodeURIComponent(gitlabProject)}`;
const githubApi = `https://api.github.com/repos/${githubRepository}`;

async function gitlab(path) {
  const response = await fetch(`${gitlabProjectApi}${path}`, {
    headers: {
      'PRIVATE-TOKEN': gitlabToken,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitLab API GET ${path} failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 1000)}` : ''}`,
    );
  }

  return text ? JSON.parse(text) : null;
}

async function github(path, { method = 'GET', body, allow404 = false } = {}) {
  const response = await fetch(`${githubApi}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (allow404 && (response.status === 404 || response.status === 410)) {
    return null;
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 1000)}` : ''}`,
    );
  }

  return text ? JSON.parse(text) : null;
}

async function listAllGitLabIssues() {
  const issues = [];

  for (let page = 1; page <= 100; page += 1) {
    const batch = await gitlab(`/issues?scope=all&per_page=100&page=${page}&order_by=updated_at&sort=desc`);
    issues.push(...(batch || []));

    if (!batch || batch.length < 100) {
      break;
    }
  }

  return issues;
}

async function listGitLabNotes(iid) {
  const notes = [];

  for (let page = 1; page <= 20; page += 1) {
    const batch = await gitlab(`/issues/${iid}/notes?per_page=100&page=${page}&order_by=created_at&sort=asc`);
    notes.push(...(batch || []));

    if (!batch || batch.length < 100) {
      break;
    }
  }

  return notes;
}

async function listGitHubComments(issueNumber) {
  const comments = [];

  for (let page = 1; page <= 20; page += 1) {
    const batch = await github(`/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    comments.push(...(batch || []));

    if (!batch || batch.length < 100) {
      break;
    }
  }

  return comments;
}

function githubNumberFromGitLabTitle(title) {
  const match = String(title || '').match(/^\[GitHub #(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function publicNoteContent(note) {
  if (note.system) {
    return null;
  }

  const body = String(note.body || '');
  const match = body.match(/^\s*PUBLIC:\s*([\s\S]*?)\s*$/i);

  if (!match || !match[1]) {
    return null;
  }

  return match[1];
}

function publicGithubComment(note, publicText) {
  return [
    `<!-- gitlab-public-note:${note.id} -->`,
    `**Development update from @${note.author?.username || 'maintainer'}:**`,
    '',
    publicText,
  ].join('\n');
}

async function syncState(gitlabIssue, githubIssue) {
  const desiredState = gitlabIssue.state === 'closed' ? 'closed' : 'open';

  if (githubIssue.state === desiredState) {
    return;
  }

  await github(`/issues/${githubIssue.number}`, {
    method: 'PATCH',
    body: { state: desiredState },
  });

  console.log(`${desiredState === 'closed' ? 'Closed' : 'Reopened'} GitHub #${githubIssue.number} from GitLab !${gitlabIssue.iid}.`);
}

async function syncPublicNotes(gitlabIssue, githubIssue) {
  const gitlabNotes = await listGitLabNotes(gitlabIssue.iid);
  const publicNotes = gitlabNotes
    .map((note) => ({ note, text: publicNoteContent(note) }))
    .filter((entry) => entry.text !== null);

  if (publicNotes.length === 0) {
    return;
  }

  const githubComments = await listGitHubComments(githubIssue.number);

  for (const { note, text } of publicNotes) {
    const marker = `<!-- gitlab-public-note:${note.id} -->`;
    const desiredBody = publicGithubComment(note, text);
    const existing = githubComments.find((comment) => comment.body?.includes(marker));

    if (!existing) {
      await github(`/issues/${githubIssue.number}/comments`, {
        method: 'POST',
        body: { body: desiredBody },
      });
      console.log(`Published GitLab !${gitlabIssue.iid} note ${note.id} to GitHub #${githubIssue.number}.`);
      continue;
    }

    if (existing.body !== desiredBody) {
      await github(`/issues/comments/${existing.id}`, {
        method: 'PATCH',
        body: { body: desiredBody },
      });
      console.log(`Updated GitHub comment ${existing.id} from GitLab !${gitlabIssue.iid} note ${note.id}.`);
    }
  }
}

const gitlabIssues = await listAllGitLabIssues();
let mirroredCount = 0;

for (const gitlabIssue of gitlabIssues) {
  const githubNumber = githubNumberFromGitLabTitle(gitlabIssue.title);

  if (!githubNumber) {
    continue;
  }

  const githubIssue = await github(`/issues/${githubNumber}`, { allow404: true });

  if (!githubIssue) {
    console.log(`GitHub #${githubNumber} no longer exists; skipping reverse sync for GitLab !${gitlabIssue.iid}.`);
    continue;
  }

  if (githubIssue.pull_request) {
    console.log(`GitHub #${githubNumber} is a pull request; skipping.`);
    continue;
  }

  mirroredCount += 1;
  await syncState(gitlabIssue, githubIssue);
  await syncPublicNotes(gitlabIssue, githubIssue);
}

console.log(`GitLab -> GitHub controlled sync complete for ${mirroredCount} mirrored issue(s).`);

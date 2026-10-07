import fs from 'node:fs/promises';

const token = process.env.GITLAB_TOKEN;
const project = process.env.GITLAB_PROJECT;
const baseUrl = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '');
const eventName = process.env.GITHUB_EVENT_NAME;
const action = process.env.GITHUB_EVENT_ACTION;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!token) {
  throw new Error('Missing GITLAB_ISSUE_MIRROR_TOKEN repository secret.');
}
if (!project) {
  throw new Error('Missing GITLAB_PROJECT environment variable.');
}
if (!eventPath) {
  throw new Error('Missing GITHUB_EVENT_PATH.');
}

const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
const issue = event.issue;

if (!issue || issue.pull_request) {
  console.log('Event is not a normal GitHub issue; nothing to mirror.');
  process.exit(0);
}

const projectApi = `${baseUrl}/api/v4/projects/${encodeURIComponent(project)}`;

async function gitlab(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${projectApi}${path}`, {
    method,
    headers: {
      'PRIVATE-TOKEN': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitLab API ${method} ${path} failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 1000)}` : ''}`,
    );
  }

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function githubLabels(currentIssue) {
  return (currentIssue.labels || [])
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter(Boolean);
}

function githubAssignees(currentIssue) {
  return (currentIssue.assignees || [])
    .map((assignee) => assignee?.login)
    .filter(Boolean);
}

function issueTitle(currentIssue) {
  return `[GitHub #${currentIssue.number}] ${currentIssue.title}`;
}

function issueDescription(currentIssue) {
  const labels = githubLabels(currentIssue);
  const assignees = githubAssignees(currentIssue);

  return [
    `<!-- github-issue:${process.env.GITHUB_REPOSITORY}#${currentIssue.number} -->`,
    '> **One-way content mirror from GitHub.** GitHub remains the public source of truth for the issue title/body.',
    `> Original: ${currentIssue.html_url}`,
    `> Reporter: @${currentIssue.user?.login || 'unknown'}`,
    `> GitHub state at last GitHub-side event: **${currentIssue.state}**`,
    `> GitHub labels: ${labels.length ? labels.map((label) => `\`${label}\``).join(', ') : '_none_'}`,
    `> GitHub assignees: ${assignees.length ? assignees.map((login) => `@${login}`).join(', ') : '_none_'}`,
    '',
    '---',
    '',
    currentIssue.body || '_No description provided on GitHub._',
    '',
    '---',
    '',
    '_Private GitLab development notes are never copied to GitHub unless a note starts with `PUBLIC:`._',
  ].join('\n');
}

async function findMirroredIssue(currentIssue) {
  const search = encodeURIComponent(`GitHub #${currentIssue.number}`);
  const matches = await gitlab(`/issues?scope=all&search=${search}&per_page=100`);
  const prefix = `[GitHub #${currentIssue.number}]`;

  return (matches || []).find((candidate) => candidate.title?.startsWith(prefix)) || null;
}

async function ensureMirroredIssue(currentIssue, { syncState = false } = {}) {
  let mirrored = await findMirroredIssue(currentIssue);

  const payload = {
    title: issueTitle(currentIssue),
    description: issueDescription(currentIssue),
  };

  if (!mirrored) {
    mirrored = await gitlab('/issues', {
      method: 'POST',
      body: payload,
    });
    console.log(`Created GitLab issue !${mirrored.iid} for GitHub #${currentIssue.number}.`);
  } else {
    mirrored = await gitlab(`/issues/${mirrored.iid}`, {
      method: 'PUT',
      body: payload,
    });
    console.log(`Updated GitLab issue !${mirrored.iid} from GitHub #${currentIssue.number}.`);
  }

  if (syncState) {
    const shouldBeClosed = currentIssue.state === 'closed';
    const isClosed = mirrored.state === 'closed';

    if (shouldBeClosed !== isClosed) {
      mirrored = await gitlab(`/issues/${mirrored.iid}`, {
        method: 'PUT',
        body: {
          state_event: shouldBeClosed ? 'close' : 'reopen',
        },
      });
      console.log(`${shouldBeClosed ? 'Closed' : 'Reopened'} GitLab issue !${mirrored.iid} from GitHub state.`);
    }
  }

  return mirrored;
}

async function listIssueNotes(iid) {
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

async function findMirroredComment(iid, commentId) {
  const marker = `<!-- github-comment-id:${commentId} -->`;
  const notes = await listIssueNotes(iid);
  return notes.find((note) => note.body?.includes(marker)) || null;
}

function commentBody(comment) {
  return [
    `<!-- github-comment-id:${comment.id} -->`,
    `**Mirrored GitHub comment by @${comment.user?.login || 'unknown'}**`,
    `Original: ${comment.html_url}`,
    '',
    comment.body || '_Empty comment._',
  ].join('\n');
}

async function syncComment(mirrored, comment, eventAction) {
  const existing = await findMirroredComment(mirrored.iid, comment.id);

  if (eventAction === 'deleted') {
    if (existing) {
      await gitlab(`/issues/${mirrored.iid}/notes/${existing.id}`, {
        method: 'PUT',
        body: {
          body: [
            `<!-- github-comment-id:${comment.id} -->`,
            '_The source GitHub comment was deleted, so its mirrored content has been redacted._',
          ].join('\n'),
        },
      });
      console.log(`Redacted mirrored GitLab note for deleted GitHub comment ${comment.id}.`);
    } else {
      console.log(`No mirrored GitLab note found for deleted GitHub comment ${comment.id}; nothing to redact.`);
    }
    return;
  }

  const body = commentBody(comment);

  if (existing) {
    await gitlab(`/issues/${mirrored.iid}/notes/${existing.id}`, {
      method: 'PUT',
      body: { body },
    });
    console.log(`Updated mirrored GitLab note for GitHub comment ${comment.id}.`);
  } else {
    await gitlab(`/issues/${mirrored.iid}/notes`, {
      method: 'POST',
      body: { body },
    });
    console.log(`Created mirrored GitLab note for GitHub comment ${comment.id}.`);
  }
}

async function tombstoneDeletedIssue(currentIssue) {
  const mirrored = await findMirroredIssue(currentIssue);

  if (!mirrored) {
    console.log(`No GitLab mirror found for deleted GitHub #${currentIssue.number}; nothing to tombstone.`);
    return;
  }

  const notes = await listIssueNotes(mirrored.iid);

  for (const note of notes) {
    const marker = note.body?.match(/<!-- github-comment-id:(\d+) -->/);
    if (!marker) {
      continue;
    }

    await gitlab(`/issues/${mirrored.iid}/notes/${note.id}`, {
      method: 'PUT',
      body: {
        body: [
          `<!-- github-comment-id:${marker[1]} -->`,
          '_Mirrored GitHub comment redacted because the source GitHub issue was deleted._',
        ].join('\n'),
      },
    });
  }

  await gitlab(`/issues/${mirrored.iid}`, {
    method: 'PUT',
    body: {
      title: `[GitHub #${currentIssue.number}] [SOURCE DELETED]`,
      description: [
        `<!-- github-issue:${process.env.GITHUB_REPOSITORY}#${currentIssue.number} -->`,
        '> **The source GitHub issue was deleted.**',
        '',
        'The public title, body and mirrored GitHub comments have been redacted from this private development mirror.',
        'Private GitLab-only development notes have been retained.',
      ].join('\n'),
      state_event: 'close',
    },
  });

  console.log(`Tombstoned and closed GitLab issue !${mirrored.iid} after GitHub #${currentIssue.number} was deleted.`);
}

if (eventName === 'issues' && action === 'deleted') {
  await tombstoneDeletedIssue(issue);
  console.log(`GitHub #${issue.number} deletion mirror sync complete.`);
  process.exit(0);
}

const syncState = eventName === 'issues' && ['opened', 'closed', 'reopened'].includes(action);
const mirrored = await ensureMirroredIssue(issue, { syncState });

if (eventName === 'issue_comment') {
  if (!event.comment) {
    throw new Error('issue_comment event did not contain a comment.');
  }

  await syncComment(mirrored, event.comment, action);
}

console.log(`GitHub #${issue.number} mirror sync complete.`);

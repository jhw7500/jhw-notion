#!/usr/bin/env node
// Exercises the generator's public file outputs; no installed HOME is touched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const sourceGenerator = join(dirname(fileURLToPath(import.meta.url)), 'sync-codex-skills.mjs');

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'jhw-runner-refs-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'skills/claude/scripts'), { recursive: true });
    await copyFile(sourceGenerator, join(root, 'scripts/sync-codex-skills.mjs'));
    for (const command of ['issue', 'task', 'recall']) {
      await writeFile(join(root, `skills/claude/${command}.md`), `---\ndescription: ${command} contract\n---\n`);
    }
    for (const [name, text] of [['issue-contract.sh', 'issue-runner'], ['task-finish.sh', 'task-runner']]) {
      await writeFile(join(root, 'skills/claude/scripts', name), `#!/bin/bash\nprintf '%s\\n' '${text}' "$@"\n`, { mode: 0o755 });
      await chmod(join(root, 'skills/claude/scripts', name), 0o755);
    }
    const generate = (...args) => exec(process.execPath, ['scripts/sync-codex-skills.mjs', ...args], { cwd: root })
      .then(({ stdout, stderr }) => ({ exit: 0, stdout, stderr }),
        error => ({ exit: error.code, stdout: error.stdout, stderr: error.stderr }));
    await run(root, generate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('generated helper references execute the correct canonical runner and survive orphan cleanup', async () => {
  await fixture(async (root, generate) => {
    assert.equal((await generate()).exit, 0);
    for (const [command, name, expected] of [
      ['issue', 'issue-contract.sh', 'issue-runner'],
      ['task', 'task-finish.sh', 'task-runner'],
    ]) {
      const reference = join(root, `skills/codex/jhw-${command}/references`, name);
      assert.equal((await lstat(reference)).isSymbolicLink(), true, `${command}: helper reference must be generated`);
      assert.equal(await readlink(reference), `../../../claude/scripts/${name}`);
      assert.equal((await exec(reference, ['literal $(not-executed)'])).stdout, `${expected}\nliteral $(not-executed)\n`);
    }
    await writeFile(join(root, 'skills/codex/jhw-task/references/unrelated.sh'), 'must be removed');
    assert.notEqual((await generate('--check')).exit, 0, 'unrelated reference is drift');
    assert.equal((await generate()).exit, 0);
    assert.equal((await generate('--check')).exit, 0, 'known helper references must remain allowed');
    await assert.rejects(lstat(join(root, 'skills/codex/jhw-task/references/unrelated.sh')), { code: 'ENOENT' });
    await rm(join(root, 'skills/codex/jhw-task/references/task-finish.sh'));
    assert.notEqual((await generate('--check')).exit, 0, 'missing helper reference is drift');
  });
});

test('canonical runner must exist and have executable trusted file mode', async () => {
  await fixture(async (root, generate) => {
    const runner = join(root, 'skills/claude/scripts/task-finish.sh');
    await chmod(runner, 0o644);
    assert.notEqual((await generate()).exit, 0, 'non-executable canonical runner must fail generation');
    await rm(runner);
    assert.notEqual((await generate()).exit, 0, 'missing canonical runner must fail generation');
  });
});

test('canonical runner symlink cannot introduce an external executable', async () => {
  await fixture(async (root, generate) => {
    const runner = join(root, 'skills/claude/scripts/task-finish.sh');
    await rm(runner);
    await symlink('/bin/true', runner);
    assert.notEqual((await generate()).exit, 0, 'canonical runner must be a regular file');
  });
});

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', 'status', '--porcelain'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export async function getGitDiff(cwd: string): Promise<string> {
  try {
    // Both unstaged and staged changes
    const proc = Bun.spawn(['git', 'diff', 'HEAD'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const diff = await new Response(proc.stdout).text();
    if (diff.trim().length > 0) {
      return diff;
    }

    // Fallback if HEAD does not exist (new repository) or unstaged only
    const procUnstaged = Bun.spawn(['git', 'diff'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return await new Response(procUnstaged.stdout).text();
  } catch {
    return '';
  }
}

export async function commitChanges(
  cwd: string,
  message: string
): Promise<{ committed: boolean; hash?: string; error?: string }> {
  try {
    const hasChanges = await hasUncommittedChanges(cwd);
    if (!hasChanges) {
      return { committed: false };
    }

    // git add -A
    const addProc = Bun.spawn(['git', 'add', '-A'], { cwd, stdout: 'ignore', stderr: 'pipe' });
    const addExit = await addProc.exited;
    if (addExit !== 0) {
      const err = await new Response(addProc.stderr).text();
      return { committed: false, error: `git add failed: ${err}` };
    }

    // git commit -m message
    const commitProc = Bun.spawn(['git', 'commit', '-m', message], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const commitExit = await commitProc.exited;
    if (commitExit !== 0) {
      const err = await new Response(commitProc.stderr).text();
      return { committed: false, error: `git commit failed: ${err}` };
    }

    // get commit hash
    const hashProc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const hash = (await new Response(hashProc.stdout).text()).trim();

    return { committed: true, hash };
  } catch (err) {
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

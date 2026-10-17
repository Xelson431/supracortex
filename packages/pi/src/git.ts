/**
 * P03 git metadata without host help: direct silent `git status --porcelain`.
 * Never uses a chat-coupled shell callback; output is invisible to the user.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitChangeSummary } from "@local/supracortex-core";

const execFileAsync = promisify(execFile);

/** Parse `git status --porcelain=v1 -b` output (same shape as core consumers). */
export function parsePorcelain(out: string): GitChangeSummary {
  const lines = out.split("\n").filter(Boolean);
  const changed: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0];
      continue;
    }
    const x = line[0];
    const y = line[1];
    const path = line.slice(3).split(" -> ").pop() ?? "";
    if (!path) continue;
    if (x === "?" && y === "?") untracked.push(path);
    else {
      if (x !== " " && x !== "?") staged.push(path);
      if (y !== " ") changed.push(path);
    }
  }
  return { branch, changedFiles: changed, staged, untracked };
}

/** Silent git change summary, or undefined outside a repo / on any failure. */
export async function safeGitChanges(projectRoot: string): Promise<GitChangeSummary | undefined> {
  try {
    let dir = projectRoot;
    let foundGit = false;
    for (let i = 0; i < 8 && dir; i++) {
      try {
        await stat(join(dir, ".git"));
        foundGit = true;
        break;
      } catch {
        const parent = join(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
    }
    if (!foundGit) return undefined;
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, "status", "--porcelain=v1", "-b"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return parsePorcelain(stdout as string);
  } catch {
    return undefined;
  }
}

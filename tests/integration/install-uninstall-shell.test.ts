/**
 * scripts/uninstall.sh must remove exactly the PATH block scripts/install.sh
 * appends to the user's shell rc — and nothing else. Runs against a scratch
 * HOME with an explicit --bin so no real bin dir or rc file is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installSh = join(repoRoot, "scripts", "install.sh");
const uninstallSh = join(repoRoot, "scripts", "uninstall.sh");

/** The exact append command install.sh uses, with its placeholders intact. */
async function installPathBlockCommand(): Promise<string> {
  const src = await readFile(installSh, "utf8");
  const line = src
    .split("\n")
    .find((l) => l.includes("# supracode: PATH") && l.includes("printf"));
  assert.ok(line, "install.sh still appends a '# supracode: PATH' block");
  return line.trim();
}

async function runUninstall(home: string, bin: string): Promise<void> {
  await run("bash", [uninstallSh, "--bin", bin], {
    env: { ...process.env, HOME: home, SHELL: "/bin/bash" },
  });
}

test("uninstall.sh removes exactly the install.sh PATH block; unrelated rc lines survive byte-for-byte", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sc-rc-"));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });

  const rc = join(home, ".bashrc");
  const unrelated = "# my prompt\nexport EDITOR=vim\nalias ll='ls -la'\n";
  await writeFile(rc, unrelated, "utf8");

  // Append the block using install.sh's own command (env-fed placeholders).
  const appendCmd = await installPathBlockCommand();
  await run("bash", ["-c", appendCmd], {
    env: { ...process.env, BIN_DIR: bin, SHELL_RC: rc },
  });

  const installed = await readFile(rc, "utf8");
  assert.equal(installed, `${unrelated}\n# supracode: PATH\nexport PATH="${bin}:$PATH"\n`);
  assert.ok(installed.includes("# supracode: PATH"), "block present after install step");

  await runUninstall(home, bin);

  const cleaned = await readFile(rc, "utf8");
  assert.equal(cleaned, unrelated, "block removed and unrelated lines byte-for-byte identical");
  assert.ok(!cleaned.includes("supracode: PATH"), "marker gone");
  assert.ok(!cleaned.includes(bin), "the appended bin dir is gone");

  // Idempotent: a second uninstall changes nothing and leaves no temp files.
  await runUninstall(home, bin);
  assert.equal(await readFile(rc, "utf8"), unrelated, "second uninstall is a no-op");
  const entries = await readdir(home);
  assert.ok(!entries.some((n) => n.includes("supracode-tmp")), "no temp files left behind");
});

test("uninstall.sh never edits an rc file that has no supracode PATH block", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sc-rc-"));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });

  const rc = join(home, ".bashrc");
  const original = "# unrelated\nexport PATH=\"/opt/custom/bin:$PATH\"\n";
  await writeFile(rc, original, "utf8");

  await runUninstall(home, bin);
  assert.equal(await readFile(rc, "utf8"), original, "rc without our marker is untouched");
});

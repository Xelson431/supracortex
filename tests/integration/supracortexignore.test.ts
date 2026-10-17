import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

test(".supracortexignore is a second privacy deny layer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-ignore-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/public.ts"), "export const publicValue = 1;");
  await writeFile(join(root, "src/private-note.ts"), "export const privateValue = 2;");
  await writeFile(join(root, ".supracortexignore"), "private-note.ts\n");
  const { config } = resolveConfig({ project: { enabled: true } });
  const engine = new Engine({ config, store: new JsonlStore(join(root, ".supracortex")), pluginVersion: "test", projectRoot: root });
  const index = await engine.ensureIndex();
  assert.ok(index.files["src/public.ts"]);
  assert.equal(index.files["src/private-note.ts"], undefined);
});

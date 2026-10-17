/**
 * Configuration loading for the OpenCode adapter.
 *
 * Config is CENTRAL (`~/.config/supracortex/config.jsonc`). A project file
 * (`<project>/.supracortex/config.jsonc`) contributes only project-scoped keys
 * (store identity + kill switch); everything else in it is ignored and
 * reported. The layering itself lives in core (`config-files.ts`) so every
 * host shares one implementation.
 */
import {
  loadConfigLayers,
  resolveConfig,
  unknownConfigKeys,
  type PartialConfig,
  type ResolvedConfig,
} from "@local/supracortex-core";

// Single implementation in core; re-exported so existing imports keep working.
export {
  CONFIG_PROJECT_DIR as PROJECT_DIR,
  CONFIG_FILENAME,
  projectConfigPath,
  globalConfigPath,
  stripJsonc,
  readConfigFile,
} from "@local/supracortex-core";
import { globalConfigPath, projectConfigPath } from "@local/supracortex-core";

export interface LoadOptions {
  projectRoot: string;
  env?: Record<string, string | undefined>;
  runtimeOverride?: PartialConfig | null;
}

export interface LoadResult extends ResolvedConfig {
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  loadError?: string;
  configWarnings: string[];
  /** Keys present in the project file but ignored because config is central. */
  ignoredProjectKeys: string[];
  /** How the storage driver was chosen. */
  storageDriverSource: "project" | "detected" | "central";
}

/** Central-config layer loading lives in core so every host shares it. */
export async function loadLayers(projectRoot: string) {
  return loadConfigLayers(projectRoot);
}

export async function loadConfig(opts: LoadOptions): Promise<LoadResult> {
  const layers = await loadLayers(opts.projectRoot);
  const resolved = resolveConfig({
    global: layers.global,
    project: layers.project,
    runtimeOverride: opts.runtimeOverride ?? null,
    env: opts.env ?? process.env,
  });
  const result: LoadResult = {
    ...resolved,
    projectConfigPath: projectConfigPath(opts.projectRoot),
    globalConfigPath: globalConfigPath(),
    projectConfigExists: layers.rawProject !== null,
    globalConfigExists: layers.global !== null,
    configWarnings: [
      ...unknownConfigKeys(layers.global ?? {}).map((key) => `global config: unknown key ${key}`),
      ...unknownConfigKeys(layers.rawProject ?? {}).map((key) => `project config: unknown key ${key}`),
    ],
    ignoredProjectKeys: layers.ignoredProjectKeys,
    storageDriverSource: layers.storageDriverSource,
  };
  if (layers.loadError) result.loadError = layers.loadError;
  return result;
}

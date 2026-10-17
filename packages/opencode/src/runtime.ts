/**
 * Shared plugin runtime. Holds the resolved config, feature gate, and a lazily
 * created Engine. Tools and hooks consult this so behavior stays consistent.
 *
 * The Engine is created lazily on first *active* use so a disabled plugin does
 * zero IO. If Engine creation throws, the gate is marked failed and the plugin
 * degrades to a safe no-op for the rest of the session.
 */

import type { Engine, GatherInputs } from "@local/supracortex-core";
import { FeatureGate } from "./feature-gate.ts";
import {
  createEngine,
  gatherInputs,
  type LifecycleContext,
  type OpencodeClientLike,
} from "./lifecycle.ts";

export interface RuntimeInit {
  gate: FeatureGate;
  lifecycle: LifecycleContext;
}

export class PluginRuntime {
  readonly gate: FeatureGate;
  private lifecycle: LifecycleContext;
  private engine: Engine | null = null;
  private enginePromise: Promise<Engine> | null = null;

  constructor(init: RuntimeInit) {
    this.gate = init.gate;
    this.lifecycle = init.lifecycle;
  }

  get client(): OpencodeClientLike | undefined {
    return this.lifecycle.client;
  }

  get projectRoot(): string {
    return this.lifecycle.projectRoot;
  }

  /** Returns the engine, or null when disabled/failed. Never throws to callers. */
  async getEngine(): Promise<Engine | null> {
    if (!this.gate.active) return null;
    if (this.engine) return this.engine;
    if (!this.enginePromise) {
      this.enginePromise = createEngine(this.lifecycle);
    }
    try {
      this.engine = await this.enginePromise;
      await this.engine.init();
      return this.engine;
    } catch (err) {
      this.gate.markFailed((err as Error).message);
      this.enginePromise = null;
      return null;
    }
  }

  async gather(targetAgent?: string, loadedSkills: string[] = []): Promise<GatherInputs> {
    try {
      return await gatherInputs(this.lifecycle, targetAgent, loadedSkills);
    } catch {
      return { loadedSkills };
    }
  }

  async dispose(): Promise<void> {
    // Respect a live kill-switch: if the gate is inactive (env disable set
    // mid-session or an init failure), do not perform any final IO.
    if (this.engine && this.gate.active) {
      try {
        await this.engine.persistMetrics();
      } catch {
        // best-effort
      }
    }
    if (this.engine) {
      try {
        await this.engine.close();
      } catch {
        // A host shutdown must not be blocked by optional integration cleanup.
      }
    }
    this.engine = null;
    this.enginePromise = null;
  }
}

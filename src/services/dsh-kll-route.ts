/**
 * KLL dsh route overlay (SDK runner surface).
 *
 * When a dsh bot opts into KLL (`kll` in bots.json), the worker resolves the
 * launch through KLL and hands the selected catalog model here. BotMux keeps
 * its own SDK runner and profile (the composition with the JSON-RPC server),
 * and applies the model route as a private `--patch` overlay on top of the
 * profile layer — the same shape allInOne's KLL launcher uses for its own dsh
 * web profiles: the official pi-ai plugin configured with an OpenAI-compatible
 * provider, the account-bound DeepSeek plugins disabled, and the default model
 * pinned so no fallback can select another route.
 *
 * The overlay intentionally carries NO credential: the pi-ai provider reads its
 * key from the child environment (`ALLINONE_DSH_API_KEY`), which KLL delivers
 * through the protected launch-env file and botmux injects into the runner
 * process only. The API key never enters argv, the overlay, or logs.
 *
 * The route table mirrors KLL's registered dsh routes (see allInOne
 * harnesses/dsh-acp.mjs). A KLL selection without a matching entry is a launch
 * failure, never a silent fallback to the profile's own provider.
 */

/** Provider id used by KLL's dsh patches; must match allInOne's DSH_PROVIDER. */
export const DSH_KLL_PROVIDER = 'allinone-kll';

/** Environment variable the pi-ai provider reads the API key from. */
export const DSH_KLL_API_KEY_ENV = 'ALLINONE_DSH_API_KEY';

export interface DshKllRoute {
  /** Native dsh model id sent to the SDK initialize RPC. */
  model: string;
  /** OpenAI-compatible endpoint for this route. */
  baseURL: string;
}

/** KLL catalog model id → registered native route. */
const DSH_KLL_ROUTES: Readonly<Record<string, DshKllRoute>> = Object.freeze({
  'deepseek-v4-flash': { model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com' },
  'glm-5.3': { model: 'glm-5.3', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  'glm-5.3-flash': { model: 'glm-5.3-flash', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
});

export function dshKllRoute(modelId: string): DshKllRoute | undefined {
  return DSH_KLL_ROUTES[modelId];
}

/** Render the per-session route overlay. JSON is valid YAML; keeping model text
 *  out of YAML expressions avoids quoting pitfalls in the composed patch. */
export function renderDshKllPatch(modelId: string): string {
  const route = dshKllRoute(modelId);
  if (!route) throw new Error(`KLL selected dsh model ${modelId} without a registered botmux route; the native CLI was not started`);
  return JSON.stringify([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [DSH_KLL_PROVIDER]: {
      displayName: 'allInOne', apiKeyEnv: DSH_KLL_API_KEY_ENV, api: 'openai-completions', baseURL: route.baseURL,
      models: [{ id: route.model, name: route.model }],
    } } } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: DSH_KLL_PROVIDER, model: route.model } },
  ], null, 2) + '\n';
}

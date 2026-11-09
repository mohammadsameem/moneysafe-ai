/**
 * Live smoke test for the configured LLM providers.  Run with:  npm run llm:check
 *
 * One tiny structured call per provider, through the real pinned tool_choice path. Makes real
 * network requests (a few hundred tokens each) only for providers whose key is set.
 * Prints no keys, URLs or response bodies; see src/lib/ai/smoke.ts.
 */
import { getLlmEnv } from "../src/lib/env";
import { formatSmokeLine, runSmoke, smokeTargets } from "../src/lib/ai/smoke";

async function main(): Promise<number> {
  const env = getLlmEnv();
  const targets = smokeTargets(env);

  console.log("LLM smoke test: one structured call per configured provider\n");
  if (!targets[0]!.apiKey && targets[1]!.apiKey) {
    console.log(
      "Note: LLM_API_KEY is empty, so the app itself would use NO LLM (the primary key is the master switch).\n" +
        "The fallback provider is still checked below on its own.\n",
    );
  }

  let failed = 0;
  let checked = 0;
  for (const target of targets) {
    const result = await runSmoke(target);
    console.log(formatSmokeLine(result));
    if (result.status === "fail") failed++;
    if (result.status !== "skipped") checked++;
  }

  console.log("");
  if (checked === 0) {
    console.log("Nothing checked: set LLM_API_KEY (and optionally LLM_FALLBACK_API_KEY) in .env.local.");
    return 0;
  }
  console.log(failed === 0 ? `All ${checked} configured provider(s) passed.` : `${failed} of ${checked} provider(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("llm:check failed:", err instanceof Error ? err.message : "unexpected error");
    process.exit(1);
  });

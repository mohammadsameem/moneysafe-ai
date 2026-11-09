import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_DAILY_CAP,
  DEFAULT_LLM_FALLBACK_BASE_URL,
  DEFAULT_LLM_FALLBACK_MODEL,
  DEFAULT_LLM_MODEL,
  getLlmEnv,
} from "../../env";
import { buildProviders, providerLabel } from "../providers";

describe("LLM env defaults", () => {
  it("applies the verified free-tier defaults and a daily cap of 200 when nothing is set", () => {
    const env = getLlmEnv({});
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.LLM_FALLBACK_API_KEY).toBeUndefined();
    expect(env).toMatchObject({
      LLM_BASE_URL: DEFAULT_LLM_BASE_URL,
      LLM_MODEL: DEFAULT_LLM_MODEL,
      LLM_FALLBACK_BASE_URL: DEFAULT_LLM_FALLBACK_BASE_URL,
      LLM_FALLBACK_MODEL: DEFAULT_LLM_FALLBACK_MODEL,
    });
    expect(env.LLM_DAILY_CAP).toBe(200);
    expect(DEFAULT_LLM_DAILY_CAP).toBe(200);
    expect(DEFAULT_LLM_BASE_URL).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
    expect(DEFAULT_LLM_FALLBACK_BASE_URL).toBe("https://api.groq.com/openai/v1");
  });

  it("treats blank values (as copied from .env.example) the same as unset", () => {
    const env = getLlmEnv({ LLM_API_KEY: "", LLM_MODEL: "  ", LLM_BASE_URL: "", LLM_DAILY_CAP: "" });
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.LLM_MODEL).toBe(DEFAULT_LLM_MODEL);
    expect(env.LLM_BASE_URL).toBe(DEFAULT_LLM_BASE_URL);
    expect(env.LLM_DAILY_CAP).toBe(200);
  });

  it("honours overrides and rejects a malformed base URL without echoing its value", () => {
    expect(getLlmEnv({ LLM_DAILY_CAP: "50", LLM_MODEL: "my-model" })).toMatchObject({ LLM_DAILY_CAP: 50, LLM_MODEL: "my-model" });
    expect(() => getLlmEnv({ LLM_BASE_URL: "not a url" })).toThrow(/LLM_BASE_URL must be a full URL/);
    expect(() => getLlmEnv({ LLM_BASE_URL: "not a url" })).not.toThrow(/not a url/);
  });
});

describe("buildProviders", () => {
  it("empty LLM_API_KEY -> no providers, even when a fallback key is set (the primary key is the master switch)", () => {
    expect(buildProviders(getLlmEnv({}))).toEqual([]);
    expect(buildProviders(getLlmEnv({ LLM_FALLBACK_API_KEY: "fb-key" }))).toEqual([]);
  });

  it("primary only when there is no fallback key", () => {
    const providers = buildProviders(getLlmEnv({ LLM_API_KEY: "k1" }));
    expect(providers).toEqual([
      { role: "primary", label: "gemini", baseUrl: DEFAULT_LLM_BASE_URL, model: DEFAULT_LLM_MODEL, apiKey: "k1" },
    ]);
  });

  it("primary then fallback, labelled by host", () => {
    const providers = buildProviders(getLlmEnv({ LLM_API_KEY: "k1", LLM_FALLBACK_API_KEY: "k2" }));
    expect(providers.map((p) => [p.role, p.label, p.model])).toEqual([
      ["primary", "gemini", DEFAULT_LLM_MODEL],
      ["fallback", "groq", DEFAULT_LLM_FALLBACK_MODEL],
    ]);
  });

  it("labels known hosts by name and unknown hosts by hostname", () => {
    expect(providerLabel("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(providerLabel("https://llm.example.internal/v1")).toBe("llm.example.internal");
    expect(providerLabel("not a url")).toBe("unknown");
  });
});

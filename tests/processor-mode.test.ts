import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import { describeProcessorAvailability } from "../src/processor-mode";

function env(values: Record<string, string>): PodcastEnv {
  return values as unknown as PodcastEnv;
}

describe("processor mode projection", () => {
  it("reports automatic staging dispatch from the shared environment flag", () => {
    expect(describeProcessorAvailability(env({
      ENVIRONMENT: "staging",
      PROCESSOR_DISPATCH_MODE: "github_actions_pull"
    }), true)).toEqual({
      available: true,
      mode: "staging_automatic"
    });
  });

  it("preserves manual staging as an explicit break-glass mode", () => {
    expect(describeProcessorAvailability(env({
      ENVIRONMENT: "staging",
      PROCESSOR_DISPATCH_MODE: "disabled"
    }), true)).toEqual({
      available: true,
      mode: "staging_manual"
    });
  });

  it("fails closed outside staging or when processor prerequisites are absent", () => {
    expect(describeProcessorAvailability(env({
      ENVIRONMENT: "production",
      PROCESSOR_DISPATCH_MODE: "github_actions_pull"
    }), true)).toEqual({
      available: false,
      mode: "unavailable"
    });
    expect(describeProcessorAvailability(env({
      ENVIRONMENT: "staging",
      PROCESSOR_DISPATCH_MODE: "github_actions_pull"
    }), false)).toEqual({
      available: false,
      mode: "unavailable"
    });
  });

});

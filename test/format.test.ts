import { expect, test } from "bun:test";
import { modelName } from "../src/ui/format.ts";

test("modelName shortens known model ids and passes others through", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  expect(modelName("gpt-6")).toBe("GPT-6");
  expect(modelName("unknown")).toBe("unknown");
});

import { loadCodexFixture } from "../src/mock.ts";
import { type GenerationInput, generationInputSchema } from "../src/schemas.ts";

/** 架空企業の生成入力（fixtures/codex/input.json） */
export function fixtureInput(): GenerationInput {
  return generationInputSchema.parse(loadCodexFixture("input"));
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

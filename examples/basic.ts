import { braid, type BraidInput, type ModelRunner } from "../src/index.js";
import { createOpenAICompatibleRunner } from "../src/adapters/openai.js";

const input: BraidInput = {
  goal: "Compare the benefits and risks of adopting a four-day work week.",
  nodes: [
    {
      type: "decision",
      id: "route",
      prompt: "Choose whether this goal needs a comparison or a short answer.",
      choices: ["compare", "brief"],
    },
    {
      type: "execute",
      id: "benefits",
      prompt: "Explain the main potential benefits.",
    },
    {
      type: "execute",
      id: "risks",
      prompt: "Explain the main risks and uncertainties.",
    },
    {
      type: "execute",
      id: "answer",
      prompt: "Synthesize both perspectives into a balanced recommendation.",
    },
    {
      type: "execute",
      id: "brief",
      prompt: "Give a concise answer to the goal.",
    },
  ],
  edges: [
    { from: "route", to: "benefits", choice: "compare" },
    { from: "route", to: "risks", choice: "compare" },
    { from: "benefits", to: "answer" },
    { from: "risks", to: "answer" },
    { from: "route", to: "brief", choice: "brief" },
  ],
};

// Deterministic stand-in for a provider. No network calls or token estimates.
let runner: ModelRunner = async (request) => {
  if (request.decide) {
    request.decide("compare");
    return { output: "A comparison needs both benefits and risks." };
  }
  if (request.node.id === "benefits")
    return { output: "A shorter week may improve work-life balance." };
  if (request.node.id === "risks")
    return { output: "Coverage and workload compression need evaluation." };
  return {
    output:
      request.predecessors
        .map((item) => `[${item.nodeId}] ${item.output}`)
        .join("\n") +
      "\nRecommendation: test a time-limited pilot with explicit success criteria.",
  };
};
let defaultModel = "demo";

// Live calls are opt-in: OPENAI_API_KEY=... BRAID_MODEL=... npm run demo -- --live
if (process.argv.includes("--live")) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.BRAID_MODEL;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey || !model)
    throw new Error("--live requires OPENAI_API_KEY and BRAID_MODEL");
  defaultModel = model;
  runner = createOpenAICompatibleRunner({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

const result = await braid(input, { runner, defaultModel, maxConcurrency: 2 });
console.log(JSON.stringify(result, null, 2));
if (result.status === "failed") process.exitCode = 1;

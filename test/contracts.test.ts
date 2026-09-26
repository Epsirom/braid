import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, validateGraph } from "../src/index.js";
import { braid, decision, execute, graph } from "./helpers.js";

for (const args of [[], ["left", "right"], [["left"]], [null]]) {
  test(`decide rejects a nonconforming argument list: ${JSON.stringify(args)}`, async () => {
    const result = await braid(graph([decision()]), {
      runner: async (request) => {
        Reflect.apply(request.decide!, undefined, args);
        return { output: "must not succeed" };
      },
    });
    assert.equal(result.nodes.route!.error!.code, "INVALID_DECISION");
    assert.deepEqual(result.terminalOutputs, {});
  });
}

test("sparse decision choices are invalid rather than silently containing undefined", () => {
  const input = graph([decision("route", new Array<string>(1))]);
  assert.throws(() => validateGraph(input), GraphValidationError);
});

test("non-Error runner rejections cannot break error serialization or independent branches", async () => {
  const result = await braid(graph([execute("bad"), execute("good")]), {
    runner: async (request) => {
      if (request.node.id === "bad") return Promise.reject(Object.create(null));
      return { output: "good" };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.bad!.error!.code, "MODEL_ERROR");
  assert.equal(typeof result.nodes.bad!.error!.message, "string");
  assert.deepEqual(result.terminalOutputs, { good: { output: "good" } });
});

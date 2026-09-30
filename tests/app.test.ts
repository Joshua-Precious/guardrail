import { describe, test, expect } from "bun:test";
import { createCequreTest } from "cequre-ts/testing";
import { app } from "../cequre/index";

const { routes, hooks, access, dsl } = createCequreTest(app);

describe("Cequre Application Tests", () => {
  test("application instance is bound to test suite", () => {
    expect(app).toBeDefined();
  });

  test("dsl: schema contracts are loaded", () => {
    expect(dsl.getCollections()).toBeDefined();
  });
});

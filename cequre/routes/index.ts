import { CequreModule } from "cequre-ts";
import type { Collections } from "../_generated/server";

export const routesModule = new CequreModule<Collections>();

// Custom health check endpoint
routesModule.get("/health", () => ({ status: "ok" }));

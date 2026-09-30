# Cequre Agent Guidelines

- **Single Source of Truth**: The `cequre/schema/config.cequre` file (and any `*.cequre` files in `cequre/schema/`) govern the database schema, models, auth, APIs, and configuration. Do NOT manually create migration scripts, hand-write collection types, or edit generated output. The framework compiles the DSL into `cequre/_generated/` on `cequre dev` / `cequre build`.
- **Do NOT Edit Generated Files**: Everything under `cequre/_generated/` is compiled from the DSL. Stick to `*.cequre` files in `cequre/schema/` and `cequre/server/app.ts` / `cequre/server/index.ts` for runtime logic.
- **Dev Workflow**: Run `cequre dev` to watch the DSL, regenerate types/server, and hot-reload the server. The dev server defaults to `cequre/server/index.ts`; pass `-e <path>` to override. Generated imports resolve from `../_generated/server`.
- **Runtime Files & Imports**: `cequre/server/app.ts` imports from `"cequre-ts"` (mapped locally via `tsconfig.json` paths to `./cequre/_generated/runtime/index.js`) and initializes the server with `createCequre({ adapter, ... })`. `cequre/server/index.ts` registers custom routes and calls `app.start()`.
- **Real-time Capabilities**: In a `.cequre` collection you can enable real-time:
  ```cequre
  collection users {
    realtime: {
      ws: true;            // WebSockets
      sse: true;           // Server-Sent Events
      durableStream: true;  // Redis/Postgres stream log
    }
  }
  ```
- **Access Control & Hooks (Business Logic)**: Never put business logic in the DSL. Do it in the runtime (`cequre/server/app.ts` or a dedicated `cequre/server/access.ts`):
  - **Access**: `app.access("users", { read: (ctx) => ctx.user?.role === "admin", create: (ctx) => ctx.user !== null });`
  - **Hooks**: `app.hooks.beforeCreate("users", async (ctx) => { /* logic */ });`
  - **Custom Endpoints**: `app.router.get("/custom", () => "Hello World");`
- **Plugins**: Add global middleware or override core framework behaviour (storage providers, security, monitoring, admin UI) via the plugin system: `plugins: [defaultSecurity(), defaultMonitoring(), adminUi()]` in the `createCequre(...)` call.
- **Database Sync**: Run `cequre db:sync` to apply schema changes. Use `--force` to drop orphaned tables/columns. Schema is source-of-truth — there are no file-based migrations.
- **Never commit secrets**: `.env` and `cequre/_generated/` are gitignored. Keep it that way.

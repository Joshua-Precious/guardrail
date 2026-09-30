---
name: cequre
description: Expert AI agent guidance for building backends with Cequre. Covers declarative .cequre DSL schemas, modular directory architecture, TypeScript lifecycle hooks, access control rules, and native Cequre MCP tools.
---

# Cequre Backend Architecture & Agent Guidelines

You are developing on a Cequre backend application. Always follow these rules and architectural standards.

## 1. Modular Directory Layout

Every Cequre project enforces a clean, modular folder layout. Never dump multiple collections into a single file or write flat code at the root.

### Standard Starter Layout
```text
cequre/
├── config.cequre             # STRICTLY system config (config { ... }) only. NO collections here!
├── collections/              # Exactly 1 .cequre file per collection (access rules live in DSL)
│   ├── users.cequre
│   ├── posts.cequre
│   └── <collection>.cequre
├── routes/                   # Custom REST / WebSocket endpoints
│   ├── index.ts              # Exports and registers custom routes on routesModule
│   └── <route>.ts
└── index.ts                  # Clean root bootstrap importing from ./routes
```

### On-Demand Extension Directories (Create ONLY when needed)
Do NOT scaffold or create these folders unless custom TypeScript runtime logic is explicitly needed:
```text
cequre/
├── hooks/                    # Lifecycle hooks in TypeScript (only when custom logic needed)
│   ├── index.ts              # Exports and registers hooks on hooksModule
│   └── <collection>.ts       # Export default { beforeCreate, afterCreate, ... }
├── access/                   # Custom access policies in TypeScript (only if DSL cannot handle rule)
│   ├── index.ts              # Exports and registers access rules on accessModule
│   └── <collection>.ts
└── utilities/                # Reusable helper functions
    └── index.ts
```

## 2. Core Architectural Rules

1. **`config.cequre` is for `config { ... }` only**:
   Never append `collection <name> { ... }` into `config.cequre`. Every collection must have its own dedicated file in `cequre/collections/<name>.cequre`.
2. **Access Rules Belong in the DSL First**:
   Always declare access control directly in the `.cequre` file inside the `access: { ... }` block. Only use `cequre/access/` if a complex programmatic rule cannot be expressed in DSL expressions.
3. **Lifecycle hooks are NEVER written in the DSL**:
   Never write `hooks: { ... }` inside a `.cequre` file. The compiler rejects this. When custom hooks (`beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`) are needed, they are written in `cequre/hooks/<slug>.ts` and registered via `cequre/hooks/index.ts`.
4. **Root Bootstrap (`cequre/index.ts`)**:
   The root `cequre/index.ts` connects `routesModule` by default. Only chain `hooksModule` or `accessModule` if custom extension files were created:
   ```typescript
   import { createCequre } from "./_generated/server";
   import { SQLiteAdapter, defaultSecurity } from "cequre-ts";
   import { routesModule } from "./routes";

   export const app = createCequre({
     adapter: new SQLiteAdapter(...),
     plugins: [defaultSecurity()],
   })
     .use(routesModule);

   app.start({ port: Number(process.env.PORT) || 3000 }).catch(console.error);
   ```
5. **Access Rules & Registration Inheritance**:
   - `create: true;` automatically allows user self-registration (`register`).
   - `create: false;` automatically blocks registration unless explicitly overridden with `register: true;`.
   - Setting `create: false; register: true;` allows public signup while blocking generic user creation.
   - Setting `create: true; register: false;` allows admins/services to create records while closing public signups.
   - User auth collections default to open registration if no access rules are specified (Convex/Supabase model).

## 3. Creating Collections (`cequre/collections/<name>.cequre`)

```cequre
collection posts {
  fields: {
    title: text @searchable;
    slug: text @unique;
    content: richtext;
    published: boolean @default(false);
    author: relationship("users");
  }

  access: {
    read: published == true || user.id == author || user.role == "admin";
    create: auth != null;
    update: user.id == author || user.role == "admin";
    delete: user.id == author || user.role == "admin";
  }

  realtime: {
    enabled: true;
    ws: true;
  }
}
```

## 4. Writing Lifecycle Hooks (`cequre/hooks/<name>.ts`)

```typescript
// cequre/hooks/posts.ts
import type { HookContext } from "../_generated/server";

export default {
  beforeCreate: async (ctx: HookContext) => {
    if (!ctx.data.author && ctx.user?.id) {
      ctx.data.author = ctx.user.id;
    }
  },
  afterCreate: async (ctx: HookContext) => {
    console.log(`Post created: ${ctx.result.id}`);
  },
};
```

And in `cequre/hooks/index.ts`:
```typescript
import { CequreModule } from "cequre-ts";
import type { Collections } from "../_generated/server";
import postsHooks from "./posts";

export const hooksModule = new CequreModule<Collections>();
hooksModule.hooks("posts", postsHooks as any);
```

## 5. Using Cequre MCP Tools

When Cequre MCP server is available, use the native tools:
- `cequre_collection_crud`: Create or modify collections (writes to `cequre/collections/<slug>.cequre`).
- `cequre_field_crud`: Add, update, or remove schema fields.
- `cequre_hooks_crud`: Create or manage lifecycle hooks in `cequre/hooks/<slug>.ts`.
- `cequre_custom_routes_crud`: Add custom endpoints to `cequre/routes/<slug>.ts`.
- `cequre_access_crud`: Set access permissions.
- `cequre_db_sync`: Synchronize schema changes with the database.
- `cequre_sdk`: Retrieve zero-dependency TypeScript client SDK.

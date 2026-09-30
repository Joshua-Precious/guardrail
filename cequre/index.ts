import { createCequre } from "./_generated/server";
import { PostgresAdapter, defaultSecurity, defaultMonitoring } from "cequre-ts";
import { routesModule } from "./routes";

export const app = createCequre({
  adapter: new PostgresAdapter(process.env.DATABASE_URL!),
  plugins: [defaultSecurity(), defaultMonitoring()]
})
  .use(routesModule);

app.start({ port: Number(process.env.PORT) || 3000 }).catch(console.error);

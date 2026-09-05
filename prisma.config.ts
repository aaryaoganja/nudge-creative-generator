import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 moved the connection URL out of schema.prisma. The schema no longer
 * accepts `datasource.url`; migration and introspection commands read it from
 * here instead, while the runtime client gets its connection through the
 * driver adapter in src/lib/db.ts.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});

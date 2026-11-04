import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

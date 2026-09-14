import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../../config/env.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";

const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
});

export const prisma = new PrismaClient({
    adapter,
});
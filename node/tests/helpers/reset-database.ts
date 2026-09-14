import { prisma } from "../../src/infrastructure/database/prisma.ts";
import { env } from "../../src/config/env.ts";

export async function resetDatabase() {
    if (env.NODE_ENV !== "test") {
        throw new Error(
            "Refusing to reset database outside test environment",
        );
    }

    if (!env.DATABASE_URL.includes("_test")) {
        throw new Error(
            "Refusing to reset a non-test database",
        );
    }

    await prisma.$executeRawUnsafe(`
        TRUNCATE table
            "platform_account",
            "vehicle",
            "route"
        RESTART IDENTITY CASCADE;
    `);
}

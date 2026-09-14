import { createApp } from "./app.ts"
import { env } from "./config/env.ts"
import { prisma } from "./infrastructure/database/prisma.ts"
import { logger } from "./config/logger.ts";

const app = createApp();

async function main() {

    // NOTE: prisma.$connect() doesn't trying to connect actually until query is executed
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    logger.info("Database Connected");
    const server = app.listen(env.PORT, () => {
        logger.info({
            port: env.PORT,
            environment: env.NODE_ENV,
        }, "HTTP Server started");
    });

    const dbUrl = new URL(env.DATABASE_URL);

    logger.info(
        {
            host: dbUrl.hostname,
            port: dbUrl.port,
            database: dbUrl.pathname,
        },
        "Database target",
    );

    let shuttingDown = false;

    async function closeHttpServer(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    async function shutdown(signal: string) {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info({ signal }, "Shutdown started")

        let hasError = false;

        // 1. Http server cleanup
        try {
            await closeHttpServer();
            logger.info("HTTP server closed")
        }
        catch (error) {
            hasError = true;
            logger.error({ err: error }, "Failed to close HTTP server");
        }

        // 2. Database cleanup
        try {
            await prisma.$disconnect();
            logger.info("Database disconnected");
        }
        catch (error) {
            hasError = true;
            logger.error({ err: error }, "Failed to disconnect database");

        }

        if (hasError) {
            logger.error("Shutdown completed with Errors")
            process.exitCode = 1;
        } else {
            logger.info("Shutdown completed successfully")
        }
    }
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });
}

main().catch(async (error) => {
    logger.fatal(error, "Failed to start application");

    try {
        await prisma.$disconnect();
    } catch (disconnectError) {
        logger.error(
            { err: disconnectError },
            "Failed to disconnect database",
        );
    }
    process.exit(1);
});
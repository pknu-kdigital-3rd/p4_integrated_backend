import express from "express";
import { logger } from "./config/logger.ts";
import { prisma } from "./infrastructure/database/prisma.ts";
import { vehicleRouter } from "./modules/vehicle/vehicle.router.ts";

import {
	errorHandler,
	notFoundHandler
} from "./common/errors/error-handler.ts";
import { pinoHttp } from "pino-http";

import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./docs/openapi.ts";
import { authRouter } from "./modules/auth/auth.router.ts";
import { bootstrapRouter } from "./modules/bootstrap/bootstrap.router.ts";
import { trackingRouter } from "./modules/tracking/tracking.router.ts";
import { tripRouter } from "./modules/trip/trip.router.ts";
import { demoRouter } from "./modules/demo/demo.router.ts";
import { internalRecordingRouter, recordingRouter } from "./modules/recording/recording.router.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.ts";

export function createApp() {
	const app = express();
	app.set("trust proxy", env.TRUST_PROXY);
	app.use(
		pinoHttp({
			logger,
		}),
	);

	app.set("json replacer", (_key: string, value: unknown) => {
		if (typeof value === "bigint") {
			return value.toString();
		}
		return value;
	});

	app.use(express.json({ limit: "1mb" }));

	app.get("/health/live", (_req, res) => {
		res.json({
			status: "ok",
		});
	});

	app.get("/health/ready", async (_req, res) => {
		await prisma.$queryRaw`SELECT 1`;
		res.json({
			status: "ready",
			database: "ok",
		});
	});

	app.use("/api/v1/vehicles", vehicleRouter);
	app.use("/api/v1/auth", authRouter);
	app.use("/api/v1/bootstrap", bootstrapRouter);
	app.use("/api/v1/tracking", trackingRouter);
	app.use("/api/v1/trips", tripRouter);
	app.use("/api/v1/demo", demoRouter);
	app.use("/internal/recordings", internalRecordingRouter);
	app.use("/api/v1", recordingRouter);

	const operatorWeb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../operator-web");
	app.use("/operator", express.static(operatorWeb));

	app.get("/openapi.json", (_req, res) => {
		res.json(openApiDocument);
	});

	app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

	// Must come after all routes.
	app.use(notFoundHandler);

	// Must be last.
	app.use(errorHandler);

	return app;
}

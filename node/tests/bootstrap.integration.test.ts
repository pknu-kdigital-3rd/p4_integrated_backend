import request from "supertest";
import {
    beforeEach,
    describe,
    expect,
    it,
} from "vitest";

import { createApp } from "../src/app.ts";
import { prisma } from "../src/infrastructure/database/prisma.ts";
import { hashPassword } from "../src/common/auth/password.ts";
import { resetDatabase } from "./helpers/reset-database.ts";
import { env } from "../src/config/env.ts";

const app = createApp();

beforeEach(async () => {
    await resetDatabase();

    const passwordHash = await hashPassword(
        "test-password",
    );

    await prisma.platformAccount.create({
        data: {
            loginId: "admin",
            passwordHash,
            userName: "Test Admin",
            role: "ADMIN",
            isActive: true,
        },
    });
});

async function login(): Promise<string> {
    const response = await request(app)
        .post("/api/v1/auth/login")
        .send({
            loginId: "admin",
            password: "test-password",
        })
        .expect(200);

    return response.body.data.accessToken;
}

describe("GET /api/v1/bootstrap", () => {
    it("returns 401 without authentication", async () => {
        const response = await request(app)
            .get("/api/v1/bootstrap");

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe(
            "AUTHENTICATION_REQUIRED",
        );
    });

    it("returns service discovery for an authenticated user", async () => {
        const token = await login();

        const response = await request(app)
            .get("/api/v1/bootstrap")
            .set(
                "Authorization",
                `Bearer ${token}`,
            );

        expect(response.status).toBe(200);

        expect(response.body.data).toEqual({
            services: {
                vision: {
                    baseUrl:
                        env.VISION_PUBLIC_BASE_URL,
                },
                routingTracking: {
                    baseUrl:
                        env.ROUTING_TRACKING_BASE_URL,
                },
            },
            liveViewUrl:
                env.LIVE_VIEW_URL ?? env.VISION_PUBLIC_BASE_URL,
        });
        expect(new URL(response.body.data.liveViewUrl).protocol)
            .toBe("https:");
    });
});

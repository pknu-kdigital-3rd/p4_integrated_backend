import request from "supertest";
import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
} from "vitest";

import { createApp } from "../src/app.ts";
import { prisma } from "../src/infrastructure/database/prisma.ts";
import { hashPassword } from "../src/common/auth/password.ts";
import { resetDatabase } from "./helpers/reset-database.ts";

const app = createApp();

beforeEach(async () => {
    await resetDatabase();

    const passwordHash = await hashPassword(
        "test-password",
    );

    await prisma.platformAccount.createMany({
        data: [
            {
                loginId: "admin",
                passwordHash,
                userName: "Test Admin",
                role: "ADMIN",
                isActive: true,
            },
            {
                loginId: "operator",
                passwordHash,
                userName: "Test Operator",
                role: "OPERATOR",
                isActive: true,
            },
            {
                loginId: "viewer",
                passwordHash,
                userName: "Test Viewer",
                role: "VIEWER",
                isActive: true,
            },
            {
                loginId: "inactive",
                passwordHash,
                userName: "Inactive User",
                role: "VIEWER",
                isActive: false,
            },
        ],
    });
});

afterAll(async () => {
    await prisma.$disconnect();
});

describe("POST /api/v1/auth/login", () => {
    it("returns an access token for valid credentials", async () => {
        const response = await request(app)
            .post("/api/v1/auth/login")
            .send({
                loginId: "admin",
                password: "test-password",
            });
        expect(response.status).toBe(200);

        expect(response.body.data.accessToken).toEqual(expect.any(String));

        expect(response.body.data.user).toEqual({
            userId: expect.any(String),
            loginId: "admin",
            userName: "Test Admin",
            role: "ADMIN",
        });
    });

    // Test wrong password
    it("returns 401 for an incorrect password", async () => {
        const response = await request(app)
            .post("/api/v1/auth/login")
            .send({
                loginId: "admin",
                password: "wrong-password",
            });

        expect(response.status).toBe(401);

        expect(response.body).toEqual({
            error: {
                code: "INVALID_CREDENTIALS",
                message: "Invalid login credentials",
            },
        });
    });

    // Test unknown User
    it("returns 401 for an unknown loginId", async () => {
        const response = await request(app)
            .post("/api/v1/auth/login")
            .send({
                loginId: "does-not-exist",
                password: "test-password",
            });

        expect(response.status).toBe(401);

        expect(response.body.error.code).toBe(
            "INVALID_CREDENTIALS",
        );
    });

    // Test inactive user
    it("returns 403 for an inactive account", async () => {
        const response = await request(app)
            .post("/api/v1/auth/login")
            .send({
                loginId: "inactive",
                password: "test-password",
            });

        expect(response.status).toBe(403);

        expect(response.body.error.code).toBe(
            "USER_INACTIVE",
        );
    });

    // Test Invalid body
    it("returns 400 when loginId is missing", async () => {
        const response = await request(app)
            .post("/api/v1/auth/login")
            .send({
                password: "test-password",
            });

        expect(response.status).toBe(400);

        expect(response.body.error.code).toBe(
            "VALIDATION_ERROR",
        );
    });

});

// Test /auth/me
async function login(
    loginId: string,
    password = "test-password",
): Promise<string> {
    const response = await request(app)
        .post("/api/v1/auth/login")
        .send({
            loginId,
            password,
        });

    expect(response.status).toBe(200);

    return response.body.data.accessToken;
}

describe("GET /api/v1/auth/me", () => {
    it("returns the authenticated principal", async () => {
        const token = await login("admin");

        const response = await request(app)
            .get("/api/v1/auth/me")
            .set(
                "Authorization",
                `Bearer ${token}`,
            );

        expect(response.status).toBe(200);

        expect(response.body.data).toEqual({
            userId: expect.any(String),
            role: "ADMIN",
        });
    });
});

describe("JWT", () => {
    // No JWT
    it("returns 401 when Authorization is missing", async () => {
        const response = await request(app)
            .get("/api/v1/auth/me");

        expect(response.status).toBe(401);

        expect(response.body.error.code).toBe(
            "AUTHENTICATION_REQUIRED",
        );
    });

    // Garbage JWT
    it("returns 401 for an invalid access token", async () => {
        const response = await request(app)
            .get("/api/v1/auth/me")
            .set(
                "Authorization",
                "Bearer definitely-not-a-jwt",
            );

        expect(response.status).toBe(401);

        expect(response.body.error.code).toBe(
            "INVALID_ACCESS_TOKEN",
        );
    });
});


import request from "supertest";
import {
    beforeEach,
    beforeAll,
    afterAll,
    describe,
    expect,
    it,
} from "vitest";

import { createApp } from "../src/app.ts";
import { prisma } from "../src/infrastructure/database/prisma.ts";
import { hashPassword } from "../src/common/auth/password.ts";
import { resetDatabase } from "./helpers/reset-database.ts";


const app = createApp();
let adminToken = "";


describe("Vehicle API", () => {
    beforeEach(async () => {
        await resetDatabase();

        const passwordHash = await hashPassword("test-password");
        await prisma.platformAccount.create({
            data: {
                loginId: "vehicle-admin",
                passwordHash,
                userName: "Vehicle Admin",
                role: "ADMIN",
                isActive: true,
            },
        });

        const loginResponse = await request(app)
            .post("/api/v1/auth/login")
            .send({
                loginId: "vehicle-admin",
                password: "test-password",
            });

        expect(loginResponse.status).toBe(200);
        adminToken = loginResponse.body.data.accessToken;
    });

    beforeAll(async () => {
        await prisma.$queryRaw`SELECT 1`;
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it("returns the vehicle list", async () => {
        const response = await request(app)
            .get("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .expect(200);

        expect(response.body).toHaveProperty("data");
        expect(Array.isArray(response.body.data)).toBe(true);
    });

    it("creates a vehicle", async () => {
        const response = await request(app)
            .post("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleCode: "TEST-VEHICLE-001",
                vehicleStatus: "READY",
            })
            .expect(201);

        expect(response.body.data.vehicleCode)
            .toBe("TEST-VEHICLE-001");
        expect(response.body.data.vehicleSource)
            .toBe("CUSTOM");

        // important: BIGINT leaves the REST API as a string.
        expect(typeof response.body.data.vehicleId)
            .toBe("string");
    });

    it("returns 409 for duplicate vehicleCode", async () => {
        await request(app)
            .post("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleCode: "TEST-DUPLICATE",
                vehicleStatus: "READY",
            })
            .expect(201);

        const response = await request(app)
            .post("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleCode: "TEST-DUPLICATE",
                vehicleStatus: "READY",
            })
            .expect(409);

        expect(response.body.error.code)
            .toBe("RESOURCE_ALREADY_EXISTS");
    });

    it("updates part of a vehicle", async () => {
        const created = await request(app)
            .post("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleCode: "TEST-PATCH",
                vehicleStatus: "READY",
            })
            .expect(201);

        const vehicleId =
            created.body.data.vehicleId;

        await request(app)
            .patch(`/api/v1/vehicles/${vehicleId}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleStatus: "MAINTENANCE",
            })
            .expect(204);

        const response = await request(app)
            .get(`/api/v1/vehicles/${vehicleId}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .expect(200);

        expect(response.body.data.vehicleStatus)
            .toBe("MAINTENANCE");
    });

    it("deletes a vehicle", async () => {
        const created = await request(app)
            .post("/api/v1/vehicles")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                vehicleCode: "TEST-DELETE",
                vehicleStatus: "READY",
            })
            .expect(201);

        const vehicleId =
            created.body.data.vehicleId;

        await request(app)
            .delete(`/api/v1/vehicles/${vehicleId}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .expect(204);

        await request(app)
            .get(`/api/v1/vehicles/${vehicleId}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .expect(404);
    });
});


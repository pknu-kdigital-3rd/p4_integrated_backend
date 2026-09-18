import { afterEach, describe, expect, it } from "vitest";

import { signAccessToken, verifyAccessToken } from "../src/common/auth/jwt.ts";
import { env } from "../src/config/env.ts";

const configuredTtl = env.JWT_ACCESS_TOKEN_TTL;

afterEach(() => {
    env.JWT_ACCESS_TOKEN_TTL = configuredTtl;
});

function decodePayload(token: string): Record<string, unknown> {
    return JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
}

describe("access token expiry", () => {
    it("omits expiration and verifies tokens when TTL is never", async () => {
        env.JWT_ACCESS_TOKEN_TTL = "never";

        const token = await signAccessToken({
            userId: "no-expiry-test-user",
            role: "ADMIN",
        });

        expect(decodePayload(token).exp).toBeUndefined();
        await expect(verifyAccessToken(token)).resolves.toEqual({
            userId: "no-expiry-test-user",
            role: "ADMIN",
        });
    });

    it("continues to apply configured duration TTLs", async () => {
        env.JWT_ACCESS_TOKEN_TTL = "15m";

        const token = await signAccessToken({
            userId: "expiring-test-user",
            role: "ADMIN",
        });
        const payload = decodePayload(token);

        expect(payload.exp).toBeTypeOf("number");
        expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);
    });
});

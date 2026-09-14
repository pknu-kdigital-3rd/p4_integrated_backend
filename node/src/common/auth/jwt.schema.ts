import { z } from "zod";

export const userRoleSchema = z.enum([
    "ADMIN",
    "OPERATOR",
    "VIEWER",
]);

export const accessTokenPayloadSchema = z.object({
    sub: z.string(),
    role: userRoleSchema,
    iss: z.string(),
    aud: z.union([
        z.string(),
        z.array(z.string()),
    ]),
    iat: z.number(),
    exp: z.number(),
});

export type AccessTokenPayload =
    z.infer<typeof accessTokenPayloadSchema>;

export type UserRole =
    z.infer<typeof userRoleSchema>;

export interface AuthPrincipal {
    userId: string;
    role: UserRole;
}
import { z } from "zod";
import { userRoleSchema } from "../../common/auth/jwt.schema";

export const loginBodySchema = z.object({
    loginId: z
        .string()
        .trim()
        .min(1, "loginId is required")
        .max(100),

    password: z
        .string()
        .min(1, "password is required")
        .max(200),
});

export type LoginBody = z.infer<
    typeof loginBodySchema
>;

/* Response schemas */

export const authUserSchema = z.object({
    userId: z.string(),
    loginId: z.string(),
    userName: z.string(),
    role: userRoleSchema,
});

export const loginResponseSchema = z.object({
    data: z.object({
        accessToken: z.string(),
        user: authUserSchema,
    }),
});

export const meResponseSchema = z.object({
    data: z.object({
        userId: z.string(),
        role: userRoleSchema,
    }),
});
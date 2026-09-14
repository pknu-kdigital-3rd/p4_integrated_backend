import { AppError } from "../../common/errors/app-error.ts";
import { signAccessToken } from "../../common/auth/jwt.ts";
import { verifyPassword } from "../../common/auth/password.ts";
import { userRoleSchema } from "../../common/auth/jwt.schema.ts";

import { authoRepository } from "./auth.repository.ts";
import type { LoginBody } from "./auth.schema.ts";

export const authService = {
    async login(input: LoginBody) {
        const user = await authoRepository.findByLoginId(
            input.loginId
        );

        if (!user) {
            throw new AppError(
                401,
                "Invalid login credentials",
                "INVALID_CREDENTIALS",
            );
        }

        if (!user.isActive) {
            throw new AppError(
                403,
                "User account is not active",
                "USER_INACTIVE",
            );
        }

        const passwordValid = await verifyPassword(
            user.passwordHash,
            input.password,
        );

        if (!passwordValid) {
            throw new AppError(
                401,
                "Invalid login credentials",
                "INVALID_CREDENTIALS",
            );
        }

        const role = userRoleSchema.parse(
            user.role,
        );

        const accessToken = await signAccessToken({
            userId: user.userId.toString(),
            role,
        });

        return {
            accessToken,
            user: {
                userId: user.userId,
                loginId: user.loginId,
                userName: user.userName,
                role,
            },
        };
    },
}
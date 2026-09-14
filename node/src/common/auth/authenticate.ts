import type {
    NextFunction,
    Request,
    Response
} from "express";
import { AppError } from "../errors/app-error.ts";
import { verifyAccessToken } from "./jwt";


export async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
) {
    const authorization = req.header(
        "Authorization",
    );

    if (!authorization) {
        throw new AppError(
            401,
            "Authentication required",
            "AUTHENTICATION_REQUIRED",
        );
    }

    const [scheme, token] = authorization.split(" ");

    if (
        scheme !== "Bearer" ||
        !token
    ) {
        throw new AppError(
            401,
            "Invalid authorization header",
            "INVALIDE_AUTHORIZATION_HEADER",
        );
    }
    try {
        req.auth = await verifyAccessToken(token);
        next();
    } catch {
        throw new AppError(
            401,
            "Invalid or expired access token",
            "INVALID_ACCESS_TOKEN",
        );
    }
}
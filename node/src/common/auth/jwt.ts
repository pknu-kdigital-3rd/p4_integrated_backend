import { readFile } from "node:fs/promises";

import {
    SignJWT,
    importPKCS8,
    importSPKI,
    jwtVerify,
} from "jose";

import { env } from "../../config/env.ts";
import {
    accessTokenPayloadSchema,
    type AuthPrincipal,
    type UserRole,
} from "./jwt.schema.ts";

const JWT_ALGORITHM = "RS256";

const privateKeyPem = await readFile(
    env.JWT_PRIVATE_KEY_PATH,
    "utf-8",
);

const publicKeyPem = await readFile(
    env.JWT_PUBLIC_KEY_PATH,
    "utf-8",
);

const privateKey = await importPKCS8(
    privateKeyPem,
    JWT_ALGORITHM,
);

const publicKey = await importSPKI(
    publicKeyPem,
    JWT_ALGORITHM,
);

export interface SignAccessTokenInput {
    userId: string;
    role: UserRole;
}

export async function signAccessToken(
    input: SignAccessTokenInput,
): Promise<string> {
    return new SignJWT({
        role: input.role,
    })
        .setProtectedHeader({
            alg: JWT_ALGORITHM,
            kid: env.JWT_KEY_ID,
            typ: "JWT",
        })
        .setIssuer(env.JWT_ISSUER)
        .setAudience(env.JWT_AUDIENCE)
        .setSubject(input.userId)
        .setIssuedAt()
        .setExpirationTime(env.JWT_ACCESS_TOKEN_TTL)
        .sign(privateKey);
}

export async function verifyAccessToken(
    token: string,
): Promise<AuthPrincipal> {
    const { payload } = await jwtVerify(
        token,
        publicKey,
        {
            algorithms: [JWT_ALGORITHM],
            issuer: env.JWT_ISSUER,
            audience: env.JWT_AUDIENCE,
        },
    );
    const parsed = accessTokenPayloadSchema.parse(payload);
    return {
        userId: parsed.sub,
        role: parsed.role,
    };
}
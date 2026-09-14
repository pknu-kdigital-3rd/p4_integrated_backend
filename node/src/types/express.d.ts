import type { AuthPrincipal } from "../common/auth/jwt.schema.ts";

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPrincipal;
        }
    }
}

export { };
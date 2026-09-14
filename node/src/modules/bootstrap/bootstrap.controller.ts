import type {
    Request,
    Response,
} from "express";

import { bootstrapService } from "./bootstrap.service.ts";

export const bootstrapController = {
    getBootstrap(
        _req: Request,
        res: Response,
    ) {
        const result = bootstrapService.getBootstrap();

        res.status(200).json({
            data: result,
        });
    },
};
import { registry } from "../../docs/registry.ts";

import {
    createVehicleSchema,
    updateVehicleSchema,
    vehicleIdParamSchema,
} from "./vehicle.schema.ts";

import {
    vehicleDataResponseSchema,
    vehicleListResponseSchema,
} from "./vehicle.response.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";


const VehicleResponse = registry.register(
    "Vehicle",
    vehicleDataResponseSchema,
);

const VehicleListResponse = registry.register(
    "VehicleList",
    vehicleListResponseSchema,
);

const ApiError = registry.register(
    "ApiError",
    apiErrorSchema,
);


registry.registerPath({
    method: "get",
    path: "/api/v1/vehicles",
    tags: ["Vehicle"],
    summary: "Get all vehicles",

    responses: {
        200: {
            description: "Vehicle list",
            content: {
                "application/json": {
                    schema: VehicleListResponse,
                },
            },
        },
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/vehicles/{vehicleId}",
    tags: ["Vehicle"],
    summary: "Get all vehicles",

    request: {
        params: vehicleIdParamSchema,
    },

    responses: {
        200: {
            description: "Vehicle list",
            content: {
                "application/json": {
                    schema: VehicleResponse,
                },
            },
        },
        404: {
            description: "Vehicle not found",
            content: {
                "application/json": {
                    schema: ApiError,
                },
            },
        }
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/vehicles",
    tags: ["Vehicle"],
    summary: "Create a vehicle",

    request: {
        body: {
            content: {
                "application/json": {
                    schema: createVehicleSchema,
                },
            },
        },
    },

    responses: {
        201: {
            description: "Vehicle created",
            content: {
                "application/json": {
                    schema: VehicleResponse,
                },
            },
        },
        400: {
            description: "Invalid request body",
            content: {
                "application/json": {
                    schema: ApiError,
                },
            },
        },
        409: {
            description: "Vehicle already exists",
            content: {
                "application/json": {
                    schema: ApiError,
                },
            },
        },
    },
});

registry.registerPath({
    method: "patch",
    path: "/api/v1/vehicles/{vehicleId}",
    tags: ["Vehicle"],
    summary: "Update a vehicle",

    request: {
        params: vehicleIdParamSchema,
        body: {
            content: {
                "application/json": {
                    schema: updateVehicleSchema,
                },
            },
        },
    },

    responses: {
        204: {
            description: "Vehicle updated",
        },
        404: {
            description: "Vehicle not found",
        }
    }
});

registry.registerPath({
    method: "delete",
    path: "/api/v1/vehicles/{vehicleId}",
    tags: ["Vehicle"],
    summary: "Delete a vehicle",

    request: {
        params: vehicleIdParamSchema,
    },

    responses: {
        204: {
            description: "Vehicle deleted",
        },
        404: {
            description: "Vehicle not found",
        }
    }
});
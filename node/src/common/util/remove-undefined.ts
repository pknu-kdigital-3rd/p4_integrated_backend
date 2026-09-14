type WithoutUndefined<T extends object> = {
    [K in keyof T]?: Exclude<T[K], undefined>;
};

export function removeUndefined<T extends object>(
    value: T,
): WithoutUndefined<T> {
    return Object.fromEntries(
        Object.entries(value).filter(
            ([, fieldValue]) => fieldValue !== undefined,
        ),
    ) as WithoutUndefined<T>;
}
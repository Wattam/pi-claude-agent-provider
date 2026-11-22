export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

/** A promise with its resolver; `Promise.withResolvers` is not in the ES2023 library typings. */
export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(settle => {
        resolve = settle;
    });
    return { promise, resolve };
}

/**
 * Settles with `promise`, or with `onTimeout()` after `ms`, or rejects with the abort reason when `signal` aborts.
 * The timer and abort listener are always removed.
 */
export function deadline<T, F>(
    promise: Promise<T>,
    ms: number,
    onTimeout: () => F,
    signal?: AbortSignal,
): Promise<T | F> {
    return new Promise<T | F>((resolve, reject) => {
        if (signal?.aborted) {
            promise.catch(() => undefined);
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            cleanup();
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            cleanup();
            try {
                resolve(onTimeout());
            } catch (error) {
                reject(error);
            }
        }, ms);
        function cleanup(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
}

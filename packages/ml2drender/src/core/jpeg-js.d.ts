declare module 'jpeg-js' {
    export function decode(
        data: ArrayLike<number> | ArrayBufferLike,
        opts?: {
            useTArray?: boolean;
            formatAsRGBA?: boolean;
            colorTransform?: boolean;
            tolerantDecoding?: boolean;
            maxResolutionInMP?: number;
            maxMemoryUsageInMB?: number;
        },
    ): {width: number; height: number; data: Uint8Array};
}

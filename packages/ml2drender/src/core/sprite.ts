// Sprites (style `sprite`): JSON index + sheet image, `@2x` for pixel ratios above 1.
// Images of sprite `id` are registered as `id:name`, except for the `default` sprite.

import {Image, Texture} from './image.ts';

export interface StyleImage {
    image: Image;
    pixelRatio: number;
    sdf: boolean;
    /** The image with 1px wrapped padding, as packed for patterns. */
    pattern: Texture;
    /** The image with 1px transparent padding, as packed for icons. */
    icon: Texture;
    stretchX: [number, number][] | undefined;
    stretchY: [number, number][] | undefined;
    /** `[x1, y1, x2, y2]` in image pixels. */
    content: [number, number, number, number] | undefined;
    textFitWidth: string | undefined;
    textFitHeight: string | undefined;
}

interface Source {
    id: string;
    jsonUrl: string;
    pngUrl: string;
    /** `undefined` until provided, then `null` when missing or invalid. */
    json: any;
    png: Image | null | undefined;
}

/** `normalizeSpriteURL`: append `@2x` and the extension to the path, before any query. */
function spriteUrl(url: string, format: string, ext: string): string {
    const m = url.search(/[?#]/);
    const split = m < 0 ? url.length : m;
    return `${url.slice(0, split)}${format}${ext}${url.slice(split)}`;
}

const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export class Sprites {
    sources: Source[];
    images: Map<string, StyleImage> = new Map();

    constructor(sprite: unknown, pixelRatio: number) {
        const format = pixelRatio > 1 ? '@2x' : '';
        let list: [string, string][] = [];
        if (typeof sprite === 'string') {
            list = [['default', sprite]];
        } else if (Array.isArray(sprite)) {
            for (const s of sprite) {
                if (s && typeof s === 'object' && typeof s.id === 'string' && typeof s.url === 'string') list.push([s.id, s.url]);
            }
        }
        this.sources = list.map(([id, url]) => ({
            id,
            jsonUrl: spriteUrl(url, format, '.json'),
            pngUrl: spriteUrl(url, format, '.png'),
            json: undefined,
            png: undefined,
        }));
    }

    needs(): string[] {
        const out: string[] = [];
        for (const s of this.sources) {
            if (s.json === undefined) out.push(s.jsonUrl);
            if (s.png === undefined) out.push(s.pngUrl);
        }
        return out;
    }

    provide(url: string, bytes: Uint8Array | undefined): void {
        let changed = false;
        for (const s of this.sources) {
            if (s.json === undefined && s.jsonUrl === url) {
                s.json = null;
                if (bytes) {
                    try {
                        s.json = JSON.parse(utf8.decode(bytes));
                    } catch {
                        // Invalid JSON counts as missing.
                    }
                }
                changed = true;
            }
            if (s.png === undefined && s.pngUrl === url) {
                s.png = (bytes && Image.decode(bytes)) ?? null;
                changed = true;
            }
        }
        if (!changed) return;
        for (const s of this.sources) {
            const json = s.json;
            const sheet = s.png;
            if (json === undefined || json === null || !sheet) continue;
            if (typeof json !== 'object' || Array.isArray(json)) continue;
            for (const [name, e0] of Object.entries(json)) {
                const key = s.id === 'default' ? name : `${s.id}:${name}`;
                if (this.images.has(key)) continue;
                const e: any = e0 !== null && typeof e0 === 'object' && !Array.isArray(e0) ? e0 : {};
                // `as_u64`: only non-negative integers.
                const n = (k: string) => {
                    const v = e[k];
                    return Number.isInteger(v) && v >= 0 ? v : 0;
                };
                const image = sheet.subImage(n('x'), n('y'), n('width'), n('height'));
                if (image.w === 0 || image.h === 0) continue;
                const pattern = new Texture(image.withWrappedPadding(), false);
                const icon = new Texture(image.withPadding(), false);
                const ranges = (k: string): [number, number][] | undefined =>
                    Array.isArray(e[k])
                        ? e[k].map((r: unknown): [number, number] => (Array.isArray(r) ? [num(r[0]) ?? 0, num(r[1]) ?? 0] : [0, 0]))
                        : undefined;
                const c = e.content;
                const content = Array.isArray(c) && c.length === 4
                    ? [num(c[0]) ?? 0, num(c[1]) ?? 0, num(c[2]) ?? 0, num(c[3]) ?? 0] as [number, number, number, number]
                    : undefined;
                this.images.set(key, {
                    pixelRatio: num(e.pixelRatio) ?? 1,
                    sdf: typeof e.sdf === 'boolean' ? e.sdf : false,
                    image,
                    pattern,
                    icon,
                    stretchX: ranges('stretchX'),
                    stretchY: ranges('stretchY'),
                    content,
                    textFitWidth: typeof e.textFitWidth === 'string' ? e.textFitWidth : undefined,
                    textFitHeight: typeof e.textFitHeight === 'string' ? e.textFitHeight : undefined,
                });
            }
        }
    }
}

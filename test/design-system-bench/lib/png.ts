import { inflateSync } from "node:zlib";

export interface Image {
    width: number;
    height: number;
    rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(bytes: Buffer): Image {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
        throw new Error("Not a PNG.");
    }

    let width = 0;
    let height = 0;
    let depth = 0;
    let type = 0;
    let interlace = 0;
    const parts: Buffer[] = [];

    for (let at = 8; at + 8 <= bytes.length;) {
        const length = bytes.readUInt32BE(at);
        const name = bytes.toString("latin1", at + 4, at + 8);
        const data = bytes.subarray(at + 8, at + 8 + length);

        if (name === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8]!;
            type = data[9]!;
            interlace = data[12]!;
        } else if (name === "IDAT") {
            parts.push(data);
        } else if (name === "IEND") {
            break;
        }

        at += 12 + length;
    }

    const channels = type === 6 ? 4 : type === 2 ? 3 : type === 0 ? 1 : type === 4 ? 2 : 0;

    if (
        depth !== 8 ||
        interlace !== 0 ||
        channels === 0 ||
        width === 0 ||
        height === 0 ||
        width * height > 64_000_000
    ) {
        throw new Error(
            `Unsupported PNG (depth ${depth}, color type ${type}, interlace ${interlace}).`,
        );
    }

    const raw = inflateSync(Buffer.concat(parts));
    const stride = width * channels;

    if (raw.length < (stride + 1) * height) {
        throw new Error("The PNG data is short.");
    }

    const rows = new Uint8Array(stride * height);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        const line = y * stride;
        const source = y * (stride + 1) + 1;

        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? rows[line + x - channels]! : 0;
            const up = y > 0 ? rows[line - stride + x]! : 0;
            const upLeft = y > 0 && x >= channels ? rows[line - stride + x - channels]! : 0;
            const value = raw[source + x]!;
            let out: number;

            switch (filter) {
                case 0:
                    out = value;
                    break;
                case 1:
                    out = value + left;
                    break;
                case 2:
                    out = value + up;
                    break;
                case 3:
                    out = value + ((left + up) >> 1);
                    break;

                case 4: {
                    const estimate = left + up - upLeft;
                    const [a, b, c] = [
                        Math.abs(estimate - left),
                        Math.abs(estimate - up),
                        Math.abs(estimate - upLeft),
                    ];

                    out = value + (a <= b && a <= c ? left : b <= c ? up : upLeft);
                    break;
                }

                default:
                    throw new Error(`Bad PNG filter ${filter}.`);
            }

            rows[line + x] = out & 255;
        }
    }

    const rgba = new Uint8Array(width * height * 4);

    for (let pixel = 0; pixel < width * height; pixel++) {
        const from = pixel * channels;
        const to = pixel * 4;

        if (channels >= 3) {
            rgba.set(
                [
                    rows[from]!,
                    rows[from + 1]!,
                    rows[from + 2]!,
                    channels === 4 ? rows[from + 3]! : 255,
                ],
                to,
            );
        } else {
            rgba.set(
                [rows[from]!, rows[from]!, rows[from]!, channels === 2 ? rows[from + 1]! : 255],
                to,
            );
        }
    }

    return { width, height, rgba };
}

export function distinctColors(image: Image, limit = 64): number {
    const seen = new Set<number>();

    for (let at = 0; at < image.rgba.length && seen.size < limit; at += 4) {
        seen.add(
            ((image.rgba[at]! << 24) |
                (image.rgba[at + 1]! << 16) |
                (image.rgba[at + 2]! << 8) |
                image.rgba[at + 3]!) >>>
                0,
        );
    }

    return seen.size;
}

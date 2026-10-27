/** Temporary ZIP adapter. Integration replaces ./zip.ts imports with Stream A's ../zip.ts. */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) {
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }

    return value >>> 0;
});

function crc32(bytes: Buffer): number {
    let value = 0xffffffff;

    for (const byte of bytes) {
        value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]!;
    }

    return (value ^ 0xffffffff) >>> 0;
}

/** Write a deterministic, UTF-8, deflated ZIP32 archive without dependencies. */
export function zip(entries: { name: string; bytes: Buffer }[]): Buffer {
    if (entries.length > 0xffff) {
        throw new Error("Too many ZIP entries.");
    }

    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    let centralSize = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const compressed = deflateRawSync(entry.bytes);
        const crc = crc32(entry.bytes);

        if (name.length > 0xffff || entry.bytes.length > 0xffffffff) {
            throw new Error("ZIP entry exceeds ZIP32 limits.");
        }

        const header = Buffer.alloc(30);

        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(8, 8);
        header.writeUInt16LE(33, 12); // 1980-01-01, no variable timestamps.
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(entry.bytes.length, 22);
        header.writeUInt16LE(name.length, 26);

        const record = Buffer.alloc(46);

        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);
        header.copy(record, 6, 4, 30);
        record.writeUInt32LE(offset, 42);
        local.push(header, name, compressed);
        central.push(record, name);
        offset += header.length + name.length + compressed.length;
        centralSize += record.length + name.length;

        if (offset + centralSize > 0xffffffff) {
            throw new Error("ZIP archive exceeds ZIP32 limits.");
        }
    }

    const end = Buffer.alloc(22);

    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...local, ...central, end]);
}

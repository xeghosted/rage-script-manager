// editor/src/protocol.ts
// The wire format, mirrored from src/net/frame.h. Both sides are asserted
// against tests/protocol_vectors.json.

export const HEADER_SIZE = 12;
export const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAGIC = Buffer.from('GLUA', 'ascii');

export enum Op {
    Hello = 1, Ping = 2, Pong = 3,
    Put = 4, Get = 5, Ls = 6, Rm = 7,
    Exec = 8, Reload = 9,
    Log = 10, Event = 11,
    Ok = 12, Err = 13, Busy = 14,
    Start = 15, Stop = 16, Restart = 17, ResList = 18, ResInfo = 19, Cmd = 20,
}

export interface Header { op: number; flags: number; seq: number; len: number; }

export function encodeHeader(h: Header): Buffer {
    const b = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(b, 0);
    b.writeUInt8(h.op, 4);
    b.writeUInt8(h.flags, 5);
    b.writeUInt16LE(h.seq, 6);
    b.writeUInt32LE(h.len, 8);
    return b;
}

export function decodeHeader(b: Buffer): Header | null {
    if (b.length < HEADER_SIZE) { return null; }
    if (b.compare(MAGIC, 0, 4, 0, 4) !== 0) { return null; }
    const len = b.readUInt32LE(8);
    if (len > MAX_PAYLOAD) { return null; }
    return { op: b.readUInt8(4), flags: b.readUInt8(5), seq: b.readUInt16LE(6), len };
}

export function encodeFrame(op: Op, seq: number, payload?: Buffer): Buffer {
    const body = payload ?? Buffer.alloc(0);
    return Buffer.concat([encodeHeader({ op, flags: 0, seq, len: body.length }), body]);
}

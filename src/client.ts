// editor/src/client.ts
// One TCP connection to the console, with request/reply correlation by seq and
// unsolicited LOG/EVENT frames surfaced as events.

import * as net from 'net';
import { EventEmitter } from 'events';
import { Op, HEADER_SIZE, decodeHeader, encodeFrame } from './protocol';

export interface Reply { op: number; payload: Buffer; }

export class Client extends EventEmitter {
    private sock: net.Socket | null = null;
    private buf = Buffer.alloc(0);
    // Seeded randomly (1..65535, never 0 — that value marks unsolicited
    // frames) rather than always starting at 1. The server has a known,
    // accepted, narrow race: if the game thread is mid-dispatch holding a
    // request when the connection tears down, the reply it produces after
    // teardown can be stamped with the *next* connection's identity and
    // delivered there instead. That's harmless as long as seq numbers can't
    // collide across sessions — but if every client started at 1, a stale
    // seq=1 reply from a previous session could resolve this session's first
    // request with someone else's answer, silently: a plausible, wrong
    // result for a question this client really did ask, with nothing to
    // flag the mismatch. Randomising the seed makes that collision
    // vanishingly unlikely without having to plumb a connection generation
    // through every server-side handler.
    private seq = 1 + Math.floor(Math.random() * 0xffff);
    private pending = new Map<number, (r: Reply) => void>();
    private keepalive: NodeJS.Timeout | null = null;

    // The plugin closes a connection after 30 s with no traffic in EITHER
    // direction (IDLE_US in src/net/net_server.cpp). Nothing in this client
    // used to send anything while idle, so a session survived only as long as
    // scripts happened to emit log lines -- which is why it dropped after
    // roughly a minute, unpredictably, and always looked like a network fault
    // rather than a timeout. 10 s means two pings can be lost before the
    // server's window closes.
    constructor(private readonly keepaliveMs = 10_000) { super(); }

    get connected(): boolean { return this.sock !== null; }

    connect(host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const s = new net.Socket();
            s.setNoDelay(true);
            s.once('error', (e) => { this.teardown(); reject(e); });
            s.connect(port, host, () => {
                this.sock = s;
                s.on('data', (d) => this.onData(d));
                s.on('close', () => { this.teardown(); this.emit('state', false); });
                s.on('error', () => { /* surfaced via close */ });
                this.startKeepalive();
                this.emit('state', true);
                resolve();
            });
        });
    }

    disconnect(): void {
        this.sock?.destroy();
        this.teardown();
    }

    private startKeepalive(): void {
        this.keepalive = setInterval(() => {
            if (!this.sock) { return; }
            // Fire and forget: request() deletes its own pending entry on
            // timeout, so a lost PONG leaks nothing. A genuinely dead socket
            // already surfaces through 'close', so a failed ping is not
            // treated as fatal here -- tearing the session down on one missed
            // reply would reintroduce the disconnect this exists to prevent.
            this.request(Op.Ping, undefined, this.keepaliveMs).catch(() => { /* see above */ });
        }, this.keepaliveMs);
        // Never let a stray interval hold the extension host open.
        this.keepalive.unref?.();
    }

    private teardown(): void {
        if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
        this.sock = null;
        this.buf = Buffer.alloc(0);
        for (const [, resolve] of this.pending) {
            resolve({ op: Op.Err, payload: Buffer.from('disconnected') });
        }
        this.pending.clear();
    }

    request(op: Op, payload?: Buffer, timeoutMs = 5000): Promise<Reply> {
        if (!this.sock) { return Promise.reject(new Error('not connected')); }
        const seq = this.seq;
        this.seq = this.seq >= 0xffff ? 1 : this.seq + 1;
        this.sock.write(encodeFrame(op, seq, payload));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`timed out waiting for reply to seq ${seq}`));
            }, timeoutMs);
            this.pending.set(seq, (r) => { clearTimeout(timer); resolve(r); });
        });
    }

    private onData(chunk: Buffer): void {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            if (this.buf.length < HEADER_SIZE) { return; }
            const h = decodeHeader(this.buf);
            if (!h) {
                // Not our stream any more; the plugin closes on its side too.
                this.emit('log', '[rage] malformed frame from console, disconnecting');
                this.disconnect();
                return;
            }
            if (this.buf.length < HEADER_SIZE + h.len) { return; }
            const payload = this.buf.subarray(HEADER_SIZE, HEADER_SIZE + h.len);
            this.buf = this.buf.subarray(HEADER_SIZE + h.len);

            if (h.seq === 0) {
                if (h.op === Op.Log) { this.emit('log', payload.toString('utf8')); }
                else if (h.op === Op.Event) { this.emit('event', payload.toString('utf8')); }
            } else {
                const waiter = this.pending.get(h.seq);
                if (waiter) { this.pending.delete(h.seq); waiter({ op: h.op, payload: Buffer.from(payload) }); }
            }
        }
    }
}

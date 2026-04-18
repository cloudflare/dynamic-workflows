/**
 * Log streaming for dynamically-loaded tenant workers.
 *
 * A Tail Worker ({@link DynamicWorkerTail}) is attached to every tenant
 * worker we load. Whenever the tenant emits a `console.log()` (or throws an
 * exception), the runtime invokes `tail()` with the events. We forward those
 * events into a per-run {@link LogSession} Durable Object, which fans them
 * out to any connected SSE subscribers.
 *
 * Flow:
 *
 *   tenant worker ──console.log()──▶ runtime ──▶ DynamicWorkerTail.tail()
 *                                                        │
 *                                                        ▼ (RPC)
 *                                              LogSession.push(entries)
 *                                                        │
 *                                                        ▼ (RPC back to each)
 *                                              subscriber.push(entry)
 *                                                        │
 *                                                        ▼
 *                                      worker's local TransformStream → SSE
 */

import {
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
  exports as workersExports,
} from 'cloudflare:workers';

/**
 * One log entry streamed to the UI.
 *
 * `kind` is:
 *   - `"log"` for `console.log/warn/error/info/debug` output from the tenant
 *   - `"exception"` for unhandled exceptions
 */
export interface LogEntry {
  kind: 'log' | 'exception';
  level: string;
  message: string;
  timestamp: number;
}

/**
 * RPC-facing subscriber contract. The HTTP handler creates one of these per
 * open SSE connection and registers it with the `LogSession` DO. The DO
 * then calls `push()` / `done()` on it as tail events arrive.
 */
export type LogSubscriber = {
  push(entries: LogEntry[]): Promise<void>;
  done(): Promise<void>;
};

/**
 * `cloudflare:workers` `exports` shape after this module is imported. The
 * DO class is registered purely via the `migrations` entry in
 * `wrangler.jsonc` — no `durable_objects.bindings` needed — and accessed
 * through `exports.LogSession.getByName(...)`.
 */
interface WorkersExports {
  LogSession: {
    getByName(name: string): DurableObjectStub<LogSession>;
  };
}
/**
 * Look up the `LogSession` Durable Object stub for a given run id.
 *
 * Uses `cloudflare:workers` `exports` — the DO is registered via the
 * `migrations` entry in `wrangler.jsonc` and accessed by name, without a
 * `durable_objects.bindings` block.
 */
export function getLogSession(name: string): DurableObjectStub<LogSession> {
  return (workersExports as unknown as WorkersExports).LogSession.getByName(name);
}

function normaliseLogMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .join(' ');
  }
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/**
 * `LogSession` is a Durable Object keyed by a **run id** (the workflow
 * instance id). It keeps:
 *
 *   - A buffer of logs that arrived before any subscriber connected, so new
 *     SSE connections can catch up.
 *   - A set of RPC subscribers — one per open SSE connection.
 *   - The tenant source code, so a later workflow `run()` can re-load the
 *     exact same module if the isolate recycles.
 */
export class LogSession extends DurableObject {
  private buffer: LogEntry[] = [];
  private subscribers = new Set<LogSubscriber>();
  private closed = false;
  private source: string | undefined;

  async setSource(source: string): Promise<void> {
    this.source = source;
  }
  async getSource(): Promise<string | undefined> {
    return this.source;
  }

  /**
   * Append log entries. Called from {@link DynamicWorkerTail}. Also flushes
   * to every active subscriber.
   */
  async push(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.buffer.push(...entries);
    if (this.buffer.length > 500) this.buffer = this.buffer.slice(-500);
    const dead: LogSubscriber[] = [];
    for (const sub of this.subscribers) {
      try {
        await sub.push(entries);
      } catch {
        dead.push(sub);
      }
    }
    for (const sub of dead) this.subscribers.delete(sub);
  }

  /**
   * Mark the run as complete. Existing subscribers are told to close.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers) {
      try {
        await sub.done();
      } catch {
        // ignore
      }
    }
    this.subscribers.clear();
  }

  /**
   * Register a new subscriber. Replays the buffered history immediately,
   * then streams new entries as they arrive.
   *
   * Cap'n Web / Workers RPC disposes stubs received as parameters when the
   * call returns, so we explicitly `.dup()` the subscriber here to keep it
   * alive across future `push()` calls. See
   * https://github.com/cloudflare/capnweb/#automatic-disposal
   */
  async subscribe(subscriber: LogSubscriber): Promise<void> {
    const kept =
      (subscriber as LogSubscriber & { dup?: () => LogSubscriber }).dup?.() ?? subscriber;
    if (this.buffer.length > 0) {
      try {
        await kept.push([...this.buffer]);
      } catch {
        return; // subscriber already broken
      }
    }
    if (this.closed) {
      try {
        await kept.done();
      } catch {
        // ignore
      }
      return;
    }
    this.subscribers.add(kept);
  }
}

/**
 * Props attached to the Tail Worker so it knows which run it's logging for.
 */
export interface DynamicWorkerTailProps {
  runId: string;
}

/**
 * Streaming Tail Worker attached to every loaded tenant worker.
 *
 * Unlike the classic `tail()` handler which fires once at the end of an
 * invocation with a batch of `TraceItem[]`, `tailStream()` is called at the
 * start of the invocation and returns an object whose handlers fire in
 * real time as the producer worker emits events. That's what lets us push
 * each `console.log` line into the LogSession DO the instant it happens.
 *
 * Crucially, this also captures logs emitted inside workflow `run()`
 * invocations during local dev — the classic `tail()` misses those.
 */
export class DynamicWorkerTail extends WorkerEntrypoint<unknown, DynamicWorkerTailProps> {
  override tailStream(
    _event: TailStream.TailEvent<TailStream.Onset>
  ): TailStream.TailEventHandlerType {
    const runId = this.ctx.props.runId;
    const session = getLogSession(runId);

    return {
      log: async (ev) => {
        const data = ev.event;
        await session.push([
          {
            kind: 'log',
            level: data.level,
            message: normaliseLogMessage(data.message),
            timestamp: ev.timestamp.getTime(),
          },
        ]);
      },
      exception: async (ev) => {
        const data = ev.event;
        await session.push([
          {
            kind: 'exception',
            level: 'error',
            message: data.name ? `${data.name}: ${data.message}` : data.message,
            timestamp: ev.timestamp.getTime(),
          },
        ]);
      },
    };
  }
}

/**
 * Helper invoked by the dispatcher's HTTP handler. Builds a `Response`
 * whose body streams log entries from the given run in SSE format.
 *
 * The subscriber wrapper lives in this isolate (not the DO), so its
 * underlying `TransformStream` stays alive for the lifetime of the HTTP
 * response. We also hook it into `ctx.waitUntil` so the invocation doesn't
 * get torn down while the DO still holds an RPC stub pointing at it.
 */
export function streamLogsResponse(runId: string, ctx?: ExecutionContext): Response {
  const session = getLogSession(runId);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  async function writeSse(event: string, data: unknown): Promise<void> {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  class Subscriber extends RpcTarget implements LogSubscriber {
    async push(entries: LogEntry[]): Promise<void> {
      for (const entry of entries) {
        await writeSse('log', entry);
      }
    }
    async done(): Promise<void> {
      await writeSse('done', null);
      try {
        await writer.close();
      } catch {
        // ignore
      }
    }
  }

  // Write an initial comment so the HTTP layer flushes headers + starts
  // delivering the body immediately (otherwise some intermediaries buffer
  // until the first non-empty chunk).
  writer.write(encoder.encode(': connected\n\n')).catch(() => {});

  // Hand the subscriber to the DO via RPC. The DO will retain the stub and
  // call push()/done() on it as logs arrive.
  //
  // Keep an explicit local reference to the subscriber so its RPC stub
  // isn't released while the response body is still being streamed. Also
  // hook this lifetime into `ctx.waitUntil()` so the worker invocation
  // isn't torn down while the DO still holds a stub pointing at us.
  const subscriber = new Subscriber();
  let releaseAlive: () => void;
  const aliveUntil = new Promise<void>((resolve) => {
    releaseAlive = resolve;
  });
  ctx?.waitUntil(aliveUntil);

  (async () => {
    try {
      await session.subscribe(subscriber as unknown as LogSubscriber);
    } catch {
      // ignore
    }
  })();

  // When the consumer disconnects (write fails), release the keepalive so
  // waitUntil resolves and the invocation can finish.
  const originalWrite = writer.write.bind(writer);
  writer.write = (chunk) =>
    originalWrite(chunk).catch((err) => {
      releaseAlive();
      throw err;
    });

  // Heartbeat: emit a comment line every 15s so intermediaries don't time
  // out the connection before logs arrive.
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(': heartbeat\n\n')).catch(() => clearInterval(heartbeat));
  }, 15000);

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

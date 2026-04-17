import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  createDynamicWorkflowEntrypoint,
  type DispatcherMetadata,
  dispatchWorkflow,
  type LoadWorkflowRunner,
  MissingDispatcherMetadataError,
  type WorkflowEventLike,
  type WorkflowRunner,
  type WorkflowStepLike,
  wrapParams,
} from 'dynamic-workflows';
import { describe, expect, it, vi } from 'vitest';

function makeEvent<T>(payload: T): WorkflowEventLike<T> {
  return {
    payload,
    timestamp: new Date(0),
    instanceId: 'instance-1',
  };
}

const DUMMY_CTX = {} as ExecutionContext;

describe('dispatchWorkflow', () => {
  it('unwraps metadata from the event and passes it to the loader', async () => {
    const capturedMetadata: DispatcherMetadata[] = [];
    const loader: LoadWorkflowRunner<unknown, unknown, string> = async ({ metadata }) => {
      capturedMetadata.push(metadata);
      return { run: async () => 'ok' };
    };

    const result = await dispatchWorkflow(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams({ hello: 'world' }, { tenantId: 'tenant-a' })),
      {} as WorkflowStepLike,
      loader
    );

    expect(result).toBe('ok');
    expect(capturedMetadata).toEqual([{ tenantId: 'tenant-a' }]);
  });

  it('passes env and ctx through to the loader', async () => {
    type MyEnv = { greeting: string };
    let captured: { env: MyEnv; ctx: ExecutionContext } | null = null;

    const loader: LoadWorkflowRunner<MyEnv, unknown, string> = async ({ env, ctx }) => {
      captured = { env, ctx };
      return { run: async () => 'ok' };
    };

    const env: MyEnv = { greeting: 'hi' };
    await dispatchWorkflow(
      { env, ctx: DUMMY_CTX },
      makeEvent(wrapParams({}, { tenantId: 't1' })),
      {} as WorkflowStepLike,
      loader
    );

    expect(captured).not.toBeNull();
    expect(captured?.env).toEqual({ greeting: 'hi' });
    expect(captured?.ctx).toBe(DUMMY_CTX);
  });

  it('delivers the unwrapped params to the dynamic worker', async () => {
    const runner: WorkflowRunner<{ hello: string }, string> = {
      run: vi.fn(async (event) => `received ${event.payload.hello}`),
    };

    const result = await dispatchWorkflow<unknown, { hello: string }, string>(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams({ hello: 'world' }, { tenantId: 't1' })),
      {} as WorkflowStepLike,
      async () => runner
    );

    expect(result).toBe('received world');

    const runMock = runner.run as ReturnType<typeof vi.fn>;
    expect(runMock).toHaveBeenCalledTimes(1);
    const innerEvent = runMock.mock.calls[0]?.[0] as WorkflowEventLike<{ hello: string }>;
    expect(innerEvent.payload).toEqual({ hello: 'world' });
    expect(innerEvent.instanceId).toBe('instance-1');
    expect(innerEvent.timestamp).toEqual(new Date(0));
  });

  it('forwards the WorkflowStep object untouched', async () => {
    const step = { do: async () => undefined, sleep: async () => undefined };
    let receivedStep: unknown = null;

    await dispatchWorkflow(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams(null, { tenantId: 't1' })),
      step,
      async () => ({
        run: async (_event, s) => {
          receivedStep = s;
          return undefined;
        },
      })
    );

    expect(receivedStep).toBe(step);
  });

  it('throws MissingDispatcherMetadataError when the payload is not an envelope', async () => {
    await expect(
      dispatchWorkflow(
        { env: {}, ctx: DUMMY_CTX },
        makeEvent({ not: 'an envelope' }),
        {} as WorkflowStepLike,
        async () => ({ run: async () => undefined })
      )
    ).rejects.toBeInstanceOf(MissingDispatcherMetadataError);
  });

  it('throws MissingDispatcherMetadataError on null payload', async () => {
    await expect(
      dispatchWorkflow(
        { env: {}, ctx: DUMMY_CTX },
        makeEvent(null),
        {} as WorkflowStepLike,
        async () => ({ run: async () => undefined })
      )
    ).rejects.toBeInstanceOf(MissingDispatcherMetadataError);
  });

  it('supports synchronous loaders returning a runner directly', async () => {
    const runner: WorkflowRunner<unknown, number> = {
      run: async () => 42,
    };

    const result = await dispatchWorkflow<unknown, unknown, number>(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams('hello', { tenantId: 't1' })),
      {} as WorkflowStepLike,
      () => runner
    );

    expect(result).toBe(42);
  });

  it('propagates errors thrown by the loader', async () => {
    await expect(
      dispatchWorkflow(
        { env: {}, ctx: DUMMY_CTX },
        makeEvent(wrapParams({}, { tenantId: 't1' })),
        {} as WorkflowStepLike,
        async () => {
          throw new Error('loader failed');
        }
      )
    ).rejects.toThrow('loader failed');
  });

  it('propagates errors thrown by the dynamic worker run()', async () => {
    await expect(
      dispatchWorkflow(
        { env: {}, ctx: DUMMY_CTX },
        makeEvent(wrapParams({}, { tenantId: 't1' })),
        {} as WorkflowStepLike,
        async () => ({
          run: async () => {
            throw new Error('worker run failed');
          },
        })
      )
    ).rejects.toThrow('worker run failed');
  });

  it('invokes the loader fresh for every call', async () => {
    const loader: LoadWorkflowRunner<unknown, unknown, string> = vi.fn(async ({ metadata }) => ({
      run: async () => (metadata['tenantId'] as string) ?? 'none',
    }));

    const a = await dispatchWorkflow<unknown, unknown, string>(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams({}, { tenantId: 'tenant-a' })),
      {} as WorkflowStepLike,
      loader
    );
    const b = await dispatchWorkflow<unknown, unknown, string>(
      { env: {}, ctx: DUMMY_CTX },
      makeEvent(wrapParams({}, { tenantId: 'tenant-b' })),
      {} as WorkflowStepLike,
      loader
    );

    expect(a).toBe('tenant-a');
    expect(b).toBe('tenant-b');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('createDynamicWorkflowEntrypoint', () => {
  it('returns a class that extends WorkflowEntrypoint', () => {
    const Klass = createDynamicWorkflowEntrypoint(async () => ({
      run: async () => undefined,
    }));

    // Check prototype chain without instantiating — workerd's
    // WorkflowEntrypoint constructor is only callable from a real workflow
    // runtime, so we can't `new` it here.
    expect(Klass.prototype).toBeInstanceOf(WorkflowEntrypoint);
  });

  it('overrides the run method', () => {
    const Klass = createDynamicWorkflowEntrypoint(async () => ({
      run: async () => undefined,
    }));
    expect(typeof Klass.prototype.run).toBe('function');
    // The override must not be the base-class no-op; sanity-check by name.
    expect(Klass.prototype.run).not.toBe(WorkflowEntrypoint.prototype.run);
  });
});

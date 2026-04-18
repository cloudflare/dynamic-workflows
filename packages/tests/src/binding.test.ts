import { _dispatcherBindingImpl as dispatcherBindingImpl } from 'dynamic-workflows';
import { describe, expect, it, vi } from 'vitest';

/**
 * These tests exercise the binding-wrap envelope logic in isolation via
 * {@link dispatcherBindingImpl} (the plain-object implementation shared with
 * `DynamicWorkflowBinding`). The `WorkerEntrypoint` subclass itself can't be
 * instantiated outside of a real RPC call, and its `create`/`createBatch`/
 * `get` methods are thin delegates to this impl, so this gives the same
 * coverage without a workerd RPC harness.
 */
interface Envelope<T = unknown> {
  __dispatcherMetadata: Record<string, unknown>;
  params: T;
}

function makeFakeInstance(id: string): WorkflowInstance {
  return {
    id,
    status: async () => ({ status: 'queued' }) as any,
    pause: async () => {},
    resume: async () => {},
    terminate: async () => {},
    restart: async () => {},
    sendEvent: async () => {},
  };
}

function makeFakeBinding(): {
  binding: Workflow;
  create: ReturnType<typeof vi.fn>;
  createBatch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (opts?: WorkflowInstanceCreateOptions) =>
    makeFakeInstance(opts?.id ?? 'auto-id')
  );
  const createBatch = vi.fn(async (batch: WorkflowInstanceCreateOptions[]) =>
    batch.map((opts) => makeFakeInstance(opts.id ?? 'auto-id'))
  );
  const get = vi.fn(async (id: string) => makeFakeInstance(id));

  const binding: Workflow = { create, createBatch, get } as Workflow;
  return { binding, create, createBatch, get };
}

function wrap(binding: Workflow, metadata: Record<string, unknown>): Workflow {
  return dispatcherBindingImpl(() => binding, metadata);
}

describe('dispatcherBindingImpl (wrapWorkflowBinding envelope logic)', () => {
  it('injects metadata into create() params', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 'tenant-42' });

    await wrapped.create({ id: 'wf-1', params: { input: 'hello' } });

    expect(create).toHaveBeenCalledTimes(1);
    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptions;
    expect(calledWith.id).toBe('wf-1');
    const envelope = calledWith.params as Envelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 'tenant-42' });
    expect(envelope.params).toEqual({ input: 'hello' });
  });

  it('injects metadata when create() is called with no options', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    await wrapped.create();

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptions;
    const envelope = calledWith.params as Envelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    expect(envelope.params).toBeUndefined();
  });

  it('injects metadata when create() has no params', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    await wrapped.create({ id: 'wf-no-params' });

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptions;
    expect(calledWith.id).toBe('wf-no-params');
    const envelope = calledWith.params as Envelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    expect(envelope.params).toBeUndefined();
  });

  it('passes arbitrary metadata shapes', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrap(binding, {
      tenantId: 'acme',
      region: 'us-east',
      features: ['beta', 'pro'],
      nested: { version: 3 },
    });

    await wrapped.create({ params: { job: 'x' } });

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptions;
    const envelope = calledWith.params as Envelope;
    expect(envelope.__dispatcherMetadata).toEqual({
      tenantId: 'acme',
      region: 'us-east',
      features: ['beta', 'pro'],
      nested: { version: 3 },
    });
  });

  it('injects metadata into every item of createBatch()', async () => {
    const { binding, createBatch } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    const instances = await wrapped.createBatch([
      { id: 'a', params: { n: 1 } },
      { id: 'b', params: { n: 2 } },
      { id: 'c' },
    ]);

    expect(instances.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    const calledWith = createBatch.mock.calls[0]?.[0] as WorkflowInstanceCreateOptions[];
    expect(calledWith).toHaveLength(3);
    for (const opts of calledWith) {
      const envelope = opts.params as Envelope;
      expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    }
    expect((calledWith[0]?.params as Envelope).params).toEqual({ n: 1 });
    expect((calledWith[1]?.params as Envelope).params).toEqual({ n: 2 });
    expect((calledWith[2]?.params as Envelope).params).toBeUndefined();
  });

  it('forwards get() unchanged', async () => {
    const { binding, get } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    const instance = await wrapped.get('some-id');

    expect(get).toHaveBeenCalledWith('some-id');
    expect(instance.id).toBe('some-id');
  });

  it('returns instances unchanged from the underlying binding', async () => {
    const { binding, create } = makeFakeBinding();
    create.mockImplementationOnce(async () => ({
      ...makeFakeInstance('abc'),
      id: 'returned-id',
    }));

    const wrapped = wrap(binding, { tenantId: 't1' });
    const instance = await wrapped.create({ params: { a: 1 } });

    expect(instance.id).toBe('returned-id');
  });

  it('does not mutate the caller-provided options', async () => {
    const { binding } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    const options = { id: 'wf-1', params: { value: 42 } };
    await wrapped.create(options);

    // The caller's object should still have the original params reference.
    expect(options.params).toEqual({ value: 42 });
  });

  it('does not double-wrap if the same wrapped binding is used twice', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrap(binding, { tenantId: 't1' });

    await wrapped.create({ params: { a: 1 } });
    await wrapped.create({ params: { a: 2 } });

    for (const call of create.mock.calls) {
      const envelope = (call[0] as WorkflowInstanceCreateOptions).params as Envelope;
      expect('__dispatcherMetadata' in ((envelope.params as object) ?? {})).toBe(false);
    }
  });

  it('resolves the underlying binding lazily on every call', async () => {
    const { binding } = makeFakeBinding();
    let lookups = 0;
    const wrapped = dispatcherBindingImpl(
      () => {
        lookups++;
        return binding;
      },
      { tenantId: 't1' }
    );

    await wrapped.create();
    await wrapped.create();
    await wrapped.get('id');

    expect(lookups).toBe(3);
  });
});
